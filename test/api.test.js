const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const api = require('../lib/api');

function request(server, path) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${path}`);
}

test('headless profiles reject VNC requests without starting a container', async () => {
  const app = express();
  const cm = {
    containers: new Map(),
    async list() { return []; },
  };
  const ps = {
    get() { return { id: 1, browserMode: 'headless' }; },
  };
  api.mount(app, {
    cm,
    bc: {},
    ps,
    fe: {},
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await request(server, '/browsers/1/vnc');
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.ok, false);
    assert.match(body.error, /headless mode/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
