const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-profile-store-'));
const profilesFile = path.join(tempDir, 'profiles.json');
process.env.PROFILES_FILE = profilesFile;
const ProfileStore = require('../lib/profileStore');
const { RENDER_PROFILE_ID } = ProfileStore;

test('creates one stable system render profile', () => {
  fs.writeFileSync(profilesFile, JSON.stringify({ nextId: 1, items: {} }));

  const firstStore = new ProfileStore();
  const first = firstStore.get(RENDER_PROFILE_ID);
  assert.deepEqual(first, {
    id: 'render',
    name: '系统渲染',
    type: 'render',
    system: true,
    url: 'about:blank',
    keepAliveInterval: 0,
    fingerprintTemplateId: 'chrome_win10_desktop',
    proxyId: null,
    createdAt: first.createdAt,
  });

  const secondStore = new ProfileStore();
  assert.equal(secondStore.list().filter((profile) => profile.id === RENDER_PROFILE_ID).length, 1);
  assert.equal(secondStore.get(RENDER_PROFILE_ID).createdAt, first.createdAt);
});

test('profiles keep account data without persisting a browser mode', () => {
  fs.writeFileSync(profilesFile, JSON.stringify({
    nextId: 2,
    items: {
      1: { id: 1, name: 'legacy', url: 'about:blank' },
    },
  }));

  const store = new ProfileStore();
  assert.equal(store.get(1).browserMode, undefined);
  assert.equal(store.get(RENDER_PROFILE_ID).type, 'render');

  const profile = store.create({ name: 'collector', url: 'about:blank', browserMode: 'headless' });
  assert.equal(profile.browserMode, undefined);
  assert.equal(store.get(profile.id).browserMode, undefined);
});
