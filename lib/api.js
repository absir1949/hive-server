/**
 * api — HTTP API 层
 *
 * 两类端点：
 *   - 旧接口 (navigate/execute/screenshot/cookies) — 操作主 tab，用于 keepAlive 和简单操作
 *   - Page 接口 (/pages/new, /pages/:pageId/*) — 新开独立 tab，不影响用户操作
 *
 * 内部流程：ensureConnected(profileId) → 启容器 → 连 CDP → 执行操作
 * 调用者不需要关心容器生命周期。
 *
 * 空闲超时：每次成功操作后重置计时器，超时后自动关闭容器。
 */

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS, 10) || 10 * 60 * 1000; // default 10 min

let cm; // ContainerManager
let bc; // BrowserConnector
let ps; // ProfileStore
let fe; // FingerprintEngine

// profileId → setTimeout handle
const idleTimers = new Map();

function mount(app, deps) {
  cm = deps.cm;
  bc = deps.bc;
  ps = deps.ps;
  fe = deps.fe;

  // Browser operations
  app.get('/browsers', listBrowsers);
  app.post('/browsers/:id/navigate', browserOp(navigate));
  app.post('/browsers/:id/execute', browserOp(execute));
  app.get('/browsers/:id/cookies', browserOp(getCookies));
  app.post('/browsers/:id/screenshot', browserOp(screenshot));
  app.get('/browsers/:id/vnc', getVncUrl);

  // Page (tab) operations
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

// --- Idle timeout ---

function resetIdleTimer(profileId) {
  const existing = idleTimers.get(profileId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    idleTimers.delete(profileId);
    console.log(`[IdleTimeout] Profile ${profileId} idle for ${IDLE_TIMEOUT_MS / 1000}s, stopping`);
    await bc.disconnect(String(profileId)).catch(() => {});
    await cm.stop(String(profileId)).catch(() => {});
  }, IDLE_TIMEOUT_MS);

  // Don't let timer keep the process alive
  timer.unref();
  idleTimers.set(profileId, timer);
}

// --- Core orchestration ---

/**
 * Ensure container running + CDP connected.
 * Throws ApiError with proper status codes.
 */
async function ensureConnected(profileId) {
  const profile = ps.get(profileId);
  if (!profile) {
    throw new ApiError(404, `Profile ${profileId} not found. Create it first: POST /profiles`);
  }

  const pid = String(profileId);
  const startOptions = {};
  if (profile.fingerprintTemplateId) {
    startOptions.extension = fe.build(profileId, profile.fingerprintTemplateId);
  }
  if (profile.url) startOptions.url = profile.url;
  // TODO: resolve proxyId to actual proxy URL via proxyManager

  // Ensure container is running
  let info = cm.containers.get(pid);
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
}

/**
 * Wrapper for browser operation endpoints.
 * Handles: profile check, ensureReady, idle timer reset, error classification.
 */
function browserOp(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
      // Reset idle timer on success (only if response was sent successfully)
      resetIdleTimer(req.params.id);
    } catch (err) {
      const apiErr = classifyError(err);
      res.status(apiErr.status).json({ ok: false, error: apiErr.message });
    }
  };
}

// --- Browser operations ---

async function listBrowsers(req, res) {
  try {
    let list = await cm.list();
    // Enrich with profile info and support type filter
    const typeFilter = req.query.type;
    list = list.map((b) => {
      const profile = ps.get(b.profileId);
      return { ...b, name: profile?.name, type: profile?.type };
    });
    if (typeFilter) {
      list = list.filter((b) => b.type === typeFilter);
    }
    res.json({ ok: true, browsers: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function navigate(req, res) {
  const { url } = req.body;
  if (!url) throw new ApiError(400, 'url is required');

  const pid = String(req.params.id);
  await ensureConnected(pid);
  const page = await bc.getMainPage(pid);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  res.json({ ok: true, url: page.url() });
}

async function execute(req, res) {
  const { script } = req.body;
  if (!script) throw new ApiError(400, 'script is required');

  const pid = String(req.params.id);
  await ensureConnected(pid);
  const page = await bc.getMainPage(pid);
  const wrapped = `(async () => { ${script} })()`;
  const result = await page.evaluate(wrapped);
  res.json({ ok: true, result });
}

async function getCookies(req, res) {
  const pid = String(req.params.id);
  await ensureConnected(pid);
  const page = await bc.getMainPage(pid);
  const client = await page.createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  await client.detach();
  res.json({ ok: true, cookies });
}

async function screenshot(req, res) {
  const pid = String(req.params.id);
  await ensureConnected(pid);
  const page = await bc.getMainPage(pid);
  const fullPage = req.body?.full_page || false;
  const image = await page.screenshot({ encoding: 'base64', fullPage });
  res.json({ ok: true, image });
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
  const page = await bc.getPage(pid, req.params.pageId);
  const wrapped = `(async () => { ${script} })()`;
  const result = await page.evaluate(wrapped);
  res.json({ ok: true, result });
}

async function pageScreenshot(req, res) {
  const pid = String(req.params.id);
  await ensureConnected(pid);
  const page = await bc.getPage(pid, req.params.pageId);
  const fullPage = req.body?.full_page || false;
  const image = await page.screenshot({ encoding: 'base64', fullPage });
  res.json({ ok: true, image });
}

async function getVncUrl(req, res) {
  try {
    const profileId = String(req.params.id);
    const profile = ps.get(req.params.id);
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });

    let info = cm.containers.get(profileId);
    if (!info) {
      info = await cm.start(profileId);
    }
    resetIdleTimer(req.params.id);
    const host = req.hostname || 'localhost';
    res.json({ ok: true, url: `http://${host}:${info.vncPort}/vnc_lite.html?scale=true&autoconnect=true` });
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
    const profile = ps.update(req.params.id, req.body);
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });
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
    if (cm.containers.has(pid)) {
      const timer = idleTimers.get(profileId);
      if (timer) { clearTimeout(timer); idleTimers.delete(profileId); }
      await bc.disconnect(pid).catch(() => {});
      await cm.stop(pid).catch(() => {});
    }

    ps.remove(profileId);
    if (module.exports.onProfileDeleted) module.exports.onProfileDeleted(profileId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
}

module.exports = { mount, clearAllTimers };
