/**
 * Fingerprint Generator Module
 *
 * Generates unique but consistent browser fingerprint profiles for each profile
 * based on predefined templates with subtle variations.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class FingerprintGenerator {
  constructor() {
    this.templatesPath = path.join(__dirname, '../config/fingerprints.json');
    this.profilesPath = path.join(__dirname, '../fingerprint-profiles');

    // Ensure profiles directory exists
    if (!fs.existsSync(this.profilesPath)) {
      fs.mkdirSync(this.profilesPath, { recursive: true });
    }
  }

  /**
   * Load fingerprint templates from config file
   * @returns {Array} Array of template objects
   */
  loadTemplates() {
    try {
      const data = fs.readFileSync(this.templatesPath, 'utf8');
      const config = JSON.parse(data);
      return config.templates || [];
    } catch (error) {
      console.error('[FingerprintGenerator] Failed to load templates:', error.message);
      return [];
    }
  }

  /**
   * Generate a unique profile ID
   * @param {string} templateId - Base template ID
   * @param {string} profileId - Profile identifier
   * @returns {string} Unique profile ID
   */
  generateProfileId(templateId, profileId) {
    const hash = crypto.createHash('sha256')
      .update(`${templateId}:${profileId}:${Date.now()}`)
      .digest('hex')
      .substring(0, 12);
    return `fp_${templateId}_${hash}`;
  }

  /**
   * Add subtle variations to make each profile unique
   * @param {Object} profile - Fingerprint profile to modify
   */
  addVariations(profile) {
    // Vary screen dimensions slightly (±10px)
    if (profile.screen) {
      const widthVariation = Math.floor(Math.random() * 20) - 10;
      const heightVariation = Math.floor(Math.random() * 20) - 10;

      profile.screen.width = Math.max(1024, profile.screen.width + widthVariation);
      profile.screen.height = Math.max(768, profile.screen.height + heightVariation);
      profile.screen.availWidth = profile.screen.width;
      profile.screen.availHeight = profile.screen.height - 40; // Taskbar
    }

    // Vary hardware concurrency (±2 cores, minimum 2)
    if (profile.navigator && profile.navigator.hardwareConcurrency) {
      const variation = Math.floor(Math.random() * 4) - 2;
      profile.navigator.hardwareConcurrency = Math.max(
        2,
        profile.navigator.hardwareConcurrency + variation
      );
    }

    // Add random noise seed for canvas
    if (profile.canvas) {
      profile.canvas.noiseSeed = Math.random().toString(36).substring(2, 10);
    }

    // Slight timezone offset variation (±15 minutes)
    if (profile.timezone) {
      const offsetVariation = Math.floor(Math.random() * 30) - 15;
      profile.timezone.offset = profile.timezone.offset + offsetVariation;
    }

    // Vary WebGL max render buffer size slightly
    if (profile.webgl && profile.webgl.maxRenderBufferSize) {
      const webglVariation = Math.floor(Math.random() * 256) - 128;
      profile.webgl.maxRenderBufferSize = Math.max(
        4096,
        profile.webgl.maxRenderBufferSize + webglVariation
      );
    }
  }

  /**
   * Generate a fingerprint profile from a template
   * @param {string} templateId - Template ID to use
   * @param {string} profileId - Profile identifier
   * @returns {Object} Generated fingerprint profile
   */
  generateFromTemplate(templateId, profileId) {
    const templates = this.loadTemplates();
    const template = templates.find(t => t.id === templateId);

    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    // Deep clone template
    const profile = JSON.parse(JSON.stringify(template));

    // Add unique identifiers
    profile.templateId = templateId;
    profile.profileId = profileId;
    profile.generatedAt = new Date().toISOString();

    // Add subtle variations
    this.addVariations(profile);

    console.log(`[FingerprintGenerator] Generated profile ${profile.profileId} for profile ${profileId}`);
    return profile;
  }

  /**
   * Save a profile to disk
   * @param {Object} profile - Profile to save
   * @returns {string} Path to saved profile
   */
  saveProfile(profile) {
    const profilePath = path.join(this.profilesPath, `${profile.profileId}.json`);
    try {
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      console.log(`[FingerprintGenerator] Saved profile for profile ${profile.profileId}`);
      return profilePath;
    } catch (error) {
      console.error(`[FingerprintGenerator] Failed to save profile:`, error.message);
      throw error;
    }
  }

  /**
   * Load a fingerprint profile for a specific profile
   * @param {string} profileId - Profile identifier
   * @returns {Object|null} Loaded profile or null if not found
   */
  loadProfile(profileId) {
    const profilePath = path.join(this.profilesPath, `${profileId}.json`);
    try {
      if (!fs.existsSync(profilePath)) {
        return null;
      }
      const data = fs.readFileSync(profilePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`[FingerprintGenerator] Failed to load profile for profile ${profileId}:`, error.message);
      return null;
    }
  }

  /**
   * Get existing profile or create new one
   * @param {string} profileId - Profile identifier
   * @param {string} templateId - Template ID to use for new profiles
   * @returns {Object} Fingerprint profile
   */
  getOrCreateProfile(profileId, templateId = 'chrome_win10_desktop') {
    // Try to load existing profile
    const existing = this.loadProfile(profileId);
    if (existing) {
      console.log(`[FingerprintGenerator] Using existing profile ${existing.profileId} for profile ${profileId}`);
      return existing;
    }

    // Generate new profile
    console.log(`[FingerprintGenerator] Generating new profile for profile ${profileId} from template ${templateId}`);
    const profile = this.generateFromTemplate(templateId, profileId);
    this.saveProfile(profile);
    return profile;
  }

  /**
   * Format profile for injection into JavaScript
   * @param {Object} profile - Fingerprint profile
   * @returns {string} JavaScript code snippet
   */
  formatForInjection(profile) {
    const config = JSON.stringify(profile, null, 2);
    return `const __FP_CONFIG__ = ${config};`;
  }

  /**
   * Regenerate a fingerprint profile
   * @param {string} profileId - Profile identifier
   * @param {string} templateId - Template ID to use
   * @returns {Object} New fingerprint profile
   */
  regenerateProfile(profileId, templateId) {
    const profile = this.generateFromTemplate(templateId, profileId);
    this.saveProfile(profile);
    return profile;
  }

  /**
   * List all available template IDs
   * @returns {Array<string>} Array of template IDs
   */
  listTemplateIds() {
    const templates = this.loadTemplates();
    return templates.map(t => t.id);
  }

  /**
   * Get template by ID
   * @param {string} templateId - Template ID
   * @returns {Object|null} Template object or null
   */
  getTemplate(templateId) {
    const templates = this.loadTemplates();
    return templates.find(t => t.id === templateId) || null;
  }
}

// Export singleton instance
module.exports = new FingerprintGenerator();
