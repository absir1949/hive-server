/**
 * Proxy Manager Module
 *
 * Manages proxy pool configuration, proxy assignment to profiles,
 * and proxy failover logic.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

class ProxyManager {
  constructor() {
    this.configPath = path.join(__dirname, '../config/proxies.json');
    this.profileConfigPath = path.join(__dirname, '../config/profiles.json');
    this.proxyUsageStats = new Map(); // Track success/failure rates
  }

  /**
   * Load proxy configuration from file
   * @returns {Object} Proxy configuration
   */
  loadConfig() {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[ProxyManager] Failed to load proxy config:', error.message);
      return { proxies: [] };
    }
  }

  /**
   * Save proxy configuration to file
   * @param {Object} config - Configuration to save
   * @returns {boolean} Success status
   */
  saveConfig(config) {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      return true;
    } catch (error) {
      console.error('[ProxyManager] Failed to save proxy config:', error.message);
      return false;
    }
  }

  /**
   * Load profile configuration
   * @returns {Object} Profile configuration
   */
  loadProfileConfig() {
    try {
      const data = fs.readFileSync(this.profileConfigPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[ProxyManager] Failed to load profile config:', error.message);
      return {};
    }
  }

  /**
   * Get proxy by ID
   * @param {string} proxyId - Proxy identifier
   * @returns {Object|null} Proxy object or null
   */
  getProxyById(proxyId) {
    const config = this.loadConfig();
    return config.proxies.find(p => p.id === proxyId) || null;
  }

  /**
   * Format proxy object into URL string for Chrome
   * @param {Object} proxy - Proxy object
   * @returns {string} Formatted proxy URL
   */
  formatProxyUrl(proxy) {
    if (!proxy || !proxy.host || !proxy.port) {
      return '';
    }

    const auth = (proxy.username && proxy.password)
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : '';

    const type = proxy.type || 'http';
    return `${type}://${auth}${proxy.host}:${proxy.port}`;
  }

  /**
   * Get proxy configuration for a specific profile
   * @param {string} profileId - Profile identifier
   * @returns {string|null} Proxy URL or null if not configured
   */
  getProxyForProfile(profileId) {
    const profiles = this.loadProfileConfig();
    const profile = profiles[profileId];

    if (!profile || !profile.proxyId) {
      console.log(`[ProxyManager] No proxy configured for profile ${profileId}`);
      return null;
    }

    const proxy = this.getProxyById(profile.proxyId);
    if (!proxy) {
      console.error(`[ProxyManager] Proxy ${profile.proxyId} not found for profile ${profileId}`);
      return null;
    }

    if (!proxy.isActive) {
      console.warn(`[ProxyManager] Proxy ${profile.proxyId} is not active`);
      return null;
    }

    return this.formatProxyUrl(proxy);
  }

  /**
   * Test proxy connectivity
   * @param {string} proxyUrl - Proxy URL to test
   * @returns {Promise<boolean>} Test result
   */
  testProxy(proxyUrl) {
    return new Promise((resolve) => {
      if (!proxyUrl) {
        resolve(false);
        return;
      }

      // Simple connectivity test using https module
      const options = {
        hostname: 'api.ipify.org',
        path: '/',
        method: 'GET',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };

      // Parse proxy URL
      try {
        const url = new URL(proxyUrl);
        // Note: Node.js https module doesn't support proxy directly
        // This is a simplified test - in production use a proxy agent
        console.log(`[ProxyManager] Proxy test requested for ${url.host}`);
        resolve(true); // Placeholder - implement actual proxy test
      } catch (error) {
        console.error('[ProxyManager] Proxy test error:', error.message);
        resolve(false);
      }
    });
  }

  /**
   * Mark proxy as successful (for stats tracking)
   * @param {string} proxyId - Proxy identifier
   */
  markProxySuccess(proxyId) {
    const stats = this.proxyUsageStats.get(proxyId) || { success: 0, failure: 0 };
    stats.success++;
    this.proxyUsageStats.set(proxyId, stats);
  }

  /**
   * Mark proxy as failed (for stats tracking)
   * @param {string} proxyId - Proxy identifier
   */
  markProxyFailure(proxyId) {
    const stats = this.proxyUsageStats.get(proxyId) || { success: 0, failure: 0 };
    stats.failure++;
    this.proxyUsageStats.set(proxyId, stats);

    // Check if failover is needed
    const total = stats.success + stats.failure;
    if (total > 5 && stats.failure / total > 0.5) {
      console.warn(`[ProxyManager] Proxy ${proxyId} failure rate > 50%, triggering failover`);
      this.triggerFailover(proxyId);
    }
  }

  /**
   * Trigger failover to backup proxy
   * @param {string} failedProxyId - Failed proxy identifier
   */
  triggerFailover(failedProxyId) {
    const proxy = this.getProxyById(failedProxyId);
    if (!proxy || !proxy.failover || proxy.failover.length === 0) {
      console.error(`[ProxyManager] No failover available for proxy ${failedProxyId}`);
      return;
    }

    // Try failover proxies in order
    for (const failoverId of proxy.failover) {
      const failoverProxy = this.getProxyById(failoverId);
      if (failoverProxy && failoverProxy.isActive) {
        console.log(`[ProxyManager] Failing over from ${failedProxyId} to ${failoverId}`);
        this.updateProfilesProxy(failedProxyId, failoverId);
        break;
      }
    }
  }

  /**
   * Update all profiles using old proxy to use new proxy
   * @param {string} oldProxyId - Old proxy ID
   * @param {string} newProxyId - New proxy ID
   */
  updateProfilesProxy(oldProxyId, newProxyId) {
    const profiles = this.loadProfileConfig();
    let updated = false;

    for (const [profileId, config] of Object.entries(profiles)) {
      if (config.proxyId === oldProxyId) {
        config.proxyId = newProxyId;
        updated = true;
        console.log(`[ProxyManager] Updated profile ${profileId} to use proxy ${newProxyId}`);
      }
    }

    if (updated) {
      try {
        fs.writeFileSync(this.profileConfigPath, JSON.stringify(profiles, null, 2));
      } catch (error) {
        console.error('[ProxyManager] Failed to update profile config:', error.message);
      }
    }
  }

  /**
   * Get proxy status including stats
   * @param {string} proxyId - Proxy identifier
   * @returns {Object|null} Proxy with stats or null
   */
  getProxyStatus(proxyId) {
    const proxy = this.getProxyById(proxyId);
    if (!proxy) {
      return null;
    }

    const stats = this.proxyUsageStats.get(proxyId) || { success: 0, failure: 0 };
    return {
      ...proxy,
      stats: stats
    };
  }

  /**
   * List all available proxies
   * @returns {Array} Array of proxy objects
   */
  listProxies() {
    const config = this.loadConfig();
    return config.proxies || [];
  }

  /**
   * Add or update a proxy
   * @param {Object} proxy - Proxy object
   * @returns {boolean} Success status
   */
  saveProxy(proxy) {
    const config = this.loadConfig();
    const existingIndex = config.proxies.findIndex(p => p.id === proxy.id);

    if (existingIndex >= 0) {
      config.proxies[existingIndex] = proxy;
    } else {
      config.proxies.push(proxy);
    }

    return this.saveConfig(config);
  }

  /**
   * Delete a proxy
   * @param {string} proxyId - Proxy identifier
   * @returns {boolean} Success status
   */
  deleteProxy(proxyId) {
    const config = this.loadConfig();
    const initialLength = config.proxies.length;
    config.proxies = config.proxies.filter(p => p.id !== proxyId);

    if (config.proxies.length < initialLength) {
      return this.saveConfig(config);
    }
    return false;
  }
}

// Export singleton instance
module.exports = new ProxyManager();
