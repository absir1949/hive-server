const express = require('express');
const api = require('./lib/api');
const ContainerManager = require('./lib/containerManager');
const BrowserConnector = require('./lib/browserConnector');
const ProfileStore = require('./lib/profileStore');
const FingerprintEngine = require('./lib/fingerprintEngine');
const { keepAliveRunningProfile } = require('./lib/keepAlive');

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

async function keepAliveProfile(profile) {
  const profileId = String(profile.id);
  try {
    const result = await keepAliveRunningProfile({
      containerManager: cm,
      baseUrl: `http://127.0.0.1:${PORT}`,
      profile,
      onSuccess: (id) => api.dumpProfileCookies(id),
    });
    if (result.ran) console.log(`[KeepAlive] Profile ${profileId} → ${profile.url} ✓`);
  } catch (err) {
    console.error(`[KeepAlive] Profile ${profileId} error:`, err.message);
  }
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
    void keepAliveProfile(profile);
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
cm.recover().then(async () => {
  for (const profileId of [...cm.containers.keys()]) {
    try {
      await api.dumpProfileCookies(profileId);
    } catch (err) {
      console.error(`[Auth] Startup cookie dump failed for ${profileId}:`, err.message);
    }
  }
  try {
    await api.enforceRunningCapacity();
  } catch (err) {
    console.error('[Capacity] Failed to trim recovered browsers:', err.message);
  }
  // Recovered browsers must be idle-stop candidates from the start; without
  // this they survive until the next explicit request touches them.
  api.armIdleStopTimers();
  app.listen(PORT, () => {
    console.log(`Hive Server listening on port ${PORT}`);
    initKeepAlive();
    // Cap enforcement must hold against Docker truth, not just cold starts.
    // Collection pages and VNC leases stay protected; LRU others get dumped
    // and stopped down to MAX_RUNNING_BROWSERS.
    const capacitySweep = setInterval(() => {
      api.enforceRunningCapacity().catch((err) => {
        console.error('[Capacity] Sweep failed:', err.message);
      });
    }, 60 * 1000);
    capacitySweep.unref();
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
