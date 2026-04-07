const puppeteer = require('puppeteer-core');
const http = require('http');

class BrowserConnector {
  constructor() {
    // profileId → { browser, cdpPort }
    this.connections = new Map();
  }

  // ── CDP HTTP API ──

  _cdpGet(cdpPort, path) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${cdpPort}${path}`, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  _cdpCloseTarget(cdpPort, targetId) {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`, () => resolve(true))
        .on('error', () => resolve(false));
    });
  }

  // ── Connection management ──

  /**
   * Connect to Chrome via CDP at browser level.
   * After connecting, force-attach to all existing page targets so
   * browser.pages() can see them (Puppeteer misses pre-existing tabs).
   */
  async connect(profileId, cdpPort) {
    const existing = this.connections.get(profileId);
    if (existing && existing.browser.connected) {
      return existing.browser;
    }

    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${cdpPort}`,
      defaultViewport: null, // don't override any page's viewport
    });

    browser.on('disconnected', () => {
      const conn = this.connections.get(profileId);
      if (conn && conn.browser === browser) {
        this.connections.delete(profileId);
      }
    });

    // Force Puppeteer to discover all existing page targets.
    // Without this, browser.pages() misses tabs opened by Chrome itself.
    const cdpTargets = await this._cdpGet(cdpPort, '/json/list');
    for (const t of cdpTargets) {
      if (t.type === 'page') {
        try {
          await browser._connection.send('Target.attachToTarget', {
            targetId: t.id,
            flatten: true,
          });
        } catch (e) { /* already attached or not available */ }
      }
    }

    this.connections.set(profileId, { browser, cdpPort });
    return browser;
  }

  get(profileId) {
    const conn = this.connections.get(profileId);
    if (conn && conn.browser.connected) return conn.browser;
    return null;
  }

  async ensureBrowser(profileId) {
    let conn = this.connections.get(profileId);
    if (conn && !conn.browser.connected) {
      await this.connect(profileId, conn.cdpPort);
      conn = this.connections.get(profileId);
    }
    if (!conn) throw new Error(`No connection for profile ${profileId}. Call connect() first.`);
    return conn.browser;
  }

  /**
   * Fix viewport if Puppeteer reset it to 800x600 when attaching.
   * Sets to 1920x1080 to match Xvfb display.
   */
  async _ensureViewport(page) {
    try {
      const vp = page.viewport();
      if (!vp || vp.width <= 800) {
        await page.setViewport({ width: 1920, height: 1080 });
      }
    } catch (e) {}
    return page;
  }

  // ── Page operations ──

  /**
   * Get the main page — user's active page with real content.
   * Uses CDP HTTP as source of truth, maps to Puppeteer page via targetId.
   */
  async getMainPage(profileId) {
    const conn = this.connections.get(profileId);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const browser = await this.ensureBrowser(profileId);

    // CDP HTTP: find the real page target
    const cdpTargets = await this._cdpGet(conn.cdpPort, '/json/list');
    const mainTarget = cdpTargets.find(
      (t) => t.type === 'page' && t.url !== 'about:blank' && !t.url.startsWith('chrome')
    );

    if (mainTarget) {
      // Map CDP target to Puppeteer page by URL (targetId may differ)
      const pages = await browser.pages();
      let page = pages.find((p) => p.url() === mainTarget.url);

      if (!page) {
        // Puppeteer didn't track it — force attach and retry
        try {
          await browser._connection.send('Target.attachToTarget', {
            targetId: mainTarget.id,
            flatten: true,
          });
        } catch (e) {}
        // Wait briefly for Puppeteer to register the new target
        await new Promise((r) => setTimeout(r, 200));
        const retryPages = await browser.pages();
        page = retryPages.find((p) => p.url() === mainTarget.url);
      }

      if (page) return this._ensureViewport(page);
    }

    // Fallback: return any page, or create new
    const pages = await browser.pages();
    let page = pages.find(
      (p) => p.url() !== 'about:blank' && p.url() !== 'chrome://newtab/'
    );
    if (!page && pages.length > 0) page = pages[0];
    if (!page) page = await browser.newPage();
    return this._ensureViewport(page);
  }

  /**
   * Open a new tab, navigate to url, return pageId.
   */
  async newPage(profileId, url) {
    const browser = await this.ensureBrowser(profileId);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    if (url) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
    }
    const pageId = page.target()._targetId;
    return { pageId, page };
  }

  /**
   * Find a page by pageId.
   */
  async getPage(profileId, pageId) {
    const browser = await this.ensureBrowser(profileId);
    const pages = await browser.pages();
    const page = pages.find((p) => p.target()._targetId === pageId);
    if (!page) throw new Error(`Page ${pageId} not found`);
    return page;
  }

  /**
   * Close a page by pageId. Uses CDP HTTP as fallback.
   */
  async closePage(profileId, pageId) {
    const conn = this.connections.get(profileId);

    // Try Puppeteer first
    try {
      const page = await this.getPage(profileId, pageId);
      await page.close();
    } catch (e) {
      // Fallback: close via CDP HTTP
      if (conn) await this._cdpCloseTarget(conn.cdpPort, pageId);
    }
  }

  async disconnect(profileId) {
    const conn = this.connections.get(profileId);
    if (conn) {
      try { await conn.browser.disconnect(); } catch (e) {}
      this.connections.delete(profileId);
    }
  }

  async disconnectAll() {
    for (const [profileId] of this.connections) {
      await this.disconnect(profileId);
    }
  }
}

module.exports = BrowserConnector;
