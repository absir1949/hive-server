/**
 * api — HTTP API 层
 *
 * 两类端点：
 *   - 旧接口 (navigate/execute/screenshot/cookies) — 默认操作主 tab，用于简单操作
 *     execute 支持 url_pattern：传入时只在匹配 tab 执行，避免误读当前 tab。
 *   - Page 接口 (/pages/new, /pages/:pageId/*) — 创建最小化后台窗口，不影响 VNC 操作
 *
 * 内部流程：ensureConnected(profileId) → 启容器 → 连 CDP → 执行操作
 * 调用者不需要关心容器生命周期。
 *
 * 生命周期：浏览器按需启动。登录态靠 cookie dump/restore，不再靠进程常驻。
 */

const VNC_LEASE_TTL_MS = parseInt(process.env.VNC_LEASE_TTL_MS, 10) || 2 * 60 * 1000; // default 2 min
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { BROWSER_MODES, normalizeBrowserMode, isVncMode } = require('./browserMode');
const AuthStore = require('./authStore');
const { detectLoginState } = require('./loginProbe');
const { maxRunningBrowsers, idleStopMs, pickEvictionVictim } = require('./sessionCapacity');

let cm; // ContainerManager
let bc; // BrowserConnector
let ps; // ProfileStore
let fe; // FingerprintEngine
let vnc; // VNC proxy/signing helper
let authStore; // AuthStore

// --- Proxy resolution ---

const PROXIES_FILE = require('path').resolve(__dirname, '..', 'config', 'proxies.json');

function resolveProxyUrl(proxyId) {
  if (!proxyId) return null;
  try {
    const { proxies } = JSON.parse(require('fs').readFileSync(PROXIES_FILE, 'utf8'));
    const proxy = proxies.find((p) => p.id === proxyId);
    if (!proxy || !proxy.isActive) return null;
    const auth = (proxy.username && proxy.password)
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : '';
    return `${proxy.type || 'http'}://${auth}${proxy.host}:${proxy.port}`;
  } catch {
    return null;
  }
}

// profileId → the mode requested for the current/next runtime session.
// This is intentionally ephemeral: the persistent Profile only owns data and
// identity, while the browser mode belongs to the active session.
const sessionModes = new Map();
// profileId → { leaseId, expiresAt, timer }
const vncLeases = new Map();
// Serialize lifecycle transitions for one Profile. This prevents a VNC open,
// release, and headless start request from racing over the same data directory.
const profileLocks = new Map();
const lastUsedAt = new Map();
const idleStopTimers = new Map();
const needsLogin = new Set();

function mount(app, deps) {
  cm = deps.cm;
  bc = deps.bc;
  ps = deps.ps;
  fe = deps.fe;
  vnc = deps.vnc;
  authStore = deps.authStore || new AuthStore();

  // Browser operations
  app.get('/browsers', listBrowsers);
  app.post('/browsers/:id/start', startBrowser);
  app.post('/browsers/:id/stop', stopBrowser);
  app.post('/browsers/:id/navigate', browserOp(navigate));
  app.post('/browsers/:id/execute', browserOp(execute));
  app.get('/browsers/:id/cookies', browserOp(getCookies));
  app.post('/browsers/:id/screenshot', browserOp(screenshot));
  app.get('/browsers/:id/vnc', getVncUrl);
  app.post('/browsers/:id/vnc/heartbeat', vncHeartbeat);
  app.post('/browsers/:id/vnc/release', releaseVnc);
  app.post('/browsers/:id/clipboard/paste', browserOp(pasteClipboard));
  app.post('/browsers/:id/clipboard/copy', browserOp(copyClipboard));
  app.post('/browsers/:id/upload-file', browserOp(uploadFile));

  // Background collection window operations
  app.post('/browsers/:id/pages/new', browserOp(newPage));
  app.post('/browsers/:id/pages/:pageId/close', browserOp(closePage));
  app.post('/browsers/:id/pages/:pageId/execute', browserOp(pageExecute));
  app.post('/browsers/:id/pages/:pageId/screenshot', browserOp(pageScreenshot));

  // Profile management
  app.post('/profiles', createProfile);
  app.get('/profiles', listProfiles);
  app.get('/profiles/:id', getProfile);
  app.put('/profiles/:id', updateProfile);
  app.delete('/profiles/:id', deleteProfile);

  // System
  app.get('/health', health);
}

// --- Error classification ---

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function errorPayload(apiErr) {
  const body = { ok: false, error: apiErr.message };
  if (apiErr.needsLogin) body.needsLogin = true;
  return body;
}

function classifyError(err) {
  const msg = err.message || '';
  // Already classified
  if (err instanceof ApiError) return err;
  // Timeout
  if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('Navigation timeout')) {
    return new ApiError(504, `Operation timed out: ${msg}`);
  }
  // Connection lost mid-operation (Chrome crashed)
  if (msg.includes('disconnected') || msg.includes('Target closed') || msg.includes('Session closed')) {
    return new ApiError(502, `Browser connection lost: ${msg}`);
  }
  // Container/CDP startup failure
  if (msg.includes('CDP not ready') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
    return new ApiError(503, `Service unavailable: ${msg}`);
  }
  // Docker errors
  if (msg.includes('No such container') || msg.includes('port is already allocated') || msg.includes('docker')) {
    return new ApiError(503, `Container error: ${msg}`);
  }
  // Default
  return new ApiError(500, msg);
}

function withProfileLock(profileId, task) {
  const pid = String(profileId);
  const previous = profileLocks.get(pid) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  profileLocks.set(pid, current);
  return current.finally(() => {
    if (profileLocks.get(pid) === current) profileLocks.delete(pid);
  });
}

function armVncLeaseExpiry(profileId, lease, expiresAt) {
  const pid = String(profileId);
  const timer = setTimeout(() => {
    withProfileLock(pid, async () => {
      const current = vncLeases.get(pid);
      if (
        current !== lease
        || current.timer !== timer
        || current.expiresAt !== expiresAt
      ) {
        return;
      }

      // Timers can fire slightly early. Re-arm for the remaining time without
      // extending the lease from its original expiry.
      if (Date.now() < expiresAt) {
        armVncLeaseExpiry(pid, lease, expiresAt);
        return;
      }

      await releaseVncLease(pid, lease.leaseId, { reason: 'heartbeat timeout' });
    }).catch((err) => {
      console.error(`[VNC] Failed to release expired lease for ${pid}:`, err.message);
    });
  }, Math.max(0, expiresAt - Date.now()));
  lease.timer = timer;
  timer.unref?.();
}

function scheduleVncLease(profileId, lease) {
  if (lease.timer) clearTimeout(lease.timer);
  const expiresAt = Date.now() + VNC_LEASE_TTL_MS;
  lease.expiresAt = expiresAt;
  armVncLeaseExpiry(profileId, lease, expiresAt);
}

function touchVncLease(profileId, leaseId) {
  const lease = vncLeases.get(String(profileId));
  if (!lease || lease.leaseId !== leaseId) {
    throw new ApiError(409, `VNC lease for profile ${profileId} is missing or expired`);
  }
  scheduleVncLease(profileId, lease);
  return lease;
}

async function releaseVncLease(profileId, leaseId, {
  reason = 'client release',
  revokeAccess = true,
} = {}) {
  const pid = String(profileId);
  const lease = vncLeases.get(pid);
  if (!lease) {
    return { released: false, browserMode: cm.containers.get(pid)?.browserMode || null };
  }
  if (leaseId && lease.leaseId !== leaseId) {
    throw new ApiError(409, `VNC lease for profile ${profileId} does not belong to this client`);
  }

  if (lease.timer) clearTimeout(lease.timer);
  if (revokeAccess) {
    try {
      await cm.disableVncAccess(pid);
    } catch (err) {
      scheduleVncLease(pid, lease);
      throw new ApiError(503, `Failed to revoke VNC access for profile ${profileId}: ${err.message}`);
    }
  }
  vncLeases.delete(pid);
  const info = cm.containers.get(pid);
  if (info?.browserMode) {
    sessionModes.set(pid, normalizeBrowserMode(info.browserMode));
  } else {
    sessionModes.delete(pid);
  }

  console.log(`[VNC] Profile ${pid} released (${reason})${info ? `, keeping ${info.browserMode} until idle stop` : ''}`);
  resetIdleStopTimer(pid);
  return { released: true, browserMode: info?.browserMode || null };
}

// --- Auth dump / restore and capacity ---

function protectedBrowserIds() {
  const ids = new Set([...vncLeases.keys()].map(String));
  for (const id of cm.containers.keys()) {
    if (bc.hasOpenPages?.(id)) ids.add(String(id));
  }
  return ids;
}

function clearIdleStopTimer(profileId) {
  const pid = String(profileId);
  const timer = idleStopTimers.get(pid);
  if (timer) clearTimeout(timer);
  idleStopTimers.delete(pid);
}

function resetIdleStopTimer(profileId) {
  const pid = String(profileId);
  clearIdleStopTimer(pid);
  const ms = idleStopMs();
  if (!ms) return;
  if (vncLeases.has(pid)) return;

  const timer = setTimeout(() => {
    withProfileLock(pid, async () => {
      if (idleStopTimers.get(pid) !== timer) return;
      idleStopTimers.delete(pid);
      if (vncLeases.has(pid) || bc.hasOpenPages?.(pid)) {
        resetIdleStopTimer(pid);
        return;
      }
      if (!cm.containers.has(pid)) return;
      console.log(`[IdleStop] Profile ${pid} idle for ${ms / 1000}s, dumping and stopping`);
      await dumpProfileCookies(pid);
      await stopProfileContainer(pid);
      lastUsedAt.delete(pid);
      sessionModes.delete(pid);
    }).catch((err) => {
      console.error(`[IdleStop] Failed to stop profile ${pid}:`, err.message);
      resetIdleStopTimer(pid);
    });
  }, ms);
  timer.unref?.();
  idleStopTimers.set(pid, timer);
}

function touchLastUsed(profileId) {
  const pid = String(profileId);
  lastUsedAt.set(pid, Date.now());
  resetIdleStopTimer(pid);
}

async function dumpProfileCookies(profileId) {
  const pid = String(profileId);
  if (!bc.get?.(pid)) {
    const info = cm.containers.get(pid);
    if (!info?.cdpPort) return false;
    try {
      await bc.connect(pid, info.cdpPort);
    } catch (err) {
      console.error(`[Auth] Failed to connect for cookie dump ${pid}:`, err.message);
      return false;
    }
  }
  if (typeof bc.getCookiesMain !== 'function') return false;
  try {
    const cookies = await bc.getCookiesMain(pid);
    if (Array.isArray(cookies) && cookies.length) {
      authStore.save(pid, cookies);
      if (cookies.some((c) => c.name === 'biz_magic')) needsLogin.delete(pid);
    }
    return true;
  } catch (err) {
    console.error(`[Auth] Failed to dump cookies for ${pid}:`, err.message);
    return false;
  }
}

async function restoreProfileCookies(profileId, { browserMode } = {}) {
  const pid = String(profileId);
  const cookies = authStore.load(pid);
  if (!cookies || cookies.length === 0) return { restored: false };
  if (typeof bc.setCookiesMain === 'function') {
    await bc.setCookiesMain(pid, AuthStore.toSetCookies(cookies));
  }
  const profile = ps.get(profileId);
  if (profile?.url && profile.url !== 'about:blank' && typeof bc.navigateMain === 'function') {
    await bc.navigateMain(pid, profile.url);
  }

  let probe = { loggedIn: null, reason: 'skipped' };
  if (
    profile?.url
    && /store\.weixin\.qq\.com/.test(profile.url)
    && typeof bc.evaluateOnMain === 'function'
  ) {
    try {
      const page = await bc.evaluateOnMain(pid, [
        '({',
        'href: location.href,',
        'title: document.title,',
        'text: document.body ? document.body.innerText : ""',
        '})',
      ].join(' '));
      probe = detectLoginState(page || {});
    } catch (err) {
      console.error(`[Auth] Login probe failed for ${pid}:`, err.message);
    }
  }

  if (probe.loggedIn === true) needsLogin.delete(pid);
  if (probe.loggedIn === false) {
    needsLogin.add(pid);
    if (!isVncMode(browserMode)) {
      throw new ApiError(
        401,
        `Profile ${pid} needs login; cookie restore did not restore the shop session`,
        { needsLogin: true },
      );
    }
  }
  return { restored: true, probe };
}

async function evictVictim(victim, reason) {
  const pid = String(victim);
  let stopped = false;
  await withProfileLock(pid, async () => {
    if (!cm.containers.has(pid)) return;
    if (vncLeases.has(pid) || bc.hasOpenPages?.(pid)) return;
    console.log(`[Capacity] ${reason}: stopping ${pid}`);
    await stopProfileContainer(pid);
    lastUsedAt.delete(pid);
    sessionModes.delete(pid);
    stopped = true;
  });
  return stopped;
}

async function evictToCapacity(startingId) {
  const max = maxRunningBrowsers();
  const starting = String(startingId);
  const skipped = new Set();
  while (true) {
    const runningIds = [...cm.containers.keys()].map(String);
    const victim = pickEvictionVictim({
      runningIds,
      maxRunning: max,
      startingId: starting,
      protectedIds: new Set([...protectedBrowserIds(), ...skipped]),
      lastUsedAt,
    });
    if (!victim) {
      const others = runningIds.filter((id) => id !== starting);
      if (!cm.containers.has(starting) && others.length >= max) {
        throw new ApiError(503, `Too many running browsers (max ${max}); stop one explicitly`);
      }
      return;
    }
    const stopped = await evictVictim(victim, `Evicting to start ${starting}`);
    if (!stopped) skipped.add(victim);
  }
}

async function enforceRunningCapacity() {
  const max = maxRunningBrowsers();
  const skipped = new Set();
  while ([...cm.containers.keys()].length > max) {
    const victim = pickEvictionVictim({
      runningIds: [...cm.containers.keys()].map(String),
      maxRunning: max,
      protectedIds: new Set([...protectedBrowserIds(), ...skipped]),
      lastUsedAt,
    });
    if (!victim) break;
    const stopped = await evictVictim(victim, `Stopping extra browser (max ${max})`);
    if (!stopped) skipped.add(victim);
  }
}

/**
 * Ensure container running + CDP connected.
 * Throws ApiError with proper status codes.
 */
function resolveSessionMode(profileId, requestedMode) {
  if (requestedMode !== undefined) return normalizeBrowserMode(requestedMode);

  const pid = String(profileId);
  const active = cm.containers.get(pid);
  if (active?.browserMode) {
    return normalizeBrowserMode(active.browserMode);
  }

  const rememberedMode = sessionModes.get(pid);
  return rememberedMode && rememberedMode !== BROWSER_MODES.VNC
    ? normalizeBrowserMode(rememberedMode)
    : BROWSER_MODES.HEADLESS;
}

async function ensureConnected(profileId, requestedMode) {
  const profile = ps.get(profileId);
  if (!profile) {
    throw new ApiError(404, `Profile ${profileId} not found. Create it first: POST /profiles`);
  }

  const pid = String(profileId);
  const normalizedRequestedMode = requestedMode === undefined
    ? undefined
    : normalizeBrowserMode(requestedMode);
  if (vncLeases.has(pid) && normalizedRequestedMode && normalizedRequestedMode !== BROWSER_MODES.VNC) {
    throw new ApiError(409, `Profile ${profileId} has an active VNC session`);
  }
  const browserMode = resolveSessionMode(pid, requestedMode);
  sessionModes.set(pid, browserMode);
  const startOptions = {};
  if (profile.fingerprintTemplateId) {
    startOptions.extension = fe.build(profileId, profile.fingerprintTemplateId);
  }
  startOptions.browserMode = browserMode;
  if (profile.url) startOptions.url = profile.url;
  const proxyUrl = resolveProxyUrl(profile.proxyId);
  if (proxyUrl) startOptions.proxy = proxyUrl;

  // If we have stale in-memory state for a stopped container, clear it first.
  // A running browser is not mode-switched as a side effect of a later request.
  let info = cm.containers.get(pid);
  if (info) {
    let status;
    try {
      status = await cm.status(pid);
    } catch (err) {
      throw new ApiError(
        503,
        `Failed to inspect running browser; it was left intact: ${err.message}`,
      );
    }
    const activeMode = normalizeBrowserMode(info.browserMode);
    if (status === 'running' && activeMode !== startOptions.browserMode) {
      throw new ApiError(
        409,
        `Profile ${profileId} is already running in ${activeMode} mode; `
          + `explicitly stop it before starting ${startOptions.browserMode} mode`,
      );
    }
    if (status !== 'running') {
      cm.containers.delete(pid);
      await bc.disconnect(pid).catch(() => {});
      info = null;
      await cm.stop(pid).catch(() => {});
    }
  }

  const coldStart = !info;
  if (!info) {
    try {
      await evictToCapacity(pid);
      info = await cm.start(pid, startOptions);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(503, `Failed to start container: ${err.message}`);
    }
  }

  // A connection failure must fail this operation, not restart a running
  // browser. Cookie restore can reconnect a later request.
  try {
    if (!bc.get(pid)) {
      await bc.connect(pid, info.cdpPort);
    }
  } catch (err) {
    await bc.disconnect(pid).catch(() => {});
    throw new ApiError(503, `Failed to connect to running browser without restarting it: ${err.message}`);
  }

  if (coldStart) {
    try {
      await restoreProfileCookies(pid, { browserMode });
    } catch (err) {
      if (err instanceof ApiError && err.needsLogin) {
        await stopProfileContainer(pid, { dump: false });
        lastUsedAt.delete(pid);
        sessionModes.delete(pid);
      }
      throw err;
    }
  }
  touchLastUsed(pid);
  return info;
}

/**
 * Wrapper for browser operation endpoints.
 * Handles: profile check, lifecycle serialization, error classification.
 */
function browserOp(handler) {
  return async (req, res) => {
    const pid = String(req.params.id);
    try {
      // Serialize browser operations with VNC acquire/release and mode changes.
      await withProfileLock(pid, () => handler(req, res));
    } catch (err) {
      const apiErr = classifyError(err);
      res.status(apiErr.status).json(errorPayload(apiErr));
    }
  };
}

// --- Browser operations ---

async function listBrowsers(req, res) {
  try {
    let list = await cm.list();
    const typeFilter = req.query.type;
    list = list.map((b) => {
      const profile = ps.get(b.profileId);
      return {
        ...b,
        name: profile?.name,
        type: profile?.type,
        browserMode: b.browserMode,
        vncActive: vncLeases.has(String(b.profileId)),
        needsLogin: needsLogin.has(String(b.profileId)),
      };
    });
    if (typeFilter) {
      list = list.filter((b) => b.type === typeFilter);
    }
    res.json({ ok: true, browsers: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function acquireVncSession(profileId, requestedLeaseId) {
  const pid = String(profileId);
  const existing = vncLeases.get(pid);
  if (existing) {
    if (!requestedLeaseId || existing.leaseId !== requestedLeaseId) {
      throw new ApiError(409, `Profile ${profileId} already has an active VNC session`);
    }
    const info = await ensureConnected(pid, BROWSER_MODES.VNC);
    try {
      await cm.enableVncAccess(pid);
    } catch (err) {
      await rollbackFailedVncEnable(pid, existing, err);
    }
    scheduleVncLease(pid, existing);
    needsLogin.delete(pid);
    return { info, leaseId: existing.leaseId };
  }

  const active = cm.containers.get(pid);
  if (active?.browserMode && normalizeBrowserMode(active.browserMode) === BROWSER_MODES.HEADLESS) {
    let status;
    try {
      status = await cm.status(pid);
    } catch (err) {
      throw new ApiError(
        503,
        `Failed to inspect Headless browser; it was left intact: ${err.message}`,
      );
    }
    if (status === 'running' && bc.hasOpenPages?.(pid)) {
      throw new ApiError(409, `Profile ${profileId} has an active collection; wait for it to finish before opening VNC`);
    }
    if (status === 'running') {
      // Opening VNC is an explicit user action and therefore owns this one
      // destructive transition. stopProfileContainer dumps cookies first.
      console.log(`[VNC] Profile ${pid} switching from headless to vnc by explicit request`);
      await stopProfileContainer(pid);
    }
  }

  const info = await ensureConnected(pid, BROWSER_MODES.VNC);
  const leaseId = crypto.randomUUID();
  const lease = { leaseId, timer: null, expiresAt: 0 };
  vncLeases.set(pid, lease);
  try {
    await cm.enableVncAccess(pid);
  } catch (err) {
    await rollbackFailedVncEnable(pid, lease, err);
  }
  scheduleVncLease(pid, lease);
  needsLogin.delete(pid);
  return { info, leaseId };
}

async function rollbackFailedVncEnable(profileId, lease, enableError) {
  const pid = String(profileId);
  try {
    await cm.disableVncAccess(pid);
  } catch (cleanupError) {
    // Access may still be live. Keep the lease tracked so its timeout can
    // retry revocation instead of exposing an unmanaged VNC connection.
    scheduleVncLease(pid, lease);
    throw new ApiError(
      503,
      `Failed to enable VNC access for profile ${profileId}: ${enableError.message}; `
        + `failed to revoke partial access: ${cleanupError.message}`,
    );
  }

  if (lease.timer) clearTimeout(lease.timer);
  if (vncLeases.get(pid) === lease) vncLeases.delete(pid);

  const info = cm.containers.get(pid);
  if (info?.browserMode) {
    sessionModes.set(pid, normalizeBrowserMode(info.browserMode));
  } else {
    sessionModes.delete(pid);
  }

  throw new ApiError(503, `Failed to enable VNC access for profile ${profileId}: ${enableError.message}`);
}

async function startBrowser(req, res) {
  try {
    const pid = String(req.params.id);
    let browserMode;
    try {
      browserMode = normalizeBrowserMode(req.body?.browserMode);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    const result = await withProfileLock(pid, async () => {
      if (browserMode === BROWSER_MODES.VNC) {
        const session = await acquireVncSession(pid, req.body?.leaseId);
        return { ...session, browserMode: session.info.browserMode };
      }
      const info = await ensureConnected(pid, browserMode);
      return { info, browserMode: info.browserMode };
    });
    res.json({
      ok: true,
      profileId: pid,
      status: 'running',
      browserMode: result.browserMode,
      ...(result.leaseId ? { leaseId: result.leaseId } : {}),
    });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json(errorPayload(apiErr));
  }
}

async function stopBrowser(req, res) {
  try {
    const pid = String(req.params.id);
    if (!ps.get(pid)) return res.status(404).json({ ok: false, error: 'Profile not found' });
    await withProfileLock(pid, async () => {
      if (vncLeases.has(pid)) {
        await releaseVncLease(pid, null, { reason: 'explicit stop' });
      }
      await stopProfileContainer(pid);
      sessionModes.delete(pid);
    });
    res.json({ ok: true, profileId: pid, status: 'stopped' });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json(errorPayload(apiErr));
  }
}

async function vncHeartbeat(req, res) {
  try {
    const pid = String(req.params.id);
    const leaseId = req.body?.leaseId;
    if (!leaseId) return res.status(400).json({ ok: false, error: 'leaseId is required' });
    await withProfileLock(pid, async () => {
      if (!ps.get(pid)) throw new ApiError(404, 'Profile not found');
      const info = cm.containers.get(pid);
      const status = await cm.status(pid).catch(() => 'not_found');
      if (status !== 'running' || !info || !isVncMode(info.browserMode)) {
        await releaseVncLease(pid, leaseId, {
          reason: 'VNC container unavailable',
          revokeAccess: false,
        });
        throw new ApiError(409, `VNC container for profile ${pid} is no longer running`);
      }
      touchVncLease(pid, leaseId);
    });
    res.json({ ok: true, profileId: pid, status: 'vnc' });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json(errorPayload(apiErr));
  }
}

async function releaseVnc(req, res) {
  try {
    const pid = String(req.params.id);
    if (!ps.get(pid)) return res.status(404).json({ ok: false, error: 'Profile not found' });
    const result = await withProfileLock(pid, () => releaseVncLease(pid, req.body?.leaseId));
    res.json({
      ok: true,
      profileId: pid,
      status: result.browserMode ? 'running' : 'stopped',
      browserMode: result.browserMode,
      resumedBrowserMode: null,
    });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json(errorPayload(apiErr));
  }
}

async function navigate(req, res) {
  const { url } = req.body;
  if (!url) throw new ApiError(400, 'url is required');

  const pid = String(req.params.id);
  if (vncLeases.has(pid)) {
    throw new ApiError(409, `Profile ${pid} has an active VNC session; use a background collection page for navigation`);
  }
  await ensureConnected(pid);
  await bc.navigateMain(pid, url);
  res.json({ ok: true, url });
}

async function execute(req, res) {
  const { script, url_pattern, urlPattern } = req.body;
  if (!script) throw new ApiError(400, 'script is required');

  const pid = String(req.params.id);
  const targetPattern = url_pattern || urlPattern;
  if (vncLeases.has(pid)) {
    throw new ApiError(409, `Profile ${pid} has an active VNC session; use a background collection page for execution`);
  }
  await ensureConnected(pid);
  const wrapped = `(async () => { ${script} })()`;
  const result = targetPattern
    ? await bc.evaluateOnUrlPattern(pid, String(targetPattern), wrapped)
    : await bc.evaluateOnMain(pid, wrapped);
  res.json({ ok: true, result });
}

async function isProfileRunning(profileId) {
  const pid = String(profileId);
  if (!cm.containers.has(pid)) return false;
  try {
    return (await cm.status(pid)) === 'running';
  } catch {
    return false;
  }
}

/**
 * Cookie dump is not a login proof. Callers must judge expiry with a
 * platform API (401 / 200003 / login page). This path only avoids a
 * cold start when the browser is already stopped and a dump exists.
 */
async function getCookies(req, res) {
  const pid = String(req.params.id);
  if (await isProfileRunning(pid)) {
    await ensureConnected(pid);
    const cookies = await bc.getCookiesMain(pid);
    res.json({ ok: true, cookies, source: 'live' });
    return;
  }

  const dump = authStore.readDump(pid);
  if (dump && dump.cookies.length > 0) {
    res.json({ ok: true, cookies: dump.cookies, source: 'dump', savedAt: dump.savedAt });
    return;
  }

  await ensureConnected(pid);
  const cookies = await bc.getCookiesMain(pid);
  res.json({ ok: true, cookies, source: 'live' });
}

async function screenshot(req, res) {
  const pid = String(req.params.id);
  const fullPage = req.body?.full_page || false;
  if (vncLeases.has(pid) && fullPage) {
    throw new ApiError(409, `Profile ${pid} has an active VNC session; use a background collection page for full-page screenshots`);
  }
  await ensureConnected(pid);
  const image = await bc.screenshotMain(pid, fullPage);
  res.json({ ok: true, image });
}

async function pasteClipboard(req, res) {
  const { text } = req.body || {};
  if (typeof text !== 'string') throw new ApiError(400, 'text is required');

  const pid = String(req.params.id);
  await ensureVncConnected(pid);
  await bc.insertTextMain(pid, text);
  res.json({ ok: true });
}

async function copyClipboard(req, res) {
  const pid = String(req.params.id);
  await ensureVncConnected(pid);
  const text = await bc.getSelectionTextMain(pid);
  res.json({ ok: true, text });
}

async function uploadFile(req, res) {
  const { fileName, fileData } = req.body || {};
  if (!fileName || !fileData) throw new ApiError(400, 'fileName and fileData (base64) are required');

  const pid = String(req.params.id);
  await ensureVncConnected(pid);

  // Write decoded file to host temp dir
  // Use ASCII-only name — xdotool cannot type Chinese characters
  const ext = path.extname(fileName) || '.bin';
  const tmpName = `hive-upload-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  const buf = Buffer.from(fileData, 'base64');
  fs.writeFileSync(tmpPath, buf);

  try {
    // Copy into container's /tmp
    const containerPath = await cm.copyFileToContainer(pid, tmpPath, tmpName);

    // Use xdotool to type the file path into Chrome's file dialog and confirm
    await cm.execInContainer(pid, ['xdotool', 'key', 'ctrl+l']);
    await new Promise((r) => setTimeout(r, 200));
    await cm.execInContainer(pid, ['xdotool', 'type', '--clearmodifiers', containerPath]);
    await new Promise((r) => setTimeout(r, 100));
    await cm.execInContainer(pid, ['xdotool', 'key', 'Return']);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Upload] failed:', err.message);
    throw err;
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

// --- Page (tab) operations ---

async function newPage(req, res) {
  const { url } = req.body;
  if (!url) throw new ApiError(400, 'url is required');

  const pid = String(req.params.id);
  await ensureConnected(pid);
  const { pageId } = await bc.newPage(pid, url);
  res.json({ ok: true, pageId });
}

async function closePage(req, res) {
  const pid = String(req.params.id);
  await ensureConnected(pid);
  await bc.closePage(pid, req.params.pageId);
  res.json({ ok: true });
}

async function pageExecute(req, res) {
  const { script } = req.body;
  if (!script) throw new ApiError(400, 'script is required');

  const pid = String(req.params.id);
  await ensureConnected(pid);
  const wrapped = `(async () => { ${script} })()`;
  const result = await bc.evaluateOnPage(pid, req.params.pageId, wrapped);
  res.json({ ok: true, result });
}

async function pageScreenshot(req, res) {
  const pid = String(req.params.id);
  await ensureConnected(pid);
  const fullPage = req.body?.full_page || false;
  const image = await bc.screenshotPage(pid, req.params.pageId, fullPage);
  res.json({ ok: true, image });
}

async function getVncUrl(req, res) {
  try {
    const pid = String(req.params.id);
    const session = await withProfileLock(pid, () => acquireVncSession(pid, req.query.leaseId));
    const host = req.hostname || 'localhost';
    res.json({
      ok: true,
      leaseId: session.leaseId,
      browserMode: session.info.browserMode,
      url: `http://${host}:${session.info.vncPort}/vnc.html?resize=scale&autoconnect=true`,
    });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json(errorPayload(apiErr));
  }
}

// --- Profile management ---

async function createProfile(req, res) {
  try {
    const { name, url } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    if (Object.prototype.hasOwnProperty.call(req.body, 'browserMode')) {
      return res.status(400).json({
        ok: false,
        error: 'browserMode belongs to POST /browsers/:id/start, not the Profile',
      });
    }
    const profile = ps.create(req.body);
    if (module.exports.onProfileChanged) module.exports.onProfileChanged(profile.id);
    res.status(201).json({ ok: true, profile });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function listProfiles(req, res) {
  try {
    let profiles = ps.list();
    const typeFilter = req.query.type;
    if (typeFilter) {
      profiles = profiles.filter((p) => p.type === typeFilter);
    } else {
      profiles = profiles.filter((p) => !p.system);
    }
    res.json({ ok: true, profiles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function getProfile(req, res) {
  try {
    const profile = ps.get(req.params.id);
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });
    res.json({ ok: true, profile });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function updateProfile(req, res) {
  try {
    const existing = ps.get(req.params.id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Profile not found' });
    if (existing.system) {
      return res.status(409).json({ ok: false, error: 'System profile cannot be modified' });
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'browserMode')) {
      return res.status(400).json({
        ok: false,
        error: 'browserMode belongs to POST /browsers/:id/start, not the Profile',
      });
    }

    const profile = ps.update(req.params.id, req.body);
    if (module.exports.onProfileChanged) module.exports.onProfileChanged(profile.id);
    res.json({ ok: true, profile });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function deleteProfile(req, res) {
  try {
    const profileId = req.params.id;
    const profile = ps.get(profileId);
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });
    if (profile.system) {
      return res.status(409).json({ ok: false, error: 'System profile cannot be deleted' });
    }

    // Stop container if running
    const pid = String(profileId);
    await withProfileLock(pid, async () => {
      if (vncLeases.has(pid)) {
        await releaseVncLease(pid, null, { reason: 'profile deleted' });
      }
      if (cm.containers.has(pid)) await stopProfileContainer(pid);
      sessionModes.delete(pid);
    });

    ps.remove(profileId);
    if (module.exports.onProfileDeleted) module.exports.onProfileDeleted(profileId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function ensureVncConnected(profileId) {
  const info = await ensureConnected(profileId, BROWSER_MODES.VNC);
  if (!isVncMode(info.browserMode)) throw new ApiError(409, `Profile ${profileId} is currently running in headless mode`);
  return info;
}

async function stopProfileContainer(profileId, { dump = true } = {}) {
  const pid = String(profileId);
  clearIdleStopTimer(pid);
  if (dump) await dumpProfileCookies(pid);
  await bc.disconnect(pid).catch(() => {});
  await cm.stop(pid);
}

// --- System ---

async function health(req, res) {
  res.json({ status: 'ok' });
}

// Cleanup timers on shutdown
function clearAllTimers() {
  for (const [, lease] of vncLeases) {
    if (lease.timer) clearTimeout(lease.timer);
  }
  vncLeases.clear();
  for (const timer of idleStopTimers.values()) clearTimeout(timer);
  idleStopTimers.clear();
  sessionModes.clear();
  profileLocks.clear();
  lastUsedAt.clear();
  needsLogin.clear();
}

module.exports = {
  mount,
  clearAllTimers,
  dumpProfileCookies,
  enforceRunningCapacity,
};
