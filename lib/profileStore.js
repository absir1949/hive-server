const fs = require('fs');
const path = require('path');

const PROFILES_FILE = process.env.PROFILES_FILE || path.resolve(__dirname, '..', 'data', 'profiles.json');
const RENDER_PROFILE_ID = 'render';

class ProfileStore {
  constructor() {
    this._ensureDataDir();
    this.profiles = this._load();
    this._ensureRenderProfile();
  }

  _ensureDataDir() {
    const dir = path.dirname(PROFILES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(PROFILES_FILE)) {
        const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
        for (const profile of Object.values(profiles.items || {})) {
          // Browser mode belongs to the active browser session, not the
          // persistent profile. Drop the old field when loading data written
          // by the previous profile-bound implementation.
          delete profile.browserMode;
        }
        return profiles;
      }
    } catch (err) {
      console.error('[ProfileStore] Failed to load profiles:', err.message);
    }
    return { nextId: 1, items: {} };
  }

  _save() {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(this.profiles, null, 2));
  }

  _ensureRenderProfile() {
    const existing = this.profiles.items[RENDER_PROFILE_ID];
    if (existing) {
      const changed = existing.id !== RENDER_PROFILE_ID
        || existing.type !== 'render'
        || existing.system !== true;
      existing.id = RENDER_PROFILE_ID;
      existing.type = 'render';
      existing.system = true;
      if (changed) this._save();
      return;
    }

    this.profiles.items[RENDER_PROFILE_ID] = {
      id: RENDER_PROFILE_ID,
      name: '系统渲染',
      type: 'render',
      system: true,
      url: 'about:blank',
      keepAliveInterval: 0,
      fingerprintTemplateId: 'chrome_win10_desktop',
      proxyId: null,
      createdAt: new Date().toISOString(),
    };
    this._save();
  }

  /**
   * Create a new profile. Returns the created profile with auto-assigned integer ID.
   * @param {Object} config - { name, url, fingerprintTemplateId, proxyId }
   */
  create(config) {
    const id = this.profiles.nextId++;
    const profile = {
      id,
      name: config.name || `Profile ${id}`,
      type: config.type || 'generic',
      url: config.url || 'about:blank',
      keepAliveInterval: config.keepAliveInterval !== undefined ? config.keepAliveInterval : 3600,
      fingerprintTemplateId: config.fingerprintTemplateId || 'chrome_win10_desktop',
      proxyId: config.proxyId || null,
      createdAt: new Date().toISOString(),
    };
    this.profiles.items[id] = profile;
    this._save();
    return profile;
  }

  get(id) {
    return this.profiles.items[id] || null;
  }

  list() {
    return Object.values(this.profiles.items);
  }

  update(id, config) {
    const existing = this.profiles.items[id];
    if (!existing) return null;

    if (config.name !== undefined) existing.name = config.name;
    if (config.type !== undefined) existing.type = config.type;
    if (config.url !== undefined) existing.url = config.url;
    if (config.keepAliveInterval !== undefined) existing.keepAliveInterval = config.keepAliveInterval;
    if (config.fingerprintTemplateId !== undefined) existing.fingerprintTemplateId = config.fingerprintTemplateId;
    if (config.proxyId !== undefined) existing.proxyId = config.proxyId;

    existing.updatedAt = new Date().toISOString();
    this._save();
    return existing;
  }

  remove(id) {
    if (!this.profiles.items[id]) return false;
    delete this.profiles.items[id];
    this._save();
    return true;
  }
}

module.exports = ProfileStore;
module.exports.RENDER_PROFILE_ID = RENDER_PROFILE_ID;
