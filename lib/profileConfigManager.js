/**
 * Profile Configuration Manager Module
 *
 * Manages profile configurations including fingerprint profile assignment
 * and proxy configuration.
 */

const fs = require('fs');
const path = require('path');

class ProfileConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, '../config/profiles.json');
    this.profiles = this.loadConfig();
  }

  /**
   * Load profile configuration from file
   * @returns {Object} Profile configuration object
   */
  loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) {
        console.log('[ProfileConfigManager] Config file not found, creating default');
        const defaultConfig = this.createDefaultConfig();
        this.saveConfig(defaultConfig);
        return defaultConfig;
      }
      const data = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[ProfileConfigManager] Failed to load config:', error.message);
      return {};
    }
  }

  /**
   * Save profile configuration to file
   * @param {Object} config - Configuration to save
   * @returns {boolean} Success status
   */
  saveConfig(config) {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      this.profiles = config;
      return true;
    } catch (error) {
      console.error('[ProfileConfigManager] Failed to save config:', error.message);
      return false;
    }
  }

  /**
   * Create default profile configuration
   * @returns {Object} Default configuration
   */
  createDefaultConfig() {
    return {
      profile_001: {
        id: 'profile_001',
        name: '默认配置1',
        proxyId: null,
        fingerprintProfileId: 'chrome_win10_desktop',
        isActive: true,
        notes: '默认配置'
      },
      profile_002: {
        id: 'profile_002',
        name: '默认配置2',
        proxyId: null,
        fingerprintProfileId: 'chrome_win10_laptop',
        isActive: true,
        notes: '备用配置'
      }
    };
  }

  /**
   * Reload configuration from file
   */
  reload() {
    this.profiles = this.loadConfig();
  }

  /**
   * Get configuration for a specific profile
   * @param {string} profileId - Profile identifier
   * @returns {Object|null} Profile configuration or null
   */
  getProfileConfig(profileId) {
    this.reload(); // Ensure we have latest config
    return this.profiles[profileId] || null;
  }

  /**
   * Get all profile configurations
   * @returns {Object} All profile configurations
   */
  getAllProfiles() {
    this.reload();
    return this.profiles;
  }

  /**
   * Get array of all profiles
   * @returns {Array} Array of profile objects
   */
  getProfileList() {
    this.reload();
    return Object.values(this.profiles);
  }

  /**
   * Get active profiles only
   * @returns {Array} Array of active profile objects
   */
  getActiveProfiles() {
    this.reload();
    return Object.values(this.profiles).filter(profile => profile.isActive);
  }

  /**
   * Add or update a profile configuration
   * @param {Object} profile - Profile configuration object
   * @returns {boolean} Success status
   */
  saveProfile(profile) {
    if (!profile.id) {
      console.error('[ProfileConfigManager] Profile ID is required');
      return false;
    }

    // Ensure required fields
    const profileConfig = {
      id: profile.id,
      name: profile.name || `Profile ${profile.id}`,
      proxyId: profile.proxyId || null,
      fingerprintProfileId: profile.fingerprintProfileId || 'chrome_win10_desktop',
      isActive: profile.isActive !== undefined ? profile.isActive : true,
      notes: profile.notes || ''
    };

    this.profiles[profileConfig.id] = profileConfig;
    return this.saveConfig(this.profiles);
  }

  /**
   * Update specific fields of a profile configuration
   * @param {string} profileId - Profile identifier
   * @param {Object} updates - Fields to update
   * @returns {boolean} Success status
   */
  updateProfileConfig(profileId, updates) {
    const profile = this.profiles[profileId];
    if (!profile) {
      console.error(`[ProfileConfigManager] Profile ${profileId} not found`);
      return false;
    }

    // Merge updates with existing config
    Object.assign(profile, updates);
    return this.saveConfig(this.profiles);
  }

  /**
   * Delete a profile configuration
   * @param {string} profileId - Profile identifier
   * @returns {boolean} Success status
   */
  deleteProfile(profileId) {
    if (!this.profiles[profileId]) {
      console.error(`[ProfileConfigManager] Profile ${profileId} not found`);
      return false;
    }

    delete this.profiles[profileId];
    return this.saveConfig(this.profiles);
  }

  /**
   * Set proxy for a profile
   * @param {string} profileId - Profile identifier
   * @param {string|null} proxyId - Proxy identifier or null to remove
   * @returns {boolean} Success status
   */
  setProfileProxy(profileId, proxyId) {
    return this.updateProfileConfig(profileId, { proxyId });
  }

  /**
   * Set fingerprint profile for a profile
   * @param {string} profileId - Profile identifier
   * @param {string} fingerprintId - Fingerprint profile ID
   * @returns {boolean} Success status
   */
  setProfileFingerprint(profileId, fingerprintId) {
    return this.updateProfileConfig(profileId, { fingerprintProfileId: fingerprintId });
  }

  /**
   * Activate or deactivate a profile
   * @param {string} profileId - Profile identifier
   * @param {boolean} isActive - Active status
   * @returns {boolean} Success status
   */
  setProfileActive(profileId, isActive) {
    return this.updateProfileConfig(profileId, { isActive });
  }

  /**
   * Check if a profile exists
   * @param {string} profileId - Profile identifier
   * @returns {boolean} Existence status
   */
  profileExists(profileId) {
    return !!this.profiles[profileId];
  }

  /**
   * Get profile count
   * @returns {number} Number of profiles
   */
  getProfileCount() {
    return Object.keys(this.profiles).length;
  }

  /**
   * Get active profile count
   * @returns {number} Number of active profiles
   */
  getActiveProfileCount() {
    return this.getActiveProfiles().length;
  }
}

// Export singleton instance
module.exports = new ProfileConfigManager();
