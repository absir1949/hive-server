const test = require('node:test');
const assert = require('node:assert/strict');
const { keepAliveInBackground, keepAliveRunningProfile } = require('../lib/keepAlive');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('keep-alive loads and closes a background page without navigating the foreground', async () => {
  const requests = [];
  const fetchImpl = async (endpoint, options) => {
    requests.push({ endpoint, options });
    if (endpoint.endsWith('/pages/new')) {
      return jsonResponse(200, { ok: true, pageId: 'page/7' });
    }
    return jsonResponse(200, { ok: true });
  };

  await keepAliveInBackground({
    baseUrl: 'http://127.0.0.1:3000/',
    profileId: 'shop 1',
    url: 'https://store.weixin.qq.com/shop/home',
    fetchImpl,
  });

  assert.deepEqual(requests.map((request) => request.endpoint), [
    'http://127.0.0.1:3000/browsers/shop%201/pages/new',
    'http://127.0.0.1:3000/browsers/shop%201/pages/page%2F7/close',
  ]);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    url: 'https://store.weixin.qq.com/shop/home',
  });
  assert.equal(requests.some((request) => request.endpoint.endsWith('/navigate')), false);
});

test('keep-alive reports background page creation failures without issuing a close', async () => {
  const requests = [];
  const fetchImpl = async (endpoint) => {
    requests.push(endpoint);
    return jsonResponse(503, { error: 'browser unavailable' });
  };

  await assert.rejects(
    keepAliveInBackground({
      baseUrl: 'http://127.0.0.1:3000',
      profileId: '1',
      url: 'https://example.com',
      fetchImpl,
    }),
    /browser unavailable/,
  );
  assert.deepEqual(requests, ['http://127.0.0.1:3000/browsers/1/pages/new']);
});

test('keep-alive never starts or calls a stopped Profile', async () => {
  let statusCalls = 0;
  let fetchCalls = 0;
  const containerManager = {
    containers: new Map(),
    async status() {
      statusCalls += 1;
      return 'running';
    },
  };

  const result = await keepAliveRunningProfile({
    containerManager,
    baseUrl: 'http://127.0.0.1:3000',
    profile: { id: '1', url: 'https://example.com' },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
  });

  assert.deepEqual(result, { ran: false });
  assert.equal(statusCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('keep-alive skips a tracked browser that Docker reports stopped', async () => {
  let fetchCalls = 0;
  const containerManager = {
    containers: new Map([['1', { browserMode: 'vnc' }]]),
    async status() { return 'stopped'; },
  };

  const result = await keepAliveRunningProfile({
    containerManager,
    baseUrl: 'http://127.0.0.1:3000',
    profile: { id: '1', url: 'https://example.com' },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not fetch');
    },
  });

  assert.deepEqual(result, { ran: false });
  assert.equal(fetchCalls, 0);
});
