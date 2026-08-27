const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const api = require('../lib/api');
const AuthStore = require('../lib/authStore');

function tempAuthStore() {
  return new AuthStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-api-auth-')) });
}

async function startApi({
  profile = { id: 1, name: 'test' },
  profiles,
  onStart,
  onStop,
  onNewPage,
  connectError,
  statusError,
  enableVncErrorAt,
  disableVncError,
  cookies = [],
  loginProbe = { href: 'https://example.com/', title: 'ok', text: 'ok' },
  authStore,
} = {}) {
  const vncAccessEvents = [];
  const restoredCookies = [];
  const navigated = [];
  let enableVncCalls = 0;
  const profileList = profiles || [profile];
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
      if (statusError) throw statusError;
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
    get(id) { return profileList.find((item) => String(item.id) === String(id)) || null; },
    list() { return profileList; },
    create() { return profile; },
    update() { return profile; },
    remove() { return true; },
  };
  const connected = new Set();
  const pages = new Map();
  let nextPageId = 1;
  const bc = {
    get(id) { return connected.has(String(id)) ? true : null; },
    async connect(id) {
      if (connectError) throw connectError;
      connected.add(String(id));
    },
    async disconnect(id) {
      connected.delete(String(id));
      pages.delete(String(id));
    },
    async navigateMain(id, url) { navigated.push({ id: String(id), url }); },
    async getCookiesMain() { return cookies; },
    async setCookiesMain(id, next) { restoredCookies.push({ id: String(id), cookies: next }); },
    async evaluateOnMain() { return loginProbe; },
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
  api.mount(app, { cm, bc, ps, fe: {}, authStore });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, cm, bc, vncAccessEvents, restoredCookies, navigated };
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

test('a CDP connection failure never stops the running authenticated browser', async () => {
  const startedModes = [];
  const stopped = [];
  const { server, cm } = await startApi({
    connectError: new Error('temporary CDP failure'),
    onStart: (_, options) => startedModes.push(options.browserMode),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    const response = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /without restarting it/);
    assert.deepEqual(startedModes, ['headless']);
    assert.deepEqual(stopped, []);
    assert.equal(cm.containers.get('1').browserMode, 'headless');
  } finally {
    await closeApi(server);
  }
});

test('a Docker status failure never treats a running browser as disposable', async () => {
  const stopped = [];
  const { server, cm } = await startApi({
    statusError: new Error('Docker API unavailable'),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    const started = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(started.status, 200);

    const response = await request(server, '/browsers/1/navigate', {
      method: 'POST',
      body: { url: 'https://example.com' },
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /left intact/);
    assert.deepEqual(stopped, []);
    assert.equal(cm.containers.has('1'), true);
  } finally {
    await closeApi(server);
  }
});

test('an explicit VNC request switches an idle Headless runtime to VNC', async () => {
  const startedModes = [];
  const stopped = [];
  const { server, vncAccessEvents } = await startApi({
    onStart: (_, options) => startedModes.push(options.browserMode),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    const headless = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(headless.status, 200);

    const response = await request(server, '/browsers/1/vnc');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.browserMode, 'vnc');
    assert.ok(body.leaseId);
    assert.match(body.url, /:6117\/vnc\.html/);
    assert.deepEqual(startedModes, ['headless', 'vnc']);
    assert.deepEqual(stopped, ['1']);
    assert.deepEqual(vncAccessEvents, ['enable:1']);
  } finally {
    await closeApi(server);
  }
});

test('a failed Headless status check cannot destroy the runtime during VNC open', async () => {
  const stopped = [];
  const { server, cm } = await startApi({
    statusError: new Error('Docker API unavailable'),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    const headless = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(headless.status, 200);

    const response = await request(server, '/browsers/1/vnc');
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /left intact/);
    assert.deepEqual(stopped, []);
    assert.equal(cm.containers.get('1').browserMode, 'headless');
  } finally {
    await closeApi(server);
  }
});

test('VNC release keeps one durable Chrome until an explicit stop', async () => {
  const startedModes = [];
  const stopped = [];
  const { server, vncAccessEvents } = await startApi({
    onStart: (_, options) => startedModes.push(options.browserMode),
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    const response = await request(server, '/browsers/1/vnc');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(body.url, /:6117\/vnc\.html/);
    assert.ok(body.leaseId);
    assert.deepEqual(vncAccessEvents, ['enable:1']);
    assert.deepEqual(startedModes, ['vnc']);
    assert.deepEqual(stopped, []);

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
    assert.deepEqual(startedModes, ['vnc']);

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
    assert.deepEqual(startedModes, ['vnc']);
    assert.deepEqual(stopped, []);

    const modeSwitchDuringCollection = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(modeSwitchDuringCollection.status, 409);
    assert.deepEqual(stopped, []);

    const closeCollectionPage = await request(server, `/browsers/1/pages/${collectionPageBody.pageId}/close`, {
      method: 'POST',
    });
    assert.equal(closeCollectionPage.status, 200);

    const modeSwitchWithoutCollection = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(modeSwitchWithoutCollection.status, 409);
    assert.match((await modeSwitchWithoutCollection.json()).error, /explicitly stop/);
    assert.deepEqual(stopped, []);

    const nextCollection = await request(server, '/browsers/1/pages/new', {
      method: 'POST',
      body: { url: 'https://store.weixin.qq.com/shop/home' },
    });
    assert.equal(nextCollection.status, 200);
    assert.deepEqual(startedModes, ['vnc']);

    const explicitStop = await request(server, '/browsers/1/stop', { method: 'POST' });
    assert.equal(explicitStop.status, 200);
    assert.deepEqual(stopped, ['1']);
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

test('stopping a browser dumps cookies before the container is removed', async () => {
  const authStore = tempAuthStore();
  const cookies = [
    { name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com', path: '/', session: true, httpOnly: false, secure: true, sameSite: 'Lax' },
  ];
  const { server } = await startApi({ cookies, authStore });
  try {
    await request(server, '/browsers/1/start', { method: 'POST', body: { browserMode: 'headless' } });
    const stop = await request(server, '/browsers/1/stop', { method: 'POST' });
    assert.equal(stop.status, 200);
    assert.equal(authStore.load('1')[0].name, 'biz_magic');
  } finally {
    await closeApi(server);
  }
});

test('cold start restores dumped cookies and reloads the profile URL', async () => {
  const authStore = tempAuthStore();
  authStore.save('1', [
    { name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com', path: '/', session: true, httpOnly: false, secure: true, sameSite: 'Lax' },
  ]);
  const profile = { id: 1, name: '原野小店', url: 'https://store.weixin.qq.com/shop/home' };
  const { server, restoredCookies, navigated } = await startApi({
    profile,
    authStore,
    loginProbe: { href: profile.url, title: '微信小店', text: '店铺管理 商品管理' },
  });
  try {
    const response = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    assert.equal(response.status, 200);
    assert.equal(restoredCookies[0].cookies[0].name, 'biz_magic');
    assert.deepEqual(navigated, [{ id: '1', url: profile.url }]);
  } finally {
    await closeApi(server);
  }
});

test('headless collection fails closed when restored cookies are not logged in', async () => {
  const authStore = tempAuthStore();
  authStore.save('1', [
    { name: 'biz_magic', value: 'stale', domain: 'store.weixin.qq.com', path: '/', session: true, httpOnly: false, secure: true, sameSite: 'Lax' },
  ]);
  const profile = { id: 1, name: '原野小店', url: 'https://store.weixin.qq.com/shop/home' };
  const { server } = await startApi({
    profile,
    authStore,
    loginProbe: { href: profile.url, title: '微信小店', text: '登录超时，请重新 登录' },
  });
  try {
    const response = await request(server, '/browsers/1/start', {
      method: 'POST',
      body: { browserMode: 'headless' },
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.needsLogin, true);
    assert.match(body.error, /needs login/);
  } finally {
    await closeApi(server);
  }
});

test('VNC start still succeeds when cookie restore is logged out so a human can re-login', async () => {
  const authStore = tempAuthStore();
  authStore.save('1', [
    { name: 'biz_magic', value: 'stale', domain: 'store.weixin.qq.com', path: '/', session: true, httpOnly: false, secure: true, sameSite: 'Lax' },
  ]);
  const profile = { id: 1, name: '原野小店', url: 'https://store.weixin.qq.com/shop/home' };
  const { server } = await startApi({
    profile,
    authStore,
    loginProbe: { href: profile.url, title: '微信小店', text: '登录超时，请重新 登录' },
  });
  try {
    const response = await request(server, '/browsers/1/vnc');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).browserMode, 'vnc');
    const list = await request(server, '/browsers');
    assert.equal((await list.json()).browsers[0].needsLogin, false);
  } finally {
    await closeApi(server);
  }
});

test('opening VNC dumps cookies before switching away from Headless', async () => {
  const authStore = tempAuthStore();
  const cookies = [
    { name: 'biz_token', value: 'tok', domain: 'store.weixin.qq.com', path: '/', session: true, httpOnly: true, secure: true, sameSite: 'Lax' },
  ];
  const { server } = await startApi({
    cookies,
    authStore,
    loginProbe: { href: 'https://store.weixin.qq.com/shop/home', title: '微信小店', text: '店铺管理' },
  });
  try {
    await request(server, '/browsers/1/start', { method: 'POST', body: { browserMode: 'headless' } });
    const vnc = await request(server, '/browsers/1/vnc');
    assert.equal(vnc.status, 200);
    assert.equal(authStore.load('1')[0].name, 'biz_token');
  } finally {
    await closeApi(server);
  }
});

test('starting over the running cap dumps and stops the least recently used browser', async () => {
  const previous = process.env.MAX_RUNNING_BROWSERS;
  process.env.MAX_RUNNING_BROWSERS = '1';
  const authStore = tempAuthStore();
  const stopped = [];
  const profiles = [
    { id: 1, name: 'one', url: 'about:blank' },
    { id: 2, name: 'two', url: 'about:blank' },
  ];
  const { server } = await startApi({
    profiles,
    authStore,
    cookies: [{ name: 'sid', value: '1', domain: 'example.com', path: '/', session: true }],
    onStop: (profileId) => stopped.push(String(profileId)),
  });
  try {
    assert.equal((await request(server, '/browsers/1/start', { method: 'POST', body: { browserMode: 'headless' } })).status, 200);
    const second = await request(server, '/browsers/2/start', { method: 'POST', body: { browserMode: 'headless' } });
    assert.equal(second.status, 200);
    assert.deepEqual(stopped, ['1']);
    assert.equal(authStore.load('1')[0].name, 'sid');
  } finally {
    if (previous === undefined) delete process.env.MAX_RUNNING_BROWSERS;
    else process.env.MAX_RUNNING_BROWSERS = previous;
    await closeApi(server);
  }
});

