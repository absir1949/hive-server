const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const AuthStore = require('../lib/authStore');

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-auth-'));
  return { store: new AuthStore({ dataDir }), dataDir };
}

test('save and load cookies for a profile', () => {
  const { store, dataDir } = tempStore();
  const cookies = [
    { name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com', path: '/', session: true, httpOnly: false, secure: true, sameSite: 'Lax' },
  ];

  store.save('29', cookies);
  assert.equal(fs.existsSync(path.join(dataDir, '29', 'auth-cookies.json')), true);
  assert.deepEqual(store.load('29'), cookies);
});

test('load returns null when no dump exists', () => {
  const { store } = tempStore();
  assert.equal(store.load('missing'), null);
});

test('toSetCookies keeps session vs persistent fields CDP accepts', () => {
  const cookies = AuthStore.toSetCookies([
    {
      name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com', path: '/',
      session: true, expires: -1, httpOnly: false, secure: true, sameSite: 'Lax',
      size: 12, priority: 'Medium', sourcePort: 443,
    },
    {
      name: 'wxuin', value: '1', domain: 'fuwu.weixin.qq.com', path: '/',
      session: false, expires: 1817714346, httpOnly: false, secure: false, sameSite: 'None',
    },
  ]);

  assert.deepEqual(cookies, [
    {
      name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com', path: '/',
      httpOnly: false, secure: true, sameSite: 'Lax', session: true,
    },
    {
      name: 'wxuin', value: '1', domain: 'fuwu.weixin.qq.com', path: '/',
      httpOnly: false, secure: false, sameSite: 'None', expires: 1817714346,
    },
  ]);
});
