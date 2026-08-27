const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const BrowserConnector = require('../lib/browserConnector');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

function createConnectedConnector() {
  const connector = new BrowserConnector();
  connector.connections.set('1', {
    cdpPort: 9317,
    browserWsUrl: 'ws://127.0.0.1:9317/devtools/browser/test',
  });
  return connector;
}

test('setCookiesMain enables the Network domain then writes the cookie list', async () => {
  const connector = createConnectedConnector();
  const ws = new FakeWebSocket();
  const commands = [];
  connector._getMainPageWs = async () => ({ wsUrl: 'ws://page' });
  connector._connectWs = async () => ws;
  connector._cdpSend = async (socket, method, params) => {
    commands.push({ method, params });
    return {};
  };

  await connector.setCookiesMain('1', [{ name: 'biz_magic', value: 'abc', domain: 'store.weixin.qq.com' }]);

  assert.deepEqual(commands.map((command) => command.method), ['Network.enable', 'Network.setCookies']);
  assert.equal(commands[1].params.cookies[0].name, 'biz_magic');
  assert.equal(ws.closed, true);
});

test('collection pages use minimized background windows without taking focus', async () => {
  const connector = createConnectedConnector();
  const ws = new FakeWebSocket();
  const commands = [];

  connector._connectWs = async () => ws;
  connector._cdpSend = async (socket, method, params = {}, sessionId) => {
    commands.push({ socket, method, params, sessionId });
    if (method === 'Target.createTarget') return { targetId: 'hidden-1' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
    if (method === 'Page.navigate') {
      queueMicrotask(() => {
        ws.emit('message', Buffer.from(JSON.stringify({
          method: 'Page.loadEventFired',
          sessionId: 'session-1',
        })));
      });
      return {};
    }
    if (method === 'Runtime.evaluate') return { result: { value: 'collected' } };
    if (method === 'Page.captureScreenshot') return { data: 'png-data' };
    return {};
  };

  const { pageId } = await connector.newPage('1', 'https://store.weixin.qq.com/shop/home');

  assert.equal(pageId, 'hidden-1');
  assert.equal(connector.hasOpenPages('1'), true);
  assert.deepEqual(commands[0].params, {
    url: 'about:blank',
    newWindow: true,
    background: true,
    focus: false,
    windowState: 'minimized',
  });
  assert.equal(commands.find((command) => command.method === 'Page.navigate').sessionId, 'session-1');

  const result = await connector.evaluateOnPage('1', pageId, 'document.title');
  assert.equal(result, 'collected');
  const image = await connector.screenshotPage('1', pageId);
  assert.equal(image, 'png-data');
  assert.equal(
    commands.find((command) => command.method === 'Runtime.evaluate').sessionId,
    'session-1',
  );

  await connector.closePage('1', pageId);
  assert.equal(connector.hasOpenPages('1'), false);
  assert.equal(ws.closed, true);
  assert.ok(commands.some((command) => (
    command.method === 'Target.closeTarget' && command.params.targetId === pageId
  )));
});

test('managed collection windows are excluded from main-page and URL-pattern selection', async () => {
  const connector = createConnectedConnector();
  const ws = new FakeWebSocket();
  connector.collectionPages.set('1', new Map([['hidden-1', { ws, sessionId: 'session-1' }]]));
  connector._cdpGet = async () => [
    {
      id: 'hidden-1',
      type: 'page',
      url: 'https://store.weixin.qq.com/hidden',
      webSocketDebuggerUrl: 'ws://hidden',
    },
    {
      id: 'visible-1',
      type: 'page',
      url: 'https://store.weixin.qq.com/visible',
      webSocketDebuggerUrl: 'ws://visible',
    },
  ];

  const main = await connector._findMainTarget('1', 9317, 1);
  const matched = await connector._findTargetByUrlPattern('1', 9317, 'store.weixin.qq.com', 1);

  assert.equal(main.id, 'visible-1');
  assert.equal(matched.id, 'visible-1');
});

test('a collection target that closes itself is removed from the registry', () => {
  const connector = createConnectedConnector();
  const ws = new FakeWebSocket();
  connector._cdpCloseTarget = async () => true;
  const page = {
    ws,
    targetId: 'hidden-1',
    cdpPort: 9317,
    sessionId: 'session-1',
    targetLifecycleHandler: null,
    connectionErrorHandler: null,
    connectionCloseHandler: null,
  };
  connector._rememberCollectionPage('1', 'hidden-1', page);

  ws.emit('message', Buffer.from(JSON.stringify({
    method: 'Target.detachedFromTarget',
    params: { sessionId: 'session-1' },
  })));

  assert.equal(connector.hasOpenPages('1'), false);
  assert.equal(ws.closed, true);
});

test('disconnect closes collection targets and creator sessions so windows cannot leak', async () => {
  const connector = createConnectedConnector();
  connector._cdpCloseTarget = async () => true;
  const first = new FakeWebSocket();
  const second = new FakeWebSocket();
  connector.collectionPages.set('1', new Map([
    ['hidden-1', {
      ws: first,
      targetId: 'hidden-1',
      cdpPort: 9317,
      sessionId: 'session-1',
      targetLifecycleHandler: () => {},
      connectionErrorHandler: () => {},
      connectionCloseHandler: () => {},
    }],
    ['hidden-2', {
      ws: second,
      targetId: 'hidden-2',
      cdpPort: 9317,
      sessionId: 'session-2',
      targetLifecycleHandler: () => {},
      connectionErrorHandler: () => {},
      connectionCloseHandler: () => {},
    }],
  ]));

  await connector.disconnect('1');

  assert.equal(connector.get('1'), null);
  assert.equal(connector.hasOpenPages('1'), false);
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);
});
