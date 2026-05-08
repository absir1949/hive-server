const Docker = require('dockerode');
const path = require('path');
const http = require('http');
const fs = require('fs');

const IMAGE = 'hive-chrome';
const CDP_BASE_PORT = 9300;
const VNC_BASE_PORT = 6100;
const DATA_DIR = path.resolve(__dirname, '..', 'data');
// When server runs in Docker, volume mounts must use HOST paths.
// HOST_DATA_DIR overrides DATA_DIR for Docker bind mounts only.
const HOST_DATA_DIR = process.env.HOST_DATA_DIR || DATA_DIR;
const CONTAINER_PREFIX = 'hive-';

class ContainerManager {
  constructor() {
    this.docker = new Docker();
    // profileId → { containerId, cdpPort, vncPort }
    this.containers = new Map();
  }

  /**
   * Extract numeric index from profileId for port allocation.
   * "profile_001" → 1, "profile_123" → 123, "42" → 42
   */
  _portIndex(profileId) {
    const match = profileId.match(/(\d+)/);
    if (match) return parseInt(match[1], 10);
    // Fallback: simple hash for non-numeric IDs
    let hash = 0;
    for (const ch of profileId) {
      hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0xffff;
    }
    return (hash % 500) + 500;
  }

  _ports(profileId) {
    const idx = this._portIndex(profileId);
    return { cdpPort: CDP_BASE_PORT + idx, vncPort: VNC_BASE_PORT + idx };
  }

  _containerName(profileId) {
    return CONTAINER_PREFIX + profileId;
  }

  /**
   * Wait for CDP to be ready (Chrome needs a few seconds to start).
   * Retries GET http://localhost:{cdpPort}/json/version until success or timeout.
   */
  _waitForCDP(cdpPort, timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`CDP not ready on port ${cdpPort} after ${timeoutMs}ms`));
        }
        const req = http.get(`http://127.0.0.1:${cdpPort}/json/version`, (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve(JSON.parse(data)));
        });
        req.on('error', () => setTimeout(attempt, 500));
        req.setTimeout(2000, () => {
          req.destroy();
          setTimeout(attempt, 500);
        });
      };
      attempt();
    });
  }

  /**
   * Start a container for the given profile.
   * If container already exists (leftover from previous run), remove it first.
   */
  async start(profileId, options = {}) {
    // Already tracked and running
    if (this.containers.has(profileId)) {
      return this.containers.get(profileId);
    }

    const { cdpPort, vncPort } = this._ports(profileId);
    const containerName = this._containerName(profileId);
    const dataPath = path.join(HOST_DATA_DIR, profileId);

    // Clean up leftover container with same name
    try {
      const old = this.docker.getContainer(containerName);
      await old.stop().catch(() => {});
      await old.remove();
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }

    // Environment variables for Chrome
    const env = [];
    env.push(`TZ=${options.timezone || 'Asia/Shanghai'}`);
    if (options.proxy) env.push(`CHROME_PROXY=${options.proxy}`);
    if (options.userAgent) env.push(`CHROME_USER_AGENT=${options.userAgent}`);
    if (options.extension) env.push(`CHROME_EXTENSION=${options.extension}`);
    if (options.url) env.push(`CHROME_URL=${options.url}`);

    const container = await this.docker.createContainer({
      Image: IMAGE,
      name: containerName,
      Env: env,
      Labels: { 'hive.profileId': profileId },
      HostConfig: {
        PortBindings: {
          '9222/tcp': [{ HostPort: String(cdpPort) }],
          '6080/tcp': [{ HostPort: String(vncPort) }],
        },
        Binds: [`${dataPath}:/data`],
        ShmSize: 268435456, // 256MB — Chrome needs more than Docker's default 64MB
      },
    });

    await container.start();

    // Wait for Chrome to be ready
    await this._waitForCDP(cdpPort);

    const info = { containerId: container.id, cdpPort, vncPort };
    this.containers.set(profileId, info);
    return info;
  }

  /**
   * Stop and remove a container. Data persists in data/{profileId}/.
   */
  async stop(profileId) {
    const containerName = this._containerName(profileId);
    try {
      const container = this.docker.getContainer(containerName);
      await container.stop();
      await container.remove();
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    this.containers.delete(profileId);
  }

  /**
   * Get status of a single profile's container.
   * Returns 'running', 'stopped', or 'not_found'.
   */
  async status(profileId) {
    const containerName = this._containerName(profileId);
    try {
      const container = this.docker.getContainer(containerName);
      const data = await container.inspect();
      return data.State.Running ? 'running' : 'stopped';
    } catch (err) {
      if (err.statusCode === 404) return 'not_found';
      throw err;
    }
  }

  /**
   * List all hive-* containers with their status and ports.
   * Reads from Docker directly — source of truth.
   */
  async list() {
    const allContainers = await this.docker.listContainers({
      all: true,
      filters: { name: [CONTAINER_PREFIX] },
    });

    return allContainers
      .filter((c) => c.Names.some((n) => n.startsWith('/' + CONTAINER_PREFIX)))
      .map((c) => {
        const name = c.Names.find((n) => n.startsWith('/' + CONTAINER_PREFIX));
        const profileId = name.slice(('/' + CONTAINER_PREFIX).length);

        const ports = {};
        for (const p of c.Ports) {
          if (p.PrivatePort === 9222) ports.cdpPort = p.PublicPort;
          if (p.PrivatePort === 6080) ports.vncPort = p.PublicPort;
        }

        return {
          profileId,
          status: c.State === 'running' ? 'running' : 'stopped',
          containerId: c.Id,
          cdpPort: ports.cdpPort,
          vncPort: ports.vncPort,
        };
      });
  }

  /**
   * Recover after Server restart: scan running hive-* containers,
   * rebuild internal Map from Docker state (source of truth).
   */
  async recover() {
    const all = await this.list();
    const recovered = [];

    for (const c of all) {
      if (c.status === 'running' && c.cdpPort && c.vncPort) {
        this.containers.set(c.profileId, {
          containerId: c.containerId,
          cdpPort: c.cdpPort,
          vncPort: c.vncPort,
        });
        recovered.push(c.profileId);
      }
    }

    if (recovered.length > 0) {
      console.log(`Recovered ${recovered.length} running containers: ${recovered.join(', ')}`);
    }
    return recovered;
  }

  /**
   * Copy a local file into a container's /tmp directory.
   * Returns the container-internal path.
   */
  async copyFileToContainer(profileId, localPath, fileName) {
    const containerName = this._containerName(profileId);
    const container = this.docker.getContainer(containerName);
    const containerPath = `/tmp/${fileName}`;
    const data = fs.readFileSync(localPath);

    await new Promise((resolve, reject) => {
      const pack = require('tar-stream').pack();
      // Synchronous entry — data is fully written before finalize
      pack.entry({ name: fileName, size: data.length }, data);
      pack.finalize();

      const chunks = [];
      pack.on('data', (c) => chunks.push(c));
      pack.on('end', () => {
        container.putArchive(Buffer.concat(chunks), { path: '/tmp' })
          .then(resolve)
          .catch(reject);
      });
      pack.on('error', reject);
    });

    return containerPath;
  }

  /**
   * Execute a command inside a running container.
   * Returns { stdout, stderr }.
   */
  async execInContainer(profileId, cmd) {
    const containerName = this._containerName(profileId);
    const container = this.docker.getContainer(containerName);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Env: ['DISPLAY=:1'],
    });
    const stream = await exec.start();
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    });
  }

  /**
   * Graceful shutdown: clear internal state.
   * Containers keep running — they're independent of the Server process.
   */
  async shutdown() {
    this.containers.clear();
  }
}

module.exports = ContainerManager;
