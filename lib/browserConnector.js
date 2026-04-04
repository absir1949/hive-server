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
   * Ensure browser is connected, auto-reconnect if needed.
   */
  async ensureBrowser(profileId) {
    let conn = this.connections.get(profileId);

    if (conn && !conn.browser.connected) {
      await this.connect(profileId, conn.cdpPort);
      conn = this.connections.get(profileId);
    }

    if (!conn) {
      throw new Error(`No connection for profile ${profileId}. Call connect() first.`);
    }

    return conn.browser;
  }

  /**
   * Get the main (first) page — for legacy operations.
   * Does NOT call setViewport to avoid overriding the natural window size
   * that the user sees through VNC.
   */
  async getMainPage(profileId) {
    const browser = await this.ensureBrowser(profileId);
    const pages = await browser.pages();

    let page = pages.find(
      (p) => p.url() !== 'about:blank' && p.url() !== 'chrome://newtab/'
    );
    if (!page && pages.length > 0) page = pages[0];
    if (!page) page = await browser.newPage();

    return page;
  }

  /**
   * Open a new tab, navigate to url, return pageId (CDP targetId).
   * Note: _targetId is Puppeteer internal but there's no public API for targetId.
   */
  async newPage(profileId, url) {
    const browser = await this.ensureBrowser(profileId);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    const pageId = page.target()._targetId;
    return { pageId, page };
  }

  /**
   * Find a page by its pageId (CDP targetId).
   */
  async getPage(profileId, pageId) {
    const browser = await this.ensureBrowser(profileId);
    const pages = await browser.pages();
    const page = pages.find((p) => p.target()._targetId === pageId);
    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }
    return page;
  }

  /**
   * Close a page by its pageId.
   * After closing, clear any viewport override on the main page so it
   * follows the natural VNC window size (prevents 800x600 regression).
   */
  async closePage(profileId, pageId) {
    const page = await this.getPage(profileId, pageId);
    await page.close();

    // Guard against viewport regression: closing a tab with explicit viewport
    // can leave the main page stuck at 800x600. Re-set if needed.
    try {
      const mainPage = await this.getMainPage(profileId);
      const vp = await mainPage.evaluate(() => window.innerWidth);
      if (vp <= 800) {
        await mainPage.setViewport({ width: 1920, height: 1080 });
      }
    } catch (e) { /* non-critical */ }
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
