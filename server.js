const express = require('express');
const http = require('http');
const api = require('./lib/api');
const ContainerManager = require('./lib/containerManager');
const BrowserConnector = require('./lib/browserConnector');
const ProfileStore = require('./lib/profileStore');
const FingerprintEngine = require('./lib/fingerprintEngine');

const PORT = process.env.PORT || 37568;

const cm = new ContainerManager();
const bc = new BrowserConnector();
const ps = new ProfileStore();
const fe = new FingerprintEngine();

const app = express();
app.use(express.json({ limit: '20mb' }));

// Mount API routes
api.mount(app, { cm, bc, ps, fe });

// --- Keep-alive ---
// profileId → setInterval handle
const keepAliveTimers = new Map();

function keepAliveNavigate(profileId, url) {
  const postData = JSON.stringify({ url });
  const req = http.request(`http://127.0.0.1:${PORT}/browsers/${profileId}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
  }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      const ok = res.statusCode === 200;
      console.log(`[KeepAlive] Profile ${profileId} → ${url} ${ok ? '✓' : '✗ ' + body}`);
    });
  });
  req.on('error', (e) => console.error(`[KeepAlive] Profile ${profileId} error:`, e.message));
  req.end(postData);
}

function syncKeepAliveTimer(profileId) {
  // Clear existing
  const existing = keepAliveTimers.get(String(profileId));
  if (existing) {
    clearInterval(existing);
    keepAliveTimers.delete(String(profileId));
  }

  const profile = ps.get(profileId);
  if (!profile || !profile.keepAliveInterval || profile.keepAliveInterval <= 0) return;

  const intervalMs = profile.keepAliveInterval * 1000;
  const timer = setInterval(() => {
    keepAliveNavigate(profile.id, profile.url);
  }, intervalMs);
  timer.unref();
  keepAliveTimers.set(String(profileId), timer);
  console.log(`[KeepAlive] Profile ${profileId} (${profile.name}) every ${profile.keepAliveInterval}s`);
}

function initKeepAlive() {
  for (const profile of ps.list()) {
    syncKeepAliveTimer(profile.id);
  }
}

function clearAllKeepAlive() {
  for (const [, timer] of keepAliveTimers) {
    clearInterval(timer);
  }
  keepAliveTimers.clear();
}

// Expose for api.js to call when profiles change
api.onProfileChanged = (profileId) => syncKeepAliveTimer(profileId);
api.onProfileDeleted = (profileId) => {
  const existing = keepAliveTimers.get(String(profileId));
  if (existing) {
    clearInterval(existing);
    keepAliveTimers.delete(String(profileId));
  }
};

// Recover running containers from previous session, then start
cm.recover().then(() => {
  app.listen(PORT, () => {
    console.log(`Hive Server listening on port ${PORT}`);
    initKeepAlive();
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  clearAllKeepAlive();
  api.clearAllTimers();
  await bc.disconnectAll();
  await cm.shutdown();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
