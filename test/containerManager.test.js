const test = require('node:test');
const assert = require('node:assert/strict');
const ContainerManager = require('../lib/containerManager');

function notFound() {
  const error = new Error('not found');
  error.statusCode = 404;
  return error;
}

test('headless containers expose CDP but do not bind noVNC', async () => {
  let config;
  const docker = {
    getContainer() {
      throw notFound();
    },
    async createContainer(nextConfig) {
      config = nextConfig;
      return { id: 'container-headless', async start() {} };
    },
  };
  const manager = new ContainerManager({ docker });
  manager._waitForCDP = async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1' });

  const info = await manager.start('17', { browserMode: 'headless' });

  assert.equal(info.browserMode, 'headless');
  assert.equal(info.vncPort, null);
  assert.deepEqual(config.HostConfig.PortBindings, {
    '9222/tcp': [{ HostPort: '9317' }],
  });
  assert.deepEqual(config.Labels, {
    'hive.profileId': '17',
    'hive.browserMode': 'headless',
  });
  assert.ok(config.Env.includes('BROWSER_MODE=headless'));
});

test('VNC containers keep the noVNC port binding', async () => {
  let config;
  const docker = {
    getContainer() {
      throw notFound();
    },
    async createContainer(nextConfig) {
      config = nextConfig;
      return { id: 'container-vnc', async start() {} };
    },
  };
  const manager = new ContainerManager({ docker });
  manager._waitForCDP = async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1' });

  const info = await manager.start('17', { browserMode: 'vnc' });

  assert.equal(info.browserMode, 'vnc');
  assert.equal(info.vncPort, 6117);
  assert.deepEqual(config.HostConfig.PortBindings, {
    '9222/tcp': [{ HostPort: '9317' }],
    '6080/tcp': [{ HostPort: '6117' }],
  });
});
