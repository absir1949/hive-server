const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-profile-store-'));
const profilesFile = path.join(tempDir, 'profiles.json');
process.env.PROFILES_FILE = profilesFile;
const ProfileStore = require('../lib/profileStore');

test('legacy profiles default to VNC and new profiles can use headless mode', () => {
  fs.writeFileSync(profilesFile, JSON.stringify({
    nextId: 2,
    items: {
      1: { id: 1, name: 'legacy', url: 'about:blank' },
    },
  }));

  const store = new ProfileStore();
  assert.equal(store.get(1).browserMode, 'vnc');

  const profile = store.create({ name: 'collector', url: 'about:blank', browserMode: 'headless' });
  assert.equal(profile.browserMode, 'headless');
  assert.equal(store.get(profile.id).browserMode, 'headless');
});

test('profile store rejects unsupported browser modes', () => {
  const store = new ProfileStore();
  assert.throws(() => store.create({ name: 'invalid', browserMode: 'lightpanda' }), /browserMode must be one of/);
  assert.throws(() => store.update(1, { browserMode: 'lightpanda' }), /browserMode must be one of/);
});
