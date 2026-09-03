const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { isInteractiveBrowser } = require('./sessionState');
const { normalizeServerUrl } = require('./configUtils');

// Config lives in userData (writable) so it survives packing into app.asar (read-only).
// On first run we seed it from the bundled default config.json next to main.js.
function loadConfig() {
  const userConfigPath = path.join(app.getPath('userData'), 'config.json');
  try {
    return JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
  } catch {
    // First run: copy the bundled default into userData so it becomes writable.
    const defaultConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    try { fs.writeFileSync(userConfigPath, JSON.stringify(defaultConfig, null, 2)); } catch {}
    return defaultConfig;
  }
}

const config = loadConfig();
let SERVER = config.serverUrl || '';
const VNC_BACKGROUND_TIMEOUT_MS = Number(config.vncBackgroundTimeoutMs) || 5 * 60 * 1000;

let tray = null;
let quickPickerWindow = null;

// profileId → BrowserWindow (VNC windows)
const vncWindows = new Map();

// --- Server API helpers ---

async function api(method, endpoint, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SERVER}${endpoint}`, opts);
  return res.json();
}

async function getProfiles() {
  const { ok, profiles } = await api('GET', '/profiles');
  return ok ? profiles : [];
}

async function getBrowsers() {
  const { ok, browsers } = await api('GET', '/browsers');
  return ok ? browsers : [];
}

// --- VNC window management ---

function getVncSession(profileId, leaseId) {
  const serverHost = new URL(SERVER).hostname;
  const query = leaseId ? `?leaseId=${encodeURIComponent(leaseId)}` : '';
  return api('GET', `/browsers/${profileId}/vnc${query}`).then((result) => {
    if (result.ok && result.url && result.leaseId) {
      return {
        ...result,
        url: result.url.replace(/\/\/[^:\/]+/, `//${serverHost}`),
      };
    }
    // Surface the server's reason (e.g. 409 active collection) instead of
    // swallowing it — a silent null here makes the window just not open.
    return { error: result.error || `VNC 请求失败（HTTP ${result.status || '未知'}）`, pages: result.pages || null };
  });
}

function heartbeatVnc(profileId, leaseId) {
  return api('POST', `/browsers/${profileId}/vnc/heartbeat`, { leaseId });
}

function releaseVnc(profileId, leaseId) {
  return api('POST', `/browsers/${profileId}/vnc/release`, { leaseId });
}

async function releaseVncWithRetry(profileId, leaseId, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await releaseVnc(profileId, leaseId);
      if (result.ok) return result;
      lastError = new Error(result.error || `VNC release failed with status ${result.status || 'unknown'}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError || new Error('VNC release failed');
}

async function waitForVnc(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Check both HTTP (page loads) and that websockify is proxying
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function pasteLocalClipboardToRemote(profileId) {
  const text = clipboard.readText();
  if (!text) return;
  const result = await api('POST', `/browsers/${profileId}/clipboard/paste`, { text });
  if (!result.ok) console.error('[Clipboard] paste failed:', result.error);
}

function attachVncClipboardShortcuts(win, profileId) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const isShortcut = input.meta || input.control;
    if (!isShortcut || input.alt) return;

    // Prevent ALL modifier combo keys from reaching noVNC.
    // Without this, the Meta/Ctrl keyDown reaches X11 but the target key
    // (V/C/U) doesn't, leaving the modifier "stuck" in X11 and breaking
    // all subsequent mouse clicks (Super+Click = window drag in openbox).
    event.preventDefault();

    if (key === 'v') {
      pasteLocalClipboardToRemote(profileId).catch((err) => {
        console.error('[Clipboard] paste failed:', err.message);
      });
    } else if (key === 'c' && !input.shift) {
      api('POST', `/browsers/${profileId}/clipboard/copy`).then((result) => {
        if (result.ok && result.text) clipboard.writeText(result.text);
      }).catch((err) => {
        console.error('[Clipboard] copy failed:', err.message);
      });
    } else if (key === 'u') {
      uploadLocalFileToRemote(profileId, win).catch((err) => {
        console.error('[FileUpload] failed:', err.message);
      });
    }
  });
}

async function uploadLocalFileToRemote(profileId, win) {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(win, {
    title: '选择要上传的文件',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;

  const filePath = result.filePaths[0];
  const fileName = path.basename(filePath);
  const fileData = fs.readFileSync(filePath).toString('base64');
  console.log('[FileUpload] uploading %s (%d bytes base64)', fileName, fileData.length);

  const res = await api('POST', `/browsers/${profileId}/upload-file`, { fileName, fileData });
  console.log('[FileUpload] server response:', JSON.stringify(res));
  if (!res.ok) {
    console.error('[FileUpload] server error:', res.error);
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '上传失败',
      message: res.error || '文件上传失败',
      buttons: ['确定'],
    });
  }
}

async function openVnc(profileId, profileName) {
  // Already open — bring to front
  const existing = vncWindows.get(String(profileId));
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }

  let vncSession;
  try {
    vncSession = await getVncSession(profileId);
  } catch (err) {
    vncSession = { error: `无法连接服务器 ${SERVER}：${err.message}` };
  }
  if (!vncSession || vncSession.error) {
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'warning',
      title: '无法打开 VNC',
      message: vncSession?.error || `无法获取 ${profileName || 'Profile ' + profileId} 的 VNC 会话`,
      buttons: ['确定'],
    });
    return;
  }
  const { url: vncUrl, leaseId } = vncSession;

  // Wait for VNC to be ready, retry up to 60s with user feedback
  const ready = await waitForVnc(vncUrl, 60000);
  if (!ready) {
    await releaseVnc(profileId, leaseId).catch(() => {});
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'warning',
      title: '连接超时',
      message: `无法连接到 ${profileName || 'Profile ' + profileId}，请稍后重试。`,
      buttons: ['确定'],
    });
    return;
  }

  const title = profileName || `Profile ${profileId}`;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title,
    webPreferences: {
      contextIsolation: true,
    },
  });

  attachVncClipboardShortcuts(win, profileId);

  win.loadURL(vncUrl);

  // Page <title> overrides window title — force it back after load
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(title);
  });

  vncWindows.set(String(profileId), win);

  // Hold a short-lived VNC lease while the client window is open. If the
  // client crashes, the server releases the lease after the heartbeat TTL.
  let backgroundTimer = null;
  let releasePromise = null;
  let allowWindowClose = false;

  function clearBackgroundTimer() {
    if (backgroundTimer) {
      clearTimeout(backgroundTimer);
      backgroundTimer = null;
    }
  }

  function cancelBackgroundRelease() {
    clearBackgroundTimer();
  }

  function scheduleBackgroundRelease() {
    clearBackgroundTimer();
    backgroundTimer = setTimeout(async () => {
      backgroundTimer = null;
      console.log(`[VNC] ${profileId} window stayed in background for ${VNC_BACKGROUND_TIMEOUT_MS / 1000}s; releasing lease`);
      const released = await closeAfterRelease('background timeout');
      if (!released) {
        // Keep the lease and heartbeat alive when the server cannot release it.
        // A later retry avoids leaving a hidden window orphaned permanently.
        scheduleBackgroundRelease();
      }
    }, VNC_BACKGROUND_TIMEOUT_MS);
  }

  async function releaseLease(reason) {
    if (!releasePromise) {
      clearBackgroundTimer();
      releasePromise = releaseVncWithRetry(profileId, leaseId)
        .then((result) => {
          clearInterval(heartbeatInterval);
          console.log(`[VNC] ${profileId} lease released (${reason}): ${result.status || 'stopped'}`);
          return result;
        })
        .catch((err) => {
          // Keep sending heartbeats so a transient network failure does not
          // turn a still-open VNC window into an orphaned lease.
          releasePromise = null;
          console.error(`[VNC] ${profileId} lease release failed after retry:`, err.message);
          throw err;
        });
    }
    return releasePromise;
  }

  async function closeAfterRelease(reason) {
    try {
      await releaseLease(reason);
    } catch {
      return false;
    }

    allowWindowClose = true;
    if (!win.isDestroyed()) win.close();
    return true;
  }

  function closeAfterLeaseLoss(error) {
    clearInterval(heartbeatInterval);
    clearBackgroundTimer();
    allowWindowClose = true;
    console.error('[VNC] lease is no longer valid:', error);
    if (!win.isDestroyed()) win.close();
  }

  const heartbeatInterval = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(heartbeatInterval);
      return;
    }
    heartbeatVnc(profileId, leaseId).then((result) => {
      if (!result.ok) {
        closeAfterLeaseLoss(result.error || 'heartbeat rejected');
      }
    }).catch((err) => {
      // Keep retrying on transport failures. If the server cannot receive
      // heartbeats, its lease timer will revoke the noVNC connection.
      console.error('[VNC] lease heartbeat failed:', err.message);
    });
  }, 30 * 1000);

  win.on('focus', cancelBackgroundRelease);
  win.on('show', cancelBackgroundRelease);
  win.on('restore', cancelBackgroundRelease);
  win.on('blur', scheduleBackgroundRelease);
  win.on('hide', scheduleBackgroundRelease);
  win.on('minimize', scheduleBackgroundRelease);

  // Do not let the Electron window disappear before the server has released
  // the interactive lease. Chrome stays alive for background collection and
  // authentication continuity until an explicit browser stop.
  win.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    closeAfterRelease('window closing').then((released) => {
      if (!released) updateTrayMenu();
    });
  });

  win.on('closed', () => {
    vncWindows.delete(String(profileId));
    updateTrayMenu();
    if (!allowWindowClose) {
      // Fallback for programmatic destruction or an unexpected close path.
      releaseLease('window closed').catch(() => {}).finally(() => updateTrayMenu());
    }
  });
}

async function startAndOpenVnc(profile) {
  try {
    // Already open — bring to front
    const existing = vncWindows.get(String(profile.id));
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }

    // Opening VNC acquires the interactive lease and handles the mode switch.
    await openVnc(profile.id, profile.name);
    updateTrayMenu();
  } catch (e) {
    console.error('[Client] Failed to start profile:', e.message);
  }
}

// --- Tray ---

function createTray() {
  const iconPath = path.join(__dirname, 'IconTemplate.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Hive Server');
  updateTrayMenu();
}

async function updateTrayMenu() {
  if (!tray) return;

  let profiles, browsers;
  try {
    [profiles, browsers] = await Promise.all([getProfiles(), getBrowsers()]);
  } catch (e) {
    const unconfigured = !SERVER;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: unconfigured ? '未配置服务器' : `Server 离线 (${SERVER})`, enabled: false },
      { type: 'separator' },
      { label: unconfigured ? '添加服务器地址...' : '修改服务器地址...', click: showServerSettingsDialog },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    return;
  }

  const runningByProfile = new Map(
    browsers.filter(isInteractiveBrowser)
      .map(b => [String(b.profileId), b]),
  );

  const running = profiles.filter(p => runningByProfile.has(String(p.id)));
  const stopped = profiles.filter(p => !runningByProfile.has(String(p.id)));

  const menuTemplate = [];

  // Running
  if (running.length > 0) {
    menuTemplate.push({ label: '运行中', enabled: false });
    for (const p of running) {
      const hasWindow = vncWindows.has(String(p.id)) && !vncWindows.get(String(p.id)).isDestroyed();
      menuTemplate.push({
        label: `  🟢 ${p.name}${hasWindow ? ' ●' : ''}`,
        click: () => openVnc(p.id, p.name),
      });
    }
    menuTemplate.push({ type: 'separator' });
  }

  // Stopped
  if (stopped.length > 0) {
    menuTemplate.push({ label: '未启动', enabled: false });
    for (const p of stopped) {
      menuTemplate.push({
        label: `  ⚪ ${p.name}`,
        click: () => startAndOpenVnc(p),
      });
    }
    menuTemplate.push({ type: 'separator' });
  }

  if (profiles.length === 0) {
    menuTemplate.push({ label: '暂无配置', enabled: false });
    menuTemplate.push({ type: 'separator' });
  }

  menuTemplate.push(
    { label: '添加配置...', click: showAddProfileDialog },
    { label: '管理配置...', click: showManageProfilesDialog },
    { type: 'separator' },
    { label: `服务器设置... (${new URL(SERVER).host})`, click: showServerSettingsDialog },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

// --- Dialogs ---

function showAddProfileDialog() {
  const win = new BrowserWindow({
    width: 360,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'add-profile.html'));
  win.on('closed', () => updateTrayMenu());
}

function showServerSettingsDialog() {
  const win = new BrowserWindow({
    width: 400,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'server-settings.html'));
  win.on('closed', () => updateTrayMenu());
}

function showManageProfilesDialog() {
  const win = new BrowserWindow({
    width: 400,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'manage-profiles.html'));
  win.on('closed', () => updateTrayMenu());
}

// --- Quick Picker ---

function showQuickPicker() {
  if (quickPickerWindow && !quickPickerWindow.isDestroyed()) {
    quickPickerWindow.close();
    quickPickerWindow = null;
    return;
  }

  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  quickPickerWindow = new BrowserWindow({
    width: 300,
    height: 400,
    x: Math.round((width - 300) / 2),
    y: Math.round(height * 0.2),
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  quickPickerWindow.loadFile(path.join(__dirname, 'renderer', 'quick-picker.html'));
  quickPickerWindow.once('ready-to-show', () => quickPickerWindow.show());
  quickPickerWindow.on('blur', () => {
    if (quickPickerWindow && !quickPickerWindow.isDestroyed()) quickPickerWindow.close();
  });
  quickPickerWindow.on('closed', () => { quickPickerWindow = null; });
}

// --- IPC handlers (renderer ↔ main) ---

ipcMain.handle('server:getUrl', async () => {
  return SERVER;
});

ipcMain.handle('server:setUrl', async (_, newUrl) => {
  let normalizedUrl;
  try {
    normalizedUrl = normalizeServerUrl(newUrl);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  for (const [profileId, win] of vncWindows) {
    if (win.isDestroyed()) {
      vncWindows.delete(profileId);
    } else {
      return { ok: false, error: '请先关闭 VNC 窗口，再修改服务器地址' };
    }
  }

  const configPath = path.join(app.getPath('userData'), 'config.json');
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  cfg.serverUrl = normalizedUrl;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  config.serverUrl = normalizedUrl;
  SERVER = normalizedUrl;
  updateTrayMenu();
  return { ok: true, serverUrl: normalizedUrl };
});

ipcMain.handle('profile:add', async (_, name, url, type, keepAlive) => {
  const res = await api('POST', '/profiles', {
    name,
    url,
    type: type || 'generic',
    keepAliveInterval: keepAlive === undefined ? 3600 : keepAlive,
  });
  updateTrayMenu();
  return res;
});

ipcMain.handle('profile:delete', async (_, profileId) => {
  const res = await api('DELETE', `/profiles/${profileId}`);
  updateTrayMenu();
  return res;
});

ipcMain.handle('profile:update', async (_, profileId, data) => {
  const res = await api('PUT', `/profiles/${profileId}`, data);
  updateTrayMenu();
  return res;
});

ipcMain.handle('profile:getAll', async () => {
  const [profiles, browsers] = await Promise.all([getProfiles(), getBrowsers()]);
  const activeBrowsers = new Map(
    browsers.filter(b => b.status === 'running').map(b => [String(b.profileId), b]),
  );
  return profiles.map((p) => {
    const browser = activeBrowsers.get(String(p.id));
    const isRunning = isInteractiveBrowser(browser);
    return {
      ...p,
      // The client represents active VNC leases. Background collection and a
      // released VNC runtime waiting for idle cleanup are both shown as idle.
      isRunning,
      activeBrowserMode: isRunning ? 'vnc' : null,
    };
  });
});

ipcMain.handle('profile:startOrActivate', async (_, profileId) => {
  const profiles = await getProfiles();
  const profile = profiles.find(p => p.id === profileId || String(p.id) === String(profileId));
  if (!profile) return { success: false };
  await startAndOpenVnc(profile);
  return { success: true };
});

// --- App lifecycle ---

// Hide dock icon — this is a menubar-only app
if (app.dock) app.dock.hide();

app.whenReady().then(function() {
  createTray();

  const ret = globalShortcut.register('CommandOrControl+Shift+S', () => {
    showQuickPicker();
  });
  if (!ret) {
    console.error('[Client] Failed to register global shortcut');
  } else {
    console.log('[Client] Global shortcut Cmd+Shift+S registered');
  }

  // Refresh tray every 30 seconds
  setInterval(() => updateTrayMenu(), 30000);

  console.log('[Client] Ready, server:', SERVER);
});

// Menubar app: don't quit when windows close
app.on('window-all-closed', function() {});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
});
