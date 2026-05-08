const puppeteer = require('puppeteer-core');
const http = require('http');
const WebSocket = require('ws');

class BrowserConnector {
  constructor() {
    // profileId → { cdpPort }
    this.connections = new Map();
  }

  // ── CDP HTTP API (single source of truth) ──

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

  /**
   * Find the main page target (non-blank, non-chrome) via CDP HTTP.
   */
  async _findMainTarget(cdpPort, retries = 5) {
    for (let i = 0; i < retries; i++) {
      const targets = await this._cdpGet(cdpPort, '/json/list');
      const pages = targets.filter((t) => t.type === 'page');
      // Prefer non-blank, non-chrome page; fall back to any page
      const main = pages.find((t) => t.url !== 'about:blank' && !t.url.startsWith('chrome'))
        || pages.find((t) => t.url !== 'about:blank')
        || pages[0];
      if (main) return main;
      // Chrome not fully initialized yet — wait and retry
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  // ── CDP WebSocket (raw protocol for script execution) ──

  /**
   * Send a CDP command over WebSocket and wait for response.
   */
  _cdpSend(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9);
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.off('message', handler); reject(new Error('CDP timeout')); }, 30000);
    });
  }

  /**
   * Connect a WebSocket to a page's devtools endpoint.
   */
  _connectWs(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    });
  }

  /**
   * Navigate a page (via its WS) to a URL and wait for load.
   * Properly listens for Page.loadEventFired event instead of sending it as command.
   */
  async _navigateAndWait(ws, url, timeoutMs = 30000) {
    // Enable Page domain to receive events
    await this._cdpSend(ws, 'Page.enable');

    // Set up load event listener
    let handler;
    const loadPromise = new Promise((resolve) => {
      handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Page.loadEventFired') {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });

    // Navigate
    await this._cdpSend(ws, 'Page.navigate', { url });

    // Wait for load with timeout
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ws.off('message', handler);
        reject(new Error('Navigation timeout'));
      }, timeoutMs);
      timer.unref();
    });

    try {
      await Promise.race([loadPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Public API ──

  connect(profileId, cdpPort) {
    this.connections.set(profileId, { cdpPort });
  }

  get(profileId) {
    return this.connections.has(profileId) ? true : null;
  }

  /**
   * Get the main page's WebSocket URL via CDP HTTP.
   * Returns { wsUrl, targetId, url } or throws.
   */
  async _getMainPageWs(profileId) {
    const conn = this.connections.get(profileId);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const target = await this._findMainTarget(conn.cdpPort);
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(`No active page found for profile ${profileId}`);
    }
    return { wsUrl: target.webSocketDebuggerUrl, targetId: target.id, url: target.url };
  }

  /**
   * Get the currently focused visible page when Chrome has multiple tabs.
   * Falls back to the main page selection used by existing APIs.
   */
  async _getFocusedPageWs(profileId) {
    const conn = this.connections.get(profileId);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const targets = await this._cdpGet(conn.cdpPort, '/json/list');
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);

    for (const target of pages) {
      let ws;
      try {
        ws = await this._connectWs(target.webSocketDebuggerUrl);
        const result = await this._cdpSend(ws, 'Runtime.evaluate', {
          expression: 'document.hasFocus() && document.visibilityState === "visible"',
          returnByValue: true,
        });
        if (result.result?.value) {
          return { wsUrl: target.webSocketDebuggerUrl, targetId: target.id, url: target.url };
        }
      } catch {
        // Ignore pages that cannot be inspected and continue looking.
      } finally {
        if (ws) ws.close();
      }
    }

    return this._getMainPageWs(profileId);
  }

  /**
   * Execute JS on the main page. Opens WS, evaluates, closes WS.
   * No Puppeteer involved — pure CDP.
   */
  async evaluateOnMain(profileId, expression) {
    const { wsUrl } = await this._getMainPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      const result = await this._cdpSend(ws, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
      }
      return result.result?.value;
    } finally {
      ws.close();
    }
  }

  /**
   * Take screenshot of the main page via CDP.
   */
  async screenshotMain(profileId, fullPage = false) {
    const { wsUrl } = await this._getMainPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      if (fullPage) {
        // Get full page dimensions
        const metrics = await this._cdpSend(ws, 'Page.getLayoutMetrics');
        const { width, height } = metrics.contentSize || metrics.cssContentSize;
        await this._cdpSend(ws, 'Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(width), height: Math.ceil(height),
          deviceScaleFactor: 1, mobile: false,
        });
      }
      const { data } = await this._cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
      if (fullPage) {
        await this._cdpSend(ws, 'Emulation.clearDeviceMetricsOverride');
      }
      return data;
    } finally {
      ws.close();
    }
  }

  /**
   * Navigate the main page to a URL.
   */
  async navigateMain(profileId, url) {
    const { wsUrl } = await this._getMainPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      await this._navigateAndWait(ws, url);
    } finally {
      ws.close();
    }
  }

  /**
   * Get all cookies via CDP.
   */
  async getCookiesMain(profileId) {
    const { wsUrl } = await this._getMainPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      const { cookies } = await this._cdpSend(ws, 'Network.getAllCookies');
      return cookies;
    } finally {
      ws.close();
    }
  }

  /**
   * Insert text at the current Chrome focus via CDP.
   * This bypasses noVNC's clipboard path and preserves UTF-8 text.
   */
  async insertTextMain(profileId, text) {
    const { wsUrl } = await this._getFocusedPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      await this._cdpSend(ws, 'Input.insertText', { text });

      // Fire input/change events so page frameworks (React/Vue) sync state.
      await this._cdpSend(ws, 'Runtime.evaluate', {
        expression: `(() => {
          const el = document.activeElement;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`,
      });
      return true;
    } finally {
      ws.close();
    }
  }

  /**
   * Read selected text from the active page when possible.
   */
  async getSelectionTextMain(profileId) {
    const expression = `(() => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          return active.value.slice(start, end);
        }
      }
      const selection = window.getSelection && window.getSelection();
      return selection ? selection.toString() : '';
    })()`;
    const { wsUrl } = await this._getFocusedPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      const result = await this._cdpSend(ws, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
      }
      const value = result.result?.value;
      return typeof value === 'string' ? value : '';
    } finally {
      ws.close();
    }
  }

  /**
   * Set files on a <input type="file"> via CDP.
   * `containerPaths` are paths inside the container filesystem.
   */
  async setFileInputFiles(profileId, containerPaths) {
    const { wsUrl } = await this._getFocusedPageWs(profileId);
    const ws = await this._connectWs(wsUrl);
    try {
      // Use CDP DOM to find all file inputs (including hidden ones).
      // Most upload widgets hide the <input type="file"> with display:none.
      const { root } = await this._cdpSend(ws, 'DOM.getDocument', { depth: -1 });

      const fileInputs = [];
      const walk = (node) => {
        if (node.nodeName === 'INPUT' && node.attributes) {
          const typeIdx = node.attributes.indexOf('type');
          if (typeIdx !== -1 && node.attributes[typeIdx + 1] === 'file') {
            fileInputs.push(node);
          }
        }
        if (node.children) node.children.forEach(walk);
        if (node.shadowRoots) node.shadowRoots.forEach(walk);
      };
      walk(root);

      if (!fileInputs.length) {
        throw new Error('No file input found on page');
      }

      const backendNodeId = fileInputs[0].backendNodeId;

      await this._cdpSend(ws, 'DOM.setFileInputFiles', {
        files: containerPaths,
        backendNodeId,
      });
      return true;
    } finally {
      ws.close();
    }
  }

  /**
   * Open a new tab via CDP HTTP, navigate, return pageId.
   * Uses Puppeteer only for the new tab (reliable since we create it).
   */
  async newPage(profileId, url) {
    const conn = this.connections.get(profileId);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    // Create new target via CDP HTTP
    const target = await this._cdpGet(conn.cdpPort, `/json/new?${encodeURIComponent(url || 'about:blank')}`);
    const pageId = target.id;

    // Navigate if needed (CDP /json/new doesn't always navigate)
    if (url) {
      const ws = await this._connectWs(target.webSocketDebuggerUrl);
      try {
        // Set viewport for new tab
        await this._cdpSend(ws, 'Emulation.setDeviceMetricsOverride', {
          width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
        });
        // Check if already navigated
        const { result } = await this._cdpSend(ws, 'Runtime.evaluate', {
          expression: 'location.href', returnByValue: true,
        });
        if (result.value === 'about:blank' || result.value !== url) {
          await this._navigateAndWait(ws, url);
        }
      } catch (err) {
        ws.close();
        await this._cdpCloseTarget(conn.cdpPort, pageId);
        throw err;
      }
      ws.close();
    }

    return { pageId };
  }

  /**
   * Execute JS on a specific page by pageId.
   */
  async evaluateOnPage(profileId, pageId, expression) {
    const conn = this.connections.get(profileId);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const targets = await this._cdpGet(conn.cdpPort, '/json/list');
    const target = targets.find((t) => t.id === pageId);
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(`Page ${pageId} not found`);
    }

    const ws = await this._connectWs(target.webSocketDebuggerUrl);
    try {
      const result = await this._cdpSend(ws, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
      }
      return result.result?.value;
    } finally {
      ws.close();
    }
  }

  /**
   * Screenshot a specific page by pageId.
   */
  async screenshotPage(profileId, pageId, fullPage = false) {
    const conn = this.connections.get(profileId);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const targets = await this._cdpGet(conn.cdpPort, '/json/list');
    const target = targets.find((t) => t.id === pageId);
    if (!target || !target.webSocketDebuggerUrl) throw new Error(`Page ${pageId} not found`);

    const ws = await this._connectWs(target.webSocketDebuggerUrl);
    try {
      const { data } = await this._cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
      return data;
    } finally {
      ws.close();
    }
  }

  /**
   * Close a page by pageId via CDP HTTP.
   */
  async closePage(profileId, pageId) {
    const conn = this.connections.get(profileId);
    if (!conn) return;
    await this._cdpCloseTarget(conn.cdpPort, pageId);
  }

  async disconnect(profileId) {
    this.connections.delete(profileId);
  }

  async disconnectAll() {
    this.connections.clear();
  }
}

module.exports = BrowserConnector;
