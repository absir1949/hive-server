const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const api = require('../lib/api');

async function startApi({
  profile = { id: 1, name: 'test' },
  onStart,
  onStop,
  onNewPage,
  enableVncErrorAt,
  disableVncError,
} = {}) {
  const vncAccessEvents = [];
  let enableVncCalls = 0;
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
    async enableVncAccess(profileId) {
      enableVncCalls += 1;
      vncAccessEvents.push(`enable:${profileId}`);
      if (enableVncCalls === enableVncErrorAt) throw new Error('control command failed');
    },
    async disableVncAccess(profileId) {
      vncAccessEvents.push(`disable:${profileId}`);
      if (disableVncError) throw disableVncError;
      return true;
    },
  };
  const ps = {
    get(id) { return String(id) === String(profile.id) ? profile : null; },
    list() { return [profile]; },
    create() { return profile; },
    update() { return profile; },
    remove() { return true; },
  };
  const connected = new Set();
  const pages = new Map();
  let nextPageId = 1;
  const bc = {
    get(id) { return connected.has(String(id)) ? true : null; },
    async connect(id) { connected.add(String(id)); },
    async disconnect(id) {
      connected.delete(String(id));
      pages.delete(String(id));
    },
    async navigateMain() {},
    async newPage(id) {
      const pid = String(id);
      const pageId = `page-${nextPageId++}`;
      if (!pages.has(pid)) pages.set(pid, new Set());
      pages.get(pid).add(pageId);
      onNewPage?.(pid, pageId);
      return { pageId };
    },
    async closePage(id, pageId) { pages.get(String(id))?.delete(String(pageId)); },
    async evaluateOnPage() { return true; },
    hasOpenPages(id) { return (pages.get(String(id))?.size || 0) > 0; },
  };
  const app = express();
  app.use(express.json());
  api.mount(app, { cm, bc, ps, fe: {} });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, cm, bc, vncAccessEvents };
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

test('system profiles cannot be modified or deleted', async () => {
  const { server } = await startApi({ profile: { id: 'render', name: '系统渲染', type: 'render', system: true } });
  try {
    const listResponse = await request(server, '/profiles');
    assert.deepEqual((await listResponse.json()).profiles, []);

    const renderListResponse = await request(server, '/profiles?type=render');
    assert.equal((await renderListResponse.json()).profiles[0].id, 'render');

    const updateResponse = await request(server, '/profiles/render', {
      method: 'PUT',
      body: { name: 'changed' },
    });
    assert.equal(updateResponse.status, 409);

    const deleteResponse = await request(server, '/profiles/render', { method: 'DELETE' });
    assert.equal(deleteResponse.status, 409);
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

test('VNC reuses one Chrome for background collection and release keeps it until idle', async () => {
  const startedModes = [];
  const stopped = [];
  const { server, vncAccessEvents } = await startApi({
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
    assert.deepEqual(vncAccessEvents, ['enable:1']);
    assert.deepEqual(startedModes, ['headless', 'vnc']);
    assert.deepEqual(stopped, ['1']);

    const foregroundNavigation = await request(server, '/browsers/1/navigate', {
      method: 'POST',
      body: { url: 'https://example.com' },
    });
    assert.equal(foregroundNavigation.status, 409);

    const scopedExecution = await request(server, '/browsers/1/execute', {
      method: 'POST',
      body: {
        script: 'location.href = "https://example.com"; return true;',
        url_pattern: 'store.weixin.qq.com',
      },
    });
    assert.equal(scopedExecution.status, 409);

    const blocked = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(blocked.status, 409);

    const collectionPage = await request(server, '/browsers/1/pages/new', {
      method: 'POST',
      body: { url: 'https://store.weixin.qq.com/shop/home' },
    });
    assert.equal(collectionPage.status, 200);
    const collectionPageBody = await collectionPage.json();
    assert.ok(collectionPageBody.pageId);
    assert.deepEqual(startedModes, ['headless', 'vnc']);

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
    assert.equal(releaseBody.status, 'running');
    assert.equal(releaseBody.browserMode, 'vnc');
    assert.equal(releaseBody.resumedBrowserMode, null);
    assert.deepEqual(vncAccessEvents, ['enable:1', 'disable:1']);
    assert.deepEqual(startedModes, ['headless', 'vnc']);
    assert.deepEqual(stopped, ['1']);

    const modeSwitchDuringCollection = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(modeSwitchDuringCollection.status, 409);
    assert.deepEqual(stopped, ['1']);

    const closeCollectionPage = await request(server, `/browsers/1/pages/${collectionPageBody.pageId}/close`, {
      method: 'POST',
    });
    assert.equal(closeCollectionPage.status, 200);

    const nextCollection = await request(server, '/browsers/1/pages/new', {
      method: 'POST',
      body: { url: 'https://store.weixin.qq.com/shop/home' },
    });
    assert.equal(nextCollection.status, 200);
    assert.deepEqual(startedModes, ['headless', 'vnc']);
  } finally {
    await closeApi(server);
  }
});

test('opening VNC cannot stop an active Headless collection page', async () => {
  const startedModes = [];
  const stopped = [];
  const { server } = await startApi({
    onStart: (_, options) => startedModes.push(options.browserMode),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    const page = await request(server, '/browsers/1/pages/new', {
      method: 'POST',
      body: { url: 'https://store.weixin.qq.com/shop/home' },
    });
    assert.equal(page.status, 200);

    const response = await request(server, '/browsers/1/vnc');
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.match(body.error, /active collection/);
    assert.deepEqual(startedModes, ['headless']);
    assert.deepEqual(stopped, []);
  } finally {
    await closeApi(server);
  }
});

test('browser list exposes the VNC lease separately from the runtime mode', async () => {
  const { server } = await startApi();
  try {
    const vnc = await request(server, '/browsers/1/vnc');
    const vncBody = await vnc.json();

    const activeList = await request(server, '/browsers');
    const activeBody = await activeList.json();
    assert.equal(activeBody.browsers[0].browserMode, 'vnc');
    assert.equal(activeBody.browsers[0].vncActive, true);

    await request(server, '/browsers/1/vnc/release', {
      method: 'POST',
      body: { leaseId: vncBody.leaseId },
    });
    const idleList = await request(server, '/browsers');
    const idleBody = await idleList.json();
    assert.equal(idleBody.browsers[0].browserMode, 'vnc');
    assert.equal(idleBody.browsers[0].vncActive, false);
  } finally {
    await closeApi(server);
  }
});

test('VNC lease remains active when access revocation fails', async () => {
  const { server } = await startApi({ disableVncError: new Error('control command failed') });
  try {
    const vnc = await request(server, '/browsers/1/vnc');
    const vncBody = await vnc.json();
    const release = await request(server, '/browsers/1/vnc/release', {
      method: 'POST',
      body: { leaseId: vncBody.leaseId },
    });
    assert.equal(release.status, 503);

    const list = await request(server, '/browsers');
    const body = await list.json();
    assert.equal(body.browsers[0].vncActive, true);
  } finally {
    await closeApi(server);
  }
});

test('failed VNC lease reacquire revokes access and clears the old lease', async () => {
  const { server, cm, vncAccessEvents } = await startApi({ enableVncErrorAt: 2 });
  try {
    const first = await request(server, '/browsers/1/vnc');
    const firstBody = await first.json();
    assert.equal(first.status, 200);

    const reacquire = await request(
      server,
      `/browsers/1/vnc?leaseId=${encodeURIComponent(firstBody.leaseId)}`,
    );
    assert.equal(reacquire.status, 503);
    assert.equal(cm.containers.has('1'), true);
    assert.deepEqual(vncAccessEvents, ['enable:1', 'enable:1', 'disable:1']);

    const list = await request(server, '/browsers');
    const listBody = await list.json();
    assert.equal(listBody.browsers[0].vncActive, false);

    const replacement = await request(server, '/browsers/1/vnc');
    const replacementBody = await replacement.json();
    assert.equal(replacement.status, 200);
    assert.notEqual(replacementBody.leaseId, firstBody.leaseId);
  } finally {
    await closeApi(server);
  }
});

test('failed VNC lease reacquire stays tracked when revocation also fails', async () => {
  const { server } = await startApi({
    enableVncErrorAt: 2,
    disableVncError: new Error('cleanup command failed'),
  });
  try {
    const first = await request(server, '/browsers/1/vnc');
    const firstBody = await first.json();

    const reacquire = await request(
      server,
      `/browsers/1/vnc?leaseId=${encodeURIComponent(firstBody.leaseId)}`,
    );
    assert.equal(reacquire.status, 503);

    const list = await request(server, '/browsers');
    const listBody = await list.json();
    assert.equal(listBody.browsers[0].vncActive, true);
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
