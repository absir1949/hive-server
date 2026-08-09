const http = require('http');
const WebSocket = require('ws');

class BrowserConnector {
  constructor() {
    // profileId → { cdpPort, browserWsUrl }
    this.connections = new Map();
    // profileId → Map<pageId, { ws, targetId, cdpPort, sessionId, lifecycle handlers }>
    // Collection pages live in minimized, unfocused Chrome windows. The owner
    // WebSocket is kept so all later operations stay attached to that target.
    this.collectionPages = new Map();
    this.nextCommandId = 1;
  }

  // ── CDP HTTP API (single source of truth) ──

  _cdpRequest(cdpPort, method, path) {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${cdpPort}${path}`, { method }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error(`CDP HTTP timeout: ${method} ${path}`)));
      req.end();
    });
  }

  async _cdpGet(cdpPort, path) {
    const data = await this._cdpRequest(cdpPort, 'GET', path);
    try {
      return JSON.parse(data);
    } catch (e) {
      throw new Error(`CDP GET ${path} returned non-JSON: ${data.slice(0, 160)}`);
    }
  }

  _cdpCloseTarget(cdpPort, targetId) {
    return new Promise((resolve) => {
      this._cdpRequest(cdpPort, 'PUT', `/json/close/${targetId}`)
        .then(() => resolve(true))
        .catch(() => resolve(false));
    });
  }

  /**
   * Find the main page target (non-blank, non-chrome) via CDP HTTP.
   */
  async _findMainTarget(profileId, cdpPort, retries = 5) {
    for (let i = 0; i < retries; i++) {
      const targets = await this._cdpGet(cdpPort, '/json/list');
      const collectionIds = new Set(this.collectionPages.get(String(profileId))?.keys() || []);
      const pages = targets.filter((t) => t.type === 'page' && !collectionIds.has(t.id));
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

  _targetMatchesUrlPattern(target, urlPattern) {
    if (!urlPattern) return false;
    const url = target?.url || '';
    if (!url || url === 'about:blank' || url.startsWith('chrome')) return false;

    const pattern = String(urlPattern);
    if (url.includes(pattern)) return true;

    try {
      return new RegExp(pattern).test(url);
    } catch {
      return false;
    }
  }

  /**
   * Find a page target by URL pattern. This never falls back to the main tab:
   * callers passing a pattern need domain-specific execution, not a guess.
   */
  async _findTargetByUrlPattern(profileId, cdpPort, urlPattern, retries = 3) {
    for (let i = 0; i < retries; i++) {
      const targets = await this._cdpGet(cdpPort, '/json/list');
      const collectionIds = new Set(this.collectionPages.get(String(profileId))?.keys() || []);
      const pages = targets.filter((t) => (
        t.type === 'page' && t.webSocketDebuggerUrl && !collectionIds.has(t.id)
      ));
      const target = pages.find((t) => this._targetMatchesUrlPattern(t, urlPattern));
      if (target) return target;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  // ── CDP WebSocket (raw protocol for script execution) ──

  /**
   * Send a CDP command over WebSocket and wait for response.
   */
  _cdpSend(ws, method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== undefined && ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP disconnected before ${method}`));
        return;
      }

      const id = this.nextCommandId++;
      let settled = false;
      let timer;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off('message', handler);
        ws.off('close', closeHandler);
        ws.off('error', errorHandler);
        callback(value);
      };
      const closeHandler = () => finish(reject, new Error(`CDP disconnected during ${method}`));
      const errorHandler = (err) => finish(reject, err);
      const handler = (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.id === id) {
          if (msg.error) finish(reject, new Error(msg.error.message));
          else finish(resolve, msg.result);
        }
      };
      ws.on('message', handler);
      ws.once('close', closeHandler);
      ws.once('error', errorHandler);
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      timer = setTimeout(() => finish(reject, new Error(`CDP timeout: ${method}`)), 30000);
      timer.unref?.();
      try {
        ws.send(JSON.stringify(message), (err) => {
          if (err) finish(reject, err);
        });
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  /**
   * Connect a WebSocket to a page's devtools endpoint.
   */
  _connectWs(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error('WS connect timeout'));
      }, 5000);
      timer.unref?.();

      ws.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      });
      // Keep one error listener after connection as well; ws emits `error`
      // events during later transport failures and they must never be unhandled.
      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Navigate a page (via its WS) to a URL and wait for load.
   * Properly listens for Page.loadEventFired event instead of sending it as command.
   */
  async _navigateAndWait(ws, url, timeoutMs = 30000, sessionId) {
    // Enable Page domain to receive events
    await this._cdpSend(ws, 'Page.enable', {}, sessionId);

    // Set up load event listener
    let handler;
    const loadPromise = new Promise((resolve) => {
      handler = (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.method === 'Page.loadEventFired' && (!sessionId || msg.sessionId === sessionId)) {
          ws.off('message', handler);
          resolve();
        }
      };
      ws.on('message', handler);
    });

    // Navigate
    await this._cdpSend(ws, 'Page.navigate', { url }, sessionId);

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

  async connect(profileId, cdpPort) {
    // Verify CDP is actually reachable before caching the connection.
    const version = await this._cdpGet(cdpPort, '/json/version');
    if (!version.webSocketDebuggerUrl) {
      throw new Error(`CDP browser WebSocket unavailable for profile ${profileId}`);
    }
    this.connections.set(String(profileId), {
      cdpPort,
      browserWsUrl: version.webSocketDebuggerUrl,
    });
  }

  get(profileId) {
    return this.connections.has(String(profileId)) ? true : null;
  }

  hasOpenPages(profileId) {
    return (this.collectionPages.get(String(profileId))?.size || 0) > 0;
  }

  /**
   * Get the main page's WebSocket URL via CDP HTTP.
   * Returns { wsUrl, targetId, url } or throws.
   */
  async _getMainPageWs(profileId) {
    const pid = String(profileId);
    const conn = this.connections.get(pid);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const target = await this._findMainTarget(pid, conn.cdpPort);
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(`No active page found for profile ${profileId}`);
    }
    return { wsUrl: target.webSocketDebuggerUrl, targetId: target.id, url: target.url };
  }

  async _getPageWsByUrlPattern(profileId, urlPattern) {
    const pid = String(profileId);
    const conn = this.connections.get(pid);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const target = await this._findTargetByUrlPattern(pid, conn.cdpPort, urlPattern);
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(`No page matching url_pattern ${urlPattern} for profile ${profileId}`);
    }
    return { wsUrl: target.webSocketDebuggerUrl, targetId: target.id, url: target.url };
  }

  /**
   * Get the currently focused visible page when Chrome has multiple tabs.
   * Falls back to the main page selection used by existing APIs.
   */
  async _getFocusedPageWs(profileId) {
    const conn = this.connections.get(String(profileId));
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
   * Execute JS on a page matching a URL pattern. Used for platform-specific
   * localStorage/cookie reads so a random active tab cannot affect state checks.
   */
  async evaluateOnUrlPattern(profileId, urlPattern, expression) {
    const { wsUrl } = await this._getPageWsByUrlPattern(profileId, urlPattern);
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
      if (!fullPage) {
        const { data } = await this._cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
        return data;
      }
      const metrics = await this._cdpSend(ws, 'Page.getLayoutMetrics');
      const { width, height } = metrics.contentSize || metrics.cssContentSize;
      await this._cdpSend(ws, 'Emulation.setDeviceMetricsOverride', {
        width: Math.ceil(width), height: Math.ceil(height),
        deviceScaleFactor: 1, mobile: false,
      });
      try {
        const { data } = await this._cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
        return data;
      } finally {
        try {
          await this._cdpSend(ws, 'Emulation.clearDeviceMetricsOverride');
        } catch (cleanupErr) {
          console.error('[screenshotMain] clearDeviceMetricsOverride failed:', cleanupErr.message);
        }
      }
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

  _getCollectionPage(profileId, pageId) {
    return this.collectionPages.get(String(profileId))?.get(String(pageId)) || null;
  }

  _removeCollectionPage(profileId, pageId, page) {
    const pid = String(profileId);
    const pages = this.collectionPages.get(pid);
    if (!pages || (page && pages.get(String(pageId)) !== page)) return false;
    pages.delete(String(pageId));
    if (pages.size === 0) this.collectionPages.delete(pid);
    return true;
  }

  _rememberCollectionPage(profileId, pageId, page) {
    const pid = String(profileId);
    let pages = this.collectionPages.get(pid);
    if (!pages) {
      pages = new Map();
      this.collectionPages.set(pid, pages);
    }
    pages.set(String(pageId), page);

    page.targetLifecycleHandler = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const targetEnded = (
        (message.method === 'Target.targetDestroyed' || message.method === 'Target.targetCrashed')
          && message.params?.targetId === String(pageId)
      ) || (
        message.method === 'Target.detachedFromTarget'
          && message.params?.sessionId === page.sessionId
      );
      if (!targetEnded) return;
      this._removeCollectionPage(pid, pageId, page);
      page.ws.close();
    };
    page.connectionErrorHandler = () => {
      this._removeCollectionPage(pid, pageId, page);
      this._cdpCloseTarget(page.cdpPort, String(pageId)).catch(() => {});
      page.ws.terminate?.();
    };
    page.connectionCloseHandler = () => {
      this._removeCollectionPage(pid, pageId, page);
      this._cdpCloseTarget(page.cdpPort, String(pageId)).catch(() => {});
    };
    page.ws.on('message', page.targetLifecycleHandler);
    page.ws.once('error', page.connectionErrorHandler);
    page.ws.once('close', page.connectionCloseHandler);
  }

  /**
   * Create a minimized background window in the default browser context. It
   * shares Profile storage, keeps rendering support, and never takes focus.
   */
  async newPage(profileId, url) {
    const pid = String(profileId);
    const conn = this.connections.get(pid);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const ws = await this._connectWs(conn.browserWsUrl);
    let pageId;
    let page;
    try {
      const created = await this._cdpSend(ws, 'Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
        background: true,
        focus: false,
        windowState: 'minimized',
      });
      pageId = String(created.targetId);
      const attached = await this._cdpSend(ws, 'Target.attachToTarget', {
        targetId: pageId,
        flatten: true,
      });
      page = {
        ws,
        targetId: pageId,
        cdpPort: conn.cdpPort,
        sessionId: attached.sessionId,
        targetLifecycleHandler: null,
        connectionErrorHandler: null,
        connectionCloseHandler: null,
      };
      this._rememberCollectionPage(pid, pageId, page);

      await this._cdpSend(ws, 'Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      }, page.sessionId);

      if (url && url !== 'about:blank') {
        await this._navigateAndWait(ws, url, 30000, page.sessionId);
      }
    } catch (err) {
      if (pageId) {
        this._removeCollectionPage(pid, pageId, page);
        if (page?.targetLifecycleHandler) ws.off('message', page.targetLifecycleHandler);
        if (page?.connectionErrorHandler) ws.off('error', page.connectionErrorHandler);
        if (page?.connectionCloseHandler) ws.off('close', page.connectionCloseHandler);
        await this._cdpSend(ws, 'Target.closeTarget', { targetId: pageId })
          .catch(() => this._cdpCloseTarget(conn.cdpPort, pageId));
      }
      ws.close();
      throw err;
    }

    return { pageId };
  }

  /**
   * Execute JS on a specific page by pageId.
   */
  async evaluateOnPage(profileId, pageId, expression) {
    const pid = String(profileId);
    const conn = this.connections.get(pid);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const collectionPage = this._getCollectionPage(pid, pageId);
    if (collectionPage) {
      const result = await this._cdpSend(collectionPage.ws, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }, collectionPage.sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
      }
      return result.result?.value;
    }

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
   * fullPage=true 时截取整个页面（覆盖默认视口）。
   */
  async screenshotPage(profileId, pageId, fullPage = false) {
    const pid = String(profileId);
    const conn = this.connections.get(pid);
    if (!conn) throw new Error(`No connection for profile ${profileId}`);

    const collectionPage = this._getCollectionPage(pid, pageId);
    if (collectionPage) {
      return this._screenshotWithSession(collectionPage.ws, fullPage, collectionPage.sessionId);
    }

    const targets = await this._cdpGet(conn.cdpPort, '/json/list');
    const target = targets.find((t) => t.id === pageId);
    if (!target || !target.webSocketDebuggerUrl) throw new Error(`Page ${pageId} not found`);

    const ws = await this._connectWs(target.webSocketDebuggerUrl);
    try {
      return await this._screenshotWithSession(ws, fullPage);
    } finally {
      ws.close();
    }
  }

  /**
   * Take a screenshot over a page WebSocket or a flattened CDP session.
   */
  async _screenshotWithSession(ws, fullPage, sessionId) {
    if (!fullPage) {
      const { data } = await this._cdpSend(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
      return data;
    }

    const metrics = await this._cdpSend(ws, 'Page.getLayoutMetrics', {}, sessionId);
    const { width, height } = metrics.contentSize || metrics.cssContentSize;
    await this._cdpSend(ws, 'Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(width),
      height: Math.ceil(height),
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    try {
      const { data } = await this._cdpSend(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
      return data;
    } finally {
      try {
        await this._cdpSend(ws, 'Emulation.clearDeviceMetricsOverride', {}, sessionId);
      } catch (cleanupErr) {
        console.error('[screenshotPage] clearDeviceMetricsOverride failed:', cleanupErr.message);
      }
    }
  }

  /**
   * Close a managed collection window, with an HTTP fallback for legacy targets.
   */
  async closePage(profileId, pageId) {
    const pid = String(profileId);
    const conn = this.connections.get(pid);
    if (!conn) return;

    const collectionPage = this._getCollectionPage(pid, pageId);
    if (collectionPage) {
      this._removeCollectionPage(pid, pageId, collectionPage);
      collectionPage.ws.off('message', collectionPage.targetLifecycleHandler);
      collectionPage.ws.off('error', collectionPage.connectionErrorHandler);
      collectionPage.ws.off('close', collectionPage.connectionCloseHandler);
      try {
        await this._cdpSend(collectionPage.ws, 'Target.closeTarget', { targetId: String(pageId) });
      } catch (err) {
        const closed = await this._cdpCloseTarget(conn.cdpPort, String(pageId));
        if (!closed) throw err;
      } finally {
        collectionPage.ws.close();
      }
      return;
    }

    await this._cdpCloseTarget(conn.cdpPort, pageId);
  }

  async disconnect(profileId) {
    const pid = String(profileId);
    const pages = this.collectionPages.get(pid);
    if (pages) {
      this.collectionPages.delete(pid);
      for (const page of pages.values()) {
        page.ws.off('message', page.targetLifecycleHandler);
        page.ws.off('error', page.connectionErrorHandler);
        page.ws.off('close', page.connectionCloseHandler);
        await this._cdpCloseTarget(page.cdpPort, page.targetId).catch(() => {});
        page.ws.close();
      }
    }
    this.connections.delete(pid);
  }

  async disconnectAll() {
    for (const profileId of this.connections.keys()) {
      await this.disconnect(profileId);
    }
  }
}

module.exports = BrowserConnector;
