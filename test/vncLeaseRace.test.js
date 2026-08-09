const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.VNC_LEASE_TTL_MS = '250';
const api = require('../lib/api');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function request(server, path, { method = 'GET', body } = {}) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('an obsolete VNC timeout cannot revoke a lease renewed while queued', async () => {
  const operationStarted = deferred();
  const releaseOperation = deferred();
  let disableCalls = 0;

  const cm = {
    containers: new Map(),
    async list() {
      return [...this.containers.entries()].map(([profileId, info]) => ({
        profileId,
        status: 'running',
        ...info,
      }));
    },
    async status(profileId) {
      return this.containers.has(String(profileId)) ? 'running' : 'not_found';
    },
    async start(profileId, options) {
      const info = { browserMode: options.browserMode, cdpPort: 9317, vncPort: 6117 };
      this.containers.set(String(profileId), info);
      return info;
    },
    async stop(profileId) { this.containers.delete(String(profileId)); },
    async enableVncAccess() {},
    async disableVncAccess() { disableCalls += 1; },
  };
  const ps = {
    get(id) { return String(id) === '1' ? { id: 1, name: 'test' } : null; },
    list() { return [{ id: 1, name: 'test' }]; },
  };
  const connected = new Set();
  const bc = {
    get(id) { return connected.has(String(id)) ? true : null; },
    async connect(id) { connected.add(String(id)); },
    async disconnect(id) { connected.delete(String(id)); },
    async newPage() {
      operationStarted.resolve();
      await releaseOperation.promise;
      return { pageId: 'page-1' };
    },
    hasOpenPages() { return false; },
  };

  const app = express();
  app.use(express.json());
  api.mount(app, { cm, bc, ps, fe: {} });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const acquired = await request(server, '/browsers/1/vnc');
    const { leaseId } = await acquired.json();
    assert.equal(acquired.status, 200);

    const pageRequest = request(server, '/browsers/1/pages/new', {
      method: 'POST',
      body: { url: 'https://example.com' },
    });
    await operationStarted.promise;

    await new Promise((resolve) => setTimeout(resolve, 30));
    const heartbeatRequest = request(server, '/browsers/1/vnc/heartbeat', {
      method: 'POST',
      body: { leaseId },
    });

    // Keep the profile lock occupied until both the heartbeat and the original
    // timeout callback are queued, in that order.
    await new Promise((resolve) => setTimeout(resolve, 270));
    releaseOperation.resolve();

    assert.equal((await pageRequest).status, 200);
    assert.equal((await heartbeatRequest).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const list = await request(server, '/browsers');
    const body = await list.json();
    assert.equal(body.browsers[0].vncActive, true);
    assert.equal(disableCalls, 0);
  } finally {
    api.clearAllTimers();
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
