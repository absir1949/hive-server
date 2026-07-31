const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-profile-store-'));
const profilesFile = path.join(tempDir, 'profiles.json');
process.env.PROFILES_FILE = profilesFile;
const ProfileStore = require('../lib/profileStore');

test('profiles keep account data without persisting a browser mode', () => {
  fs.writeFileSync(profilesFile, JSON.stringify({
    nextId: 2,
    items: {
      1: { id: 1, name: 'legacy', url: 'about:blank' },
    },
  }));

  const store = new ProfileStore();
  assert.equal(store.get(1).browserMode, undefined);

  const profile = store.create({ name: 'collector', url: 'about:blank', browserMode: 'headless' });
  assert.equal(profile.browserMode, undefined);
  assert.equal(store.get(profile.id).browserMode, undefined);
});
