const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SERVER = config.serverUrl;

let tray = null;
let quickPickerWindow = null;

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

// --- Tray ---

function createTray() {
  // Use a simple template icon (macOS will auto-handle dark/light mode)
  const iconPath = path.join(__dirname, 'IconTemplate.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Fallback: create a simple 16x16 icon
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
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Server 离线 (${SERVER})`, enabled: false },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    return;
  }

  const runningIds = new Set(browsers.filter(b => b.status === 'running').map(b => b.profileId));

  const running = profiles.filter(p => runningIds.has(String(p.id)));
  const stopped = profiles.filter(p => !runningIds.has(String(p.id)));

  const menuTemplate = [];

  // Running
  if (running.length > 0) {
    menuTemplate.push({ label: '运行中', enabled: false });
    for (const p of running) {
      menuTemplate.push({
        label: `  🟢 ${p.name}`,
        click: () => openVnc(p.id),
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
    { label: '退出', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

// --- Actions ---

async function openVnc(profileId) {
  try {
    const { ok, url } = await api('GET', `/browsers/${profileId}/vnc`);
    if (ok && url) {
      // Replace hostname with server's hostname (vnc URL uses request hostname)
      const serverHost = new URL(SERVER).hostname;
      const vncUrl = url.replace(/\/\/[^:\/]+/, `//${serverHost}`);
      shell.openExternal(vncUrl);
    }
  } catch (e) {
    console.error('[Client] Failed to open VNC:', e.message);
  }
}

async function startAndOpenVnc(profile) {
  try {
    await api('POST', `/browsers/${profile.id}/navigate`, { url: profile.url });
    await openVnc(profile.id);
    updateTrayMenu();
  } catch (e) {
    console.error('[Client] Failed to start profile:', e.message);
  }
}

// --- Dialogs ---

function showAddProfileDialog() {
  const win = new BrowserWindow({
    width: 360,
    height: 180,
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

ipcMain.handle('profile:add', async (_, name, url) => {
  const res = await api('POST', '/profiles', { name, url });
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
  const runningIds = new Set(browsers.filter(b => b.status === 'running').map(b => b.profileId));
  return profiles.map(p => ({
    ...p,
    isRunning: runningIds.has(String(p.id)),
  }));
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
