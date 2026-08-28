const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');

class AuthStore {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir || DEFAULT_DATA_DIR;
  }

  filePath(profileId) {
    return path.join(this.dataDir, String(profileId), 'auth-cookies.json');
  }

  save(profileId, cookies) {
    const dir = path.dirname(this.filePath(profileId));
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      savedAt: new Date().toISOString(),
      cookies: Array.isArray(cookies) ? cookies : [],
    };
    fs.writeFileSync(this.filePath(profileId), JSON.stringify(payload, null, 2));
  }

  load(profileId) {
    return this.readDump(profileId)?.cookies ?? null;
  }

  /**
   * Dump file with metadata. `savedAt` lets API callers tell a fresh dump
   * from a stale one; a raw-array legacy file yields savedAt: null.
   */
  readDump(profileId) {
    const file = this.filePath(profileId);
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
      if (!Array.isArray(cookies)) return null;
      const savedAt = Array.isArray(parsed) ? null : parsed.savedAt || null;
      return { savedAt, cookies };
    } catch (err) {
      console.error(`[AuthStore] Failed to load cookies for ${profileId}:`, err.message);
      return null;
    }
  }

  static toSetCookies(cookies) {
    return (cookies || []).map((c) => {
      const item = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      if (c.sameSite) item.sameSite = c.sameSite;
      if (c.session || c.expires === -1) item.session = true;
      else if (typeof c.expires === 'number' && c.expires > 0) item.expires = c.expires;
      return item;
    });
  }
}

module.exports = AuthStore;
