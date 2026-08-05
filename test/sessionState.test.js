const test = require('node:test');
const assert = require('node:assert/strict');
const { isInteractiveBrowser } = require('../client/sessionState');
const { normalizeServerUrl } = require('../client/configUtils');

test('client marks only running VNC browsers as interactive', () => {
  assert.equal(isInteractiveBrowser({ status: 'running', browserMode: 'vnc' }), true);
  assert.equal(isInteractiveBrowser({ status: 'running', browserMode: 'headless' }), false);
  assert.equal(isInteractiveBrowser({ status: 'stopped', browserMode: 'vnc' }), false);
  assert.equal(isInteractiveBrowser(null), false);
});

test('server URL settings normalize a root HTTP(S) URL and reject path mistakes', () => {
  assert.equal(normalizeServerUrl(' http://192.168.2.122:37568/ '), 'http://192.168.2.122:37568');
  assert.equal(normalizeServerUrl('https://example.com'), 'https://example.com');
  assert.throws(() => normalizeServerUrl('192.168.2.122:37568'), /格式不正确/);
  assert.throws(() => normalizeServerUrl('http://example.com/api'), /不能包含路径/);
  assert.throws(() => normalizeServerUrl('http://example.com/?token=1'), /不能包含路径或参数/);
});
