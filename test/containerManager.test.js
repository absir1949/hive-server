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

test('recover preserves running browsers and revokes stale VNC access', async () => {
  const docker = {
    async listContainers() {
      return [
        {
          Names: ['/hive-4'],
          State: 'running',
          Id: 'vnc-container',
          Ports: [
            { PrivatePort: 9222, PublicPort: 9304 },
            { PrivatePort: 6080, PublicPort: 6104 },
          ],
          Labels: { 'hive.browserMode': 'vnc' },
        },
        {
          Names: ['/hive-5'],
          State: 'running',
          Id: 'headless-container',
          Ports: [{ PrivatePort: 9222, PublicPort: 9305 }],
          Labels: { 'hive.browserMode': 'headless' },
        },
      ];
    },
    getContainer() {
      throw new Error('recover must not stop or remove a running browser');
    },
  };
  const manager = new ContainerManager({ docker });
  const revoked = [];
  manager.disableVncAccess = async (profileId) => revoked.push(String(profileId));

  const recovered = await manager.recover();

  assert.deepEqual(recovered, ['4', '5']);
  assert.deepEqual(revoked, ['4']);
  assert.equal(manager.containers.get('4').browserMode, 'vnc');
  assert.equal(manager.containers.get('5').browserMode, 'headless');
});

test('start never changes the mode of a running authenticated browser', async () => {
  let createCalls = 0;
  const docker = {
    getContainer() {
      throw notFound();
    },
    async createContainer() {
      createCalls += 1;
      return { id: 'container-vnc', async start() {} };
    },
  };
  const manager = new ContainerManager({ docker });
  manager._waitForCDP = async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1' });

  await manager.start('17', { browserMode: 'vnc' });
  await assert.rejects(
    manager.start('17', { browserMode: 'headless' }),
    /explicitly stop it/,
  );

  assert.equal(createCalls, 1);
  assert.equal(manager.containers.get('17').browserMode, 'vnc');
});

test('start never replaces an untracked running browser', async () => {
  let createCalls = 0;
  let removeCalls = 0;
  const docker = {
    getContainer() {
      return {
        async inspect() { return { State: { Running: true } }; },
        async remove() { removeCalls += 1; },
      };
    },
    async createContainer() {
      createCalls += 1;
      return { id: 'replacement', async start() {} };
    },
  };
  const manager = new ContainerManager({ docker });

  await assert.rejects(
    manager.start('17', { browserMode: 'vnc' }),
    /untracked running container/,
  );

  assert.equal(createCalls, 0);
  assert.equal(removeCalls, 0);
});

test('VNC access can be revoked and restored without stopping Chromium', async () => {
  const commands = [];
  const manager = new ContainerManager({ docker: {} });
  manager.containers.set('4', {
    containerId: 'vnc-container',
    cdpPort: 9304,
    vncPort: 6104,
    browserMode: 'vnc',
  });
  manager.execInContainer = async (profileId, command) => {
    commands.push([profileId, command]);
  };

  await manager.disableVncAccess('4');
  await manager.enableVncAccess('4');

  assert.deepEqual(commands, [
    ['4', ['/usr/local/bin/hive-vnc-control', 'stop']],
    ['4', ['/usr/local/bin/hive-vnc-control', 'start']],
  ]);
  assert.equal(manager.containers.has('4'), true);
});

test('graceful shutdown revokes access for tracked VNC containers', async () => {
  const revoked = [];
  const manager = new ContainerManager({ docker: {} });
  manager.containers.set('4', { browserMode: 'vnc' });
  manager.containers.set('5', { browserMode: 'headless' });
  manager.disableVncAccess = async (profileId) => revoked.push(profileId);

  await manager.shutdown();

  assert.deepEqual(revoked, ['4']);
  assert.equal(manager.containers.size, 0);
});
