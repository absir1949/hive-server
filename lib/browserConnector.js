const puppeteer = require('puppeteer-core');

class BrowserConnector {
  constructor() {
    // profileId → { browser, cdpPort }
    this.connections = new Map();
  }

  /**
   * Connect to Chrome via CDP. Stores the connection for reuse.
   * If already connected, returns existing browser.
   */
  async connect(profileId, cdpPort) {
    const existing = this.connections.get(profileId);
    if (existing && existing.browser.connected) {
      return existing.browser;
    }

    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
    });

    // Clean up on unexpected disconnect
    browser.on('disconnected', () => {
      const conn = this.connections.get(profileId);
      if (conn && conn.browser === browser) {
        this.connections.delete(profileId);
      }
    });

    this.connections.set(profileId, { browser, cdpPort });
    return browser;
  }

  /**
   * Get existing browser connection, or null if not connected.
   */
  get(profileId) {
    const conn = this.connections.get(profileId);
    if (conn && conn.browser.connected) {
      return conn.browser;
    }
    return null;
  }

  /**
   * Get a usable page for the profile.
   * - If disconnected, auto-reconnect using stored cdpPort
   * - Find a page with correct viewport, or create new
   *
   * Chrome's initial tab has a stuck 800x600 viewport (created before
   * openbox maximizes the window). New tabs get the correct size.
   * We detect bad-viewport tabs and replace them.
   */
  async getPage(profileId) {
    let conn = this.connections.get(profileId);

    // Auto-reconnect if disconnected
    if (conn && !conn.browser.connected) {
      await this.connect(profileId, conn.cdpPort);
      conn = this.connections.get(profileId);
    }

    if (!conn) {
      throw new Error(`No connection for profile ${profileId}. Call connect() first.`);
    }

    const pages = await conn.browser.pages();

    // Prefer a page with real content
    let page = pages.find(
      (p) => p.url() !== 'about:blank' && p.url() !== 'chrome://newtab/'
    );
    if (!page && pages.length > 0) page = pages[0];
    if (!page) page = await conn.browser.newPage();

    // Chromium in Xvfb has a bug: viewport stuck at 800x600 regardless of
    // --window-size or --start-maximized. Fix via CDP setViewport to match
    // the virtual display (1920x1080). noVNC scale=true handles client-side
    // adaptation, so this fixed size is correct.
    try {
      const vp = await page.evaluate(() => window.innerWidth);
      if (vp <= 800) {
        await page.setViewport({ width: 1920, height: 1080 });
      }
    } catch (e) { /* non-critical */ }

    return page;
  }

  /**
   * Disconnect a single profile.
   */
  async disconnect(profileId) {
    const conn = this.connections.get(profileId);
    if (conn) {
      try {
        await conn.browser.disconnect();
      } catch (err) {
        // Already disconnected, ignore
      }
      this.connections.delete(profileId);
    }
  }

  /**
   * Disconnect all profiles.
   */
  async disconnectAll() {
    for (const [profileId] of this.connections) {
      await this.disconnect(profileId);
    }
  }
}

module.exports = BrowserConnector;
