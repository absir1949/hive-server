/**
 * Input Validator - Security Module
 *
 * Provides input sanitization and validation to prevent:
 * - Command injection (AppleScript, shell commands)
 * - Path traversal attacks
 * - XSS attacks
 *
 * @module inputValidator
 */

/**
 * Whitelist of allowed characters for profile IDs
 * Only alphanumeric, underscore, and hyphen
 */
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,50}$/;

/**
 * Whitelist of allowed characters for profile names
 * Allows Unicode letters, numbers, spaces, and common punctuation
 * Excludes: quotes, backslashes, angle brackets (could break scripts)
 */
const PROFILE_NAME_PATTERN = /^[^"'\\<>{}$()&|;`]{1,100}$/;

/**
 * Maximum length for various inputs
 */
const MAX_LENGTHS = {
  profileId: 50,
  profileName: 100,
  title: 200,
  path: 256
};

/**
 * Validate and sanitize profile ID
 * @param {string} profileId - Profile ID to validate
 * @returns {object} {valid: boolean, sanitized: string, error: string}
 */
function validateProfileId(profileId) {
  if (typeof profileId !== 'string') {
    return { valid: false, sanitized: '', error: 'Profile ID must be a string' };
  }

  if (profileId.length === 0) {
    return { valid: false, sanitized: '', error: 'Profile ID cannot be empty' };
  }

  if (profileId.length > MAX_LENGTHS.profileId) {
    return { valid: false, sanitized: '', error: `Profile ID too long (max ${MAX_LENGTHS.profileId})` };
  }

  if (!PROFILE_ID_PATTERN.test(profileId)) {
    return { valid: false, sanitized: '', error: 'Profile ID contains invalid characters (use alphanumeric, _, -)' };
  }

  return { valid: true, sanitized: profileId, error: null };
}

/**
 * Validate and sanitize profile name
 * @param {string} profileName - Profile name to validate
 * @returns {object} {valid: boolean, sanitized: string, error: string}
 */
function validateProfileName(profileName) {
  if (typeof profileName !== 'string') {
    return { valid: false, sanitized: 'Profile', error: 'Profile name must be a string' };
  }

  if (profileName.length === 0) {
    return { valid: false, sanitized: '', error: 'Profile name cannot be empty' };
  }

  if (profileName.length > MAX_LENGTHS.profileName) {
    return { valid: false, sanitized: '', error: `Profile name too long (max ${MAX_LENGTHS.profileName})` };
  }

  if (!PROFILE_NAME_PATTERN.test(profileName)) {
    return { valid: false, sanitized: '', error: 'Profile name contains invalid characters' };
  }

  return { valid: true, sanitized: profileName, error: null };
}

/**
 * Escape string for safe use in AppleScript
 * Prevents command injection by escaping quotes and special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for AppleScript
 */
function escapeForAppleScript(str) {
  if (typeof str !== 'string') {
    return '';
  }

  // First validate the input doesn't contain dangerous patterns
  const validation = validateProfileName(str);
  if (!validation.valid) {
    console.warn(`[inputValidator] Rejecting unsafe string for AppleScript: ${validation.error}`);
    return 'Profile'; // Fallback to safe default
  }

  // Escape quotes by doubling them (AppleScript convention)
  return str.replace(/"/g, '"& quote &"');
}

/**
 * Escape string for safe use in shell commands
 * Uses single-quote wrapping and escapes any embedded single quotes
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for shell
 */
function escapeForShell(str) {
  if (typeof str !== 'string') {
    return '';
  }

  // Replace any single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Validate path is within a base directory (prevents path traversal)
 * @param {string} userPath - User-provided path component
 * @param {string} baseDir - Base directory that path must be within
 * @returns {object} {valid: boolean, fullPath: string, error: string}
 */
function validatePath(userPath, baseDir) {
  const path = require('path');

  if (typeof userPath !== 'string') {
    return { valid: false, fullPath: '', error: 'Path must be a string' };
  }

  // Check for path traversal attempts
  if (userPath.includes('..') || userPath.includes('~') || userPath.startsWith('/')) {
    return { valid: false, fullPath: '', error: 'Path contains traversal characters' };
  }

  const fullPath = path.resolve(baseDir, userPath);

  // Verify the resolved path is within baseDir
  const normalizedBase = path.resolve(baseDir);
  const normalizedFull = path.resolve(fullPath);

  if (!normalizedFull.startsWith(normalizedBase)) {
    return { valid: false, fullPath: '', error: 'Path traversal detected' };
  }

  return { valid: true, fullPath, error: null };
}

/**
 * Validate and sanitize window title
 * @param {string} title - Window title to validate
 * @returns {object} {valid: boolean, sanitized: string, error: string}
 */
function validateTitle(title) {
  if (typeof title !== 'string') {
    return { valid: false, sanitized: 'Profile', error: 'Title must be a string' };
  }

  if (title.length === 0) {
    return { valid: false, sanitized: 'Profile', error: 'Title cannot be empty' };
  }

  if (title.length > MAX_LENGTHS.title) {
    return { valid: false, sanitized: '', error: `Title too long (max ${MAX_LENGTHS.title})` };
  }

  // Strip any potentially dangerous characters
  const sanitized = title.replace(/["'\\<>{}$()&|;`]/g, '');

  if (sanitized.length === 0) {
    return { valid: false, sanitized: 'Profile', error: 'Title contains only unsafe characters' };
  }

  return { valid: true, sanitized, error: null };
}

/**
 * Validate JSON configuration object
 * @param {object} config - Config object to validate
 * @param {object} schema - Optional schema with required fields and types
 * @returns {object} {valid: boolean, error: string}
 */
function validateConfig(config, schema = null) {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, error: 'Config must be an object' };
  }

  if (schema) {
    for (const [key, spec] of Object.entries(schema)) {
      if (spec.required && !(key in config)) {
        return { valid: false, error: `Missing required field: ${key}` };
      }

      if (key in config) {
        const expectedType = spec.type;
        const actualType = typeof config[key];

        if (expectedType !== actualType) {
          return { valid: false, error: `Field '${key}' must be ${expectedType}, got ${actualType}` };
        }

        // String length validation
        if (expectedType === 'string' && spec.maxLength && config[key].length > spec.maxLength) {
          return { valid: false, error: `Field '${key}' exceeds max length of ${spec.maxLength}` };
        }
      }
    }
  }

  return { valid: true, error: null };
}

module.exports = {
  validateProfileId,
  validateProfileName,
  escapeForAppleScript,
  escapeForShell,
  validatePath,
  validateTitle,
  validateConfig,
  PROFILE_ID_PATTERN,
  PROFILE_NAME_PATTERN,
  MAX_LENGTHS
};
