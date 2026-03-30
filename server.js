const express = require('express');
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
app.use(express.json());

// Mount API routes
api.mount(app, { cm, bc, ps, fe });

// Recover running containers from previous session
cm.recover().then(() => {
  app.listen(PORT, () => {
    console.log(`Hive Server listening on port ${PORT}`);
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  api.clearAllTimers();
  await bc.disconnectAll();
  await cm.shutdown();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
