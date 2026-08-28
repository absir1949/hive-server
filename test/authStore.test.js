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
  assert.equal(store.readDump('missing'), null);
});

test('readDump returns the saved timestamp alongside the cookies', () => {
  const { store } = tempStore();
  store.save('29', [
    { name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com', path: '/' },
  ]);

  const entry = store.readDump('29');
  assert.equal(entry.cookies[0].name, 'biz_magic');
  assert.equal(typeof entry.savedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(entry.savedAt)));
});

test('readDump tolerates a legacy raw-array dump without a timestamp', () => {
  const { store, dataDir } = tempStore();
  const file = path.join(dataDir, '7', 'auth-cookies.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ name: 'legacy', value: 'x', domain: 'a.com', path: '/' }]));

  const entry = store.readDump('7');
  assert.equal(entry.savedAt, null);
  assert.equal(entry.cookies[0].name, 'legacy');
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
