const fs = require('fs');
const path = require('path');
const fingerprintGenerator = require('./fingerprintGenerator');

const TEMPLATE_DIR = path.resolve(__dirname, '..', 'extensions', 'template');
const DATA_DIR = path.resolve(__dirname, '..', 'data');

class FingerprintEngine {
  /**
   * Build a Chrome extension with injected fingerprint for a profile.
   * - Generates fingerprint from template (or reuses existing)
   * - Copies extension template to data/{profileId}/extension/
   * - Replaces CONFIG_PLACEHOLDER with actual fingerprint data
   *
   * @param {number|string} profileId
   * @param {string} templateId - fingerprint template ID from config/fingerprints.json
   * @returns {string} Extension path inside container: '/data/extension'
   */
  build(profileId, templateId = 'chrome_win10_desktop') {
    const extDir = path.join(DATA_DIR, String(profileId), 'extension');

    // Generate fingerprint (reuses existing if already generated)
    const fingerprint = fingerprintGenerator.getOrCreateProfile(
      String(profileId),
      templateId
    );

    // Copy template files
    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
    }

    const files = fs.readdirSync(TEMPLATE_DIR);
    for (const file of files) {
      let content = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');

      // Inject fingerprint config into the injector script
      if (file === 'fingerprint-injector.js') {
        const configJson = JSON.stringify(fingerprint, null, 2);
        content = content.replace(
          'const FP_CONFIG = CONFIG_PLACEHOLDER;',
          `const FP_CONFIG = ${configJson};`
        );
      }

      fs.writeFileSync(path.join(extDir, file), content);
    }

    console.log(`[FingerprintEngine] Built extension for profile ${profileId} (template: ${templateId})`);

    // Return the path as seen from inside the container
    return '/data/extension';
  }
}

module.exports = FingerprintEngine;
