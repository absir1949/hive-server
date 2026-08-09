/**
 * api — HTTP API 层
 *
 * 两类端点：
 *   - 旧接口 (navigate/execute/screenshot/cookies) — 默认操作主 tab，用于 keepAlive 和简单操作
 *     execute 支持 url_pattern：传入时只在匹配 tab 执行，避免误读当前 tab。
 *   - Page 接口 (/pages/new, /pages/:pageId/*) — 创建最小化后台窗口，不影响 VNC 操作
 *
 * 内部流程：ensureConnected(profileId) → 启容器 → 连 CDP → 执行操作
 * 调用者不需要关心容器生命周期。
 *
 * 空闲超时：每次成功操作后重置计时器，超时后自动关闭容器。
 */

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS, 10) || 5 * 60 * 1000; // default 5 min
const VNC_LEASE_TTL_MS = parseInt(process.env.VNC_LEASE_TTL_MS, 10) || 2 * 60 * 1000; // default 2 min
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { BROWSER_MODES, normalizeBrowserMode, isVncMode } = require('./browserMode');

let cm; // ContainerManager
let bc; // BrowserConnector
let ps; // ProfileStore
let fe; // FingerprintEngine
let vnc; // VNC proxy/signing helper

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

// profileId → setTimeout handle
const idleTimers = new Map();
// profileId → the mode requested for the current/next runtime session.
// This is intentionally ephemeral: the persistent Profile only owns data and
// identity, while the browser mode belongs to the active session.
const sessionModes = new Map();
// profileId → { leaseId, expiresAt, timer }
const vncLeases = new Map();
// Serialize lifecycle transitions for one Profile. This prevents a VNC open,
// release, and headless start request from racing over the same data directory.
const profileLocks = new Map();
// Count running and queued browser operations. Idle timeout starts only after
// the last operation finishes, never while a collection request is in flight.
const activeOperations = new Map();

function mount(app, deps) {
  cm = deps.cm;
  bc = deps.bc;
  ps = deps.ps;
  fe = deps.fe;
  vnc = deps.vnc;

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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
    resetIdleTimer(pid);
  } else {
    sessionModes.delete(pid);
  }

  console.log(`[VNC] Profile ${pid} released (${reason})${info ? `, keeping ${info.browserMode} until idle` : ''}`);
  return { released: true, browserMode: info?.browserMode || null };
}

// --- Idle timeout ---

function resetIdleTimer(profileId) {
  const pid = String(profileId);
  const existing = idleTimers.get(pid);
  if (existing) clearTimeout(existing);
  idleTimers.delete(pid);
  if ((activeOperations.get(pid) || 0) > 0) return;

  const timer = setTimeout(() => {
    if (idleTimers.get(pid) !== timer) return;
    idleTimers.delete(pid);
    withProfileLock(pid, async () => {
      if ((activeOperations.get(pid) || 0) > 0) return;
      if (vncLeases.has(pid)) {
        // A VNC lease has its own shorter heartbeat timeout. Do not let the
        // generic browser idle timer kill an interactive session first.
        resetIdleTimer(pid);
        return;
      }
      if (idleTimers.has(pid)) return;
      console.log(`[IdleTimeout] Profile ${pid} idle for ${IDLE_TIMEOUT_MS / 1000}s, stopping`);
      await bc.disconnect(pid).catch(() => {});
      await cm.stop(pid).catch(() => {});
      sessionModes.delete(pid);
    }).catch((err) => {
      console.error(`[IdleTimeout] Failed to stop profile ${pid}:`, err.message);
      resetIdleTimer(pid);
    });
  }, IDLE_TIMEOUT_MS);

  // Don't let timer keep the process alive
  timer.unref();
  idleTimers.set(pid, timer);
}

function clearIdleTimer(profileId) {
  const pid = String(profileId);
  const timer = idleTimers.get(pid);
  if (timer) clearTimeout(timer);
  idleTimers.delete(pid);
}

function beginBrowserOperation(profileId) {
  const pid = String(profileId);
  activeOperations.set(pid, (activeOperations.get(pid) || 0) + 1);
  clearIdleTimer(pid);
}

function endBrowserOperation(profileId) {
  const pid = String(profileId);
  const remaining = Math.max(0, (activeOperations.get(pid) || 1) - 1);
  if (remaining > 0) {
    activeOperations.set(pid, remaining);
    return;
  }
  activeOperations.delete(pid);
  if (cm.containers.has(pid)) resetIdleTimer(pid);
}

// --- Core orchestration ---

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
  let info = cm.containers.get(pid);
  if (info) {
    const status = await cm.status(pid).catch(() => 'not_found');
    const activeMode = normalizeBrowserMode(info.browserMode);
    if (
      status === 'running'
      && activeMode !== startOptions.browserMode
      && bc.hasOpenPages?.(pid)
    ) {
      throw new ApiError(409, `Profile ${profileId} has an active collection; mode switch is not allowed`);
    }
    if (status !== 'running' || activeMode !== startOptions.browserMode) {
      cm.containers.delete(pid);
      await bc.disconnect(pid).catch(() => {});
      info = null;
      await cm.stop(pid).catch(() => {});
    }
  }

  // Ensure container is running
  if (!info) {
    try {
      info = await cm.start(pid, startOptions);
    } catch (err) {
      throw new ApiError(503, `Failed to start container: ${err.message}`);
    }
  }

  // Connect with retry on failure
  try {
    if (!bc.get(pid)) {
      await bc.connect(pid, info.cdpPort);
    }
  } catch (err) {
    // Container might have died — restart once
    await bc.disconnect(pid).catch(() => {});
    await cm.stop(pid).catch(() => {});
    try {
      info = await cm.start(pid, startOptions);
      await bc.connect(pid, info.cdpPort);
    } catch (retryErr) {
      throw new ApiError(503, `Failed after retry: ${retryErr.message}`);
    }
  }

  return info;
}

/**
 * Wrapper for browser operation endpoints.
 * Handles: profile check, ensureReady, idle timer reset, error classification.
 */
function browserOp(handler) {
  return async (req, res) => {
    const pid = String(req.params.id);
    beginBrowserOperation(pid);
    try {
      // Serialize browser operations with VNC acquire/release and mode changes.
      await withProfileLock(pid, () => handler(req, res));
    } catch (err) {
      const apiErr = classifyError(err);
      res.status(apiErr.status).json({ ok: false, error: apiErr.message });
    } finally {
      endBrowserOperation(pid);
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
    return { info, leaseId: existing.leaseId };
  }

  const active = cm.containers.get(pid);
  if (active?.browserMode && normalizeBrowserMode(active.browserMode) === BROWSER_MODES.HEADLESS) {
    const status = await cm.status(pid).catch(() => 'not_found');
    if (status === 'running' && bc.hasOpenPages?.(pid)) {
      throw new ApiError(409, `Profile ${profileId} has an active collection; wait for it to finish before opening VNC`);
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
    resetIdleTimer(pid);
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
        resetIdleTimer(pid);
        return { ...session, browserMode: session.info.browserMode };
      }
      const info = await ensureConnected(pid, browserMode);
      resetIdleTimer(pid);
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
    res.status(apiErr.status).json({ ok: false, error: apiErr.message });
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
    res.status(apiErr.status).json({ ok: false, error: apiErr.message });
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
      resetIdleTimer(pid);
    });
    res.json({ ok: true, profileId: pid, status: 'vnc' });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json({ ok: false, error: apiErr.message });
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
    res.status(apiErr.status).json({ ok: false, error: apiErr.message });
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

async function getCookies(req, res) {
  const pid = String(req.params.id);
  await ensureConnected(pid);
  const cookies = await bc.getCookiesMain(pid);
  res.json({ ok: true, cookies });
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
    resetIdleTimer(pid);
    res.json({
      ok: true,
      leaseId: session.leaseId,
      browserMode: session.info.browserMode,
      url: `http://${host}:${session.info.vncPort}/vnc.html?resize=scale&autoconnect=true`,
    });
  } catch (err) {
    const apiErr = classifyError(err);
    res.status(apiErr.status).json({ ok: false, error: apiErr.message });
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
    if (!ps.get(profileId)) return res.status(404).json({ ok: false, error: 'Profile not found' });

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

async function stopProfileContainer(profileId) {
  const pid = String(profileId);
  clearIdleTimer(pid);
  await bc.disconnect(pid).catch(() => {});
  await cm.stop(pid);
}

// --- System ---

async function health(req, res) {
  res.json({ status: 'ok' });
}

// Cleanup timers on shutdown
function clearAllTimers() {
  for (const [, timer] of idleTimers) {
    clearTimeout(timer);
  }
  idleTimers.clear();
  for (const [, lease] of vncLeases) {
    if (lease.timer) clearTimeout(lease.timer);
  }
  vncLeases.clear();
  sessionModes.clear();
  profileLocks.clear();
  activeOperations.clear();
}

module.exports = { mount, clearAllTimers };
