const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const api = require('../lib/api');

async function startApi({ profile = { id: 1, name: 'test' }, onStart, onStop } = {}) {
  const cm = {
    containers: new Map(),
    async list() { return []; },
    async status(profileId) {
      return this.containers.has(String(profileId)) ? 'running' : 'not_found';
    },
    async start(profileId, options) {
      const info = {
        browserMode: options.browserMode,
        cdpPort: 9317,
        vncPort: options.browserMode === 'vnc' ? 6117 : null,
      };
      this.containers.set(String(profileId), info);
      onStart?.(profileId, options);
      return info;
    },
    async stop(profileId) {
      this.containers.delete(String(profileId));
      onStop?.(profileId);
    },
  };
  const ps = {
    get(id) { return String(id) === String(profile.id) ? profile : null; },
    list() { return [profile]; },
    create() { return profile; },
    update() { return profile; },
    remove() { return true; },
  };
  const bc = {
    get() { return null; },
    async connect() {},
    async disconnect() {},
    async navigateMain() {},
  };
  const app = express();
  app.use(express.json());
  api.mount(app, { cm, bc, ps, fe: {} });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, cm };
}

async function request(server, path, { method = 'GET', body } = {}) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function closeApi(server) {
  api.clearAllTimers();
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test('start selects a runtime mode while the profile remains generic', async () => {
  const startedModes = [];
  const { server, cm } = await startApi({ onStart: (_, options) => startedModes.push(options.browserMode) });
  try {
    const response = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      ok: true,
      profileId: '1',
      status: 'running',
      browserMode: 'headless',
    });
    assert.deepEqual(startedModes, ['headless']);
    assert.equal(cm.containers.get('1').browserMode, 'headless');
  } finally {
    await closeApi(server);
  }
});

test('browser operations reuse the selected runtime mode', async () => {
  const startedModes = [];
  const { server } = await startApi({ onStart: (_, options) => startedModes.push(options.browserMode) });
  try {
    await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    const response = await request(server, '/browsers/1/navigate', {
      method: 'POST',
      body: { url: 'https://example.com' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(startedModes, ['headless']);
  } finally {
    await closeApi(server);
  }
});

test('browser operations default to Headless when no session was selected', async () => {
  const startedModes = [];
  const { server } = await startApi({ onStart: (_, options) => startedModes.push(options.browserMode) });
  try {
    const response = await request(server, '/browsers/1/navigate', {
      method: 'POST',
      body: { url: 'https://example.com' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(startedModes, ['headless']);
  } finally {
    await closeApi(server);
  }
});

test('VNC endpoint switches a generic profile into a VNC session', async () => {
  const startedModes = [];
  const stopped = [];
  const { server } = await startApi({
    onStart: (_, options) => startedModes.push(options.browserMode),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    const response = await request(server, '/browsers/1/vnc');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(body.url, /:6117\/vnc\.html/);
    assert.ok(body.leaseId);
    assert.deepEqual(startedModes, ['headless', 'vnc']);
    assert.deepEqual(stopped, ['1']);

    const blocked = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(blocked.status, 409);

    const heartbeat = await request(server, '/browsers/1/vnc/heartbeat', {
      method: 'POST',
      body: { leaseId: body.leaseId },
    });
    assert.equal(heartbeat.status, 200);

    const release = await request(server, '/browsers/1/vnc/release', {
      method: 'POST',
      body: { leaseId: body.leaseId },
    });
    const releaseBody = await release.json();
    assert.equal(release.status, 200);
    assert.equal(releaseBody.status, 'headless');
    assert.equal(releaseBody.resumedBrowserMode, 'headless');
    assert.deepEqual(startedModes, ['headless', 'vnc', 'headless']);
    assert.deepEqual(stopped, ['1', '1']);
  } finally {
    await closeApi(server);
  }
});

test('profile API rejects browserMode because mode belongs to the runtime', async () => {
  const { server } = await startApi();
  try {
    const response = await request(server, '/profiles', {
      method: 'POST',
      body: { name: 'collector', url: 'about:blank', browserMode: 'headless' },
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /belongs to POST \/browsers\/:id\/start/);
  } finally {
    await closeApi(server);
  }
});
