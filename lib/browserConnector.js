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

    // Reset viewport to match actual window size (Xvnc + --start-maximized
    // doesn't sync innerWidth/innerHeight with the window dimensions)
    try {
      const pages = await browser.pages();
      if (pages.length > 0) {
        const client = await pages[0].createCDPSession();
        await client.send('Emulation.clearDeviceMetricsOverride');
        await client.detach();
      }
    } catch (e) {
      // Non-critical, continue
    }

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
   * - Find first non-blank page, or fallback to any page, or create new
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
    const contentPage = pages.find(
      (p) => p.url() !== 'about:blank' && p.url() !== 'chrome://newtab/'
    );
    if (contentPage) return contentPage;

    // Fallback to any existing page
    if (pages.length > 0) return pages[0];

    // Last resort: create new page
    return conn.browser.newPage();
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
