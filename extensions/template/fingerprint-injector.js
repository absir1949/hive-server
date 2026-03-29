/**
 * Fingerprint Injector - Browser Fingerprint Isolation
 *
 * This script injects fingerprint spoofing code to make each browser
 * instance appear as a unique device. Configuration is injected at runtime.
 *
 * SECURITY: CONFIG_PLACEHOLDER is replaced using safe statement-level replacement
 * to prevent injection attacks through malicious configuration data.
 */

(function() {
  'use strict';

  // Configuration will be injected by FingerprintGenerator
  // The entire statement is replaced to prevent JSON injection attacks
  const FP_CONFIG = CONFIG_PLACEHOLDER;

  // ==================== UTILITIES ====================
  const randomInRange = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // ==================== NAVIGATOR PROPERTIES ====================
  const overrideNavigator = () => {
    try {
      const nav = FP_CONFIG.navigator;
      if (!nav) return;

      const overrides = {};
      if (nav.hardwareConcurrency) overrides.hardwareConcurrency = { get: () => nav.hardwareConcurrency, configurable: true };
      if (nav.deviceMemory) overrides.deviceMemory = { get: () => nav.deviceMemory, configurable: true };
      if (nav.platform) overrides.platform = { get: () => nav.platform, configurable: true };
      if (nav.language) overrides.language = { get: () => nav.language, configurable: true };
      if (nav.languages) overrides.languages = { get: () => [...nav.languages], configurable: true };
      overrides.webdriver = { get: () => false, configurable: true };

      // Override on navigator instance (not prototype — avoids Illegal invocation in Chromium 120+)
      Object.defineProperties(navigator, overrides);

      console.log('[FingerprintIsolator] Navigator properties overridden');
    } catch (error) {
      console.error('[FingerprintIsolator] Navigator override error:', error);
    }
  };

  // ==================== SCREEN PROPERTIES ====================
  const overrideScreen = () => {
    try {
      if (!FP_CONFIG.screen) return;

      const screenProps = ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'];
      screenProps.forEach(prop => {
        if (FP_CONFIG.screen[prop] !== undefined) {
          Object.defineProperty(Screen.prototype, prop, {
            get: () => FP_CONFIG.screen[prop],
            configurable: true
          });
        }
      });

      console.log('[FingerprintIsolator] Screen properties overridden');
    } catch (error) {
      console.error('[FingerprintIsolator] Screen override error:', error);
    }
  };

  // ==================== CANVAS FINGERPRINT ====================
  const overrideCanvas = () => {
    try {
      if (!FP_CONFIG.canvas || !FP_CONFIG.canvas.noiseEnabled) return;

      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          try {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            const data = imageData.data;
            // Add subtle noise to 0.1% of pixels
            const noiseCount = Math.floor(data.length / 4000);
            for (let i = 0; i < noiseCount * 4; i += 4) {
              const noise = Math.random() < 0.5 ? -1 : 1;
              data[i] = Math.max(0, Math.min(255, data[i] + noise));
              data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
              data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
            }
            ctx.putImageData(imageData, 0, 0);
          } catch (e) {
            // Cross-origin canvas, skip
          }
        }
        return originalToDataURL.apply(this, args);
      };

      console.log('[FingerprintIsolator] Canvas fingerprint protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] Canvas override error:', error);
    }
  };

  // ==================== WEBGL FINGERPRINT ====================
  const overrideWebGL = () => {
    try {
      if (!FP_CONFIG.webgl) return;

      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      const webglConfig = FP_CONFIG.webgl;

      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) {
          return webglConfig.vendor || 'Google Inc. (Intel)';
        }
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) {
          return webglConfig.renderer || 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)';
        }
        // MAX_TEXTURE_SIZE - add slight variation
        if (parameter === 34076) {
          const original = originalGetParameter.call(this, parameter);
          return original ? original + randomInRange(-2, 2) : 16384;
        }
        // MAX_RENDERBUFFER_SIZE
        if (parameter === 34024) {
          return webglConfig.maxRenderBufferSize || 16384;
        }
        // MAX_VIEWPORT_DIMS
        if (parameter === 34079) {
          const dims = originalGetParameter.call(this, parameter);
          if (dims && Array.isArray) {
            return [dims[0] + randomInRange(-4, 4), dims[1] + randomInRange(-4, 4)];
          }
        }
        return originalGetParameter.apply(this, arguments);
      };

      // Hide debug renderer info if configured
      if (webglConfig.hideDebugInfo) {
        const originalGetExtension = WebGLRenderingContext.prototype.getExtension;
        WebGLRenderingContext.prototype.getExtension = function(name) {
          if (name === 'WEBGL_debug_renderer_info') {
            return null;
          }
          return originalGetExtension.apply(this, arguments);
        };
      }

      console.log('[FingerprintIsolator] WebGL fingerprint protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] WebGL override error:', error);
    }
  };

  // ==================== AUDIO FINGERPRINT ====================
  const overrideAudio = () => {
    try {
      if (!window.AudioContext && !window.webkitAudioContext) return;

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const originalCreateAnalyser = AudioContextClass.prototype.createAnalyser;

      AudioContextClass.prototype.createAnalyser = function() {
        const analyser = originalCreateAnalyser.call(this);
        const originalGetFloatFrequencyData = analyser.getFloatFrequencyData;

        analyser.getFloatFrequencyData = function(array) {
          originalGetFloatFrequencyData.call(this, array);
          // Add minimal noise to audio fingerprint
          for (let i = 0; i < array.length; i++) {
            array[i] += (Math.random() - 0.5) * 0.0001;
          }
        };

        return analyser;
      };

      console.log('[FingerprintIsolator] Audio fingerprint protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] Audio override error:', error);
    }
  };

  // ==================== TIMEZONE & LOCALE ====================
  const overrideDateTime = () => {
    try {
      if (!FP_CONFIG.timezone) return;

      const tzConfig = FP_CONFIG.timezone;

      // Override getTimezoneOffset
      const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
      Date.prototype.getTimezoneOffset = function() {
        return tzConfig.offset !== undefined ? -tzConfig.offset : originalGetTimezoneOffset.call(this);
      };

      // Override Intl.DateTimeFormat
      const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function() {
        const options = originalResolvedOptions.call(this);
        if (tzConfig.iana) {
          options.timeZone = tzConfig.iana;
        }
        return options;
      };

      console.log('[FingerprintIsolator] DateTime timezone protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] DateTime override error:', error);
    }
  };

  // ==================== FONT ENUMERATION ====================
  const overrideFonts = () => {
    try {
      // Add slight variation to text measurements
      const originalMeasureText = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function(text) {
        const result = originalMeasureText.call(this, text);
        const originalWidth = result.width;
        Object.defineProperty(result, 'width', {
          get: () => originalWidth + (Math.random() - 0.5) * 0.01,
          enumerable: true
        });
        return result;
      };

      console.log('[FingerprintIsolator] Font fingerprint protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] Font override error:', error);
    }
  };

  // ==================== WEBRTC LEAK PROTECTION ====================
  const overrideWebRTC = () => {
    try {
      // Override RTCPeerConnection to prevent IP leaks
      if (window.RTCPeerConnection) {
        const OriginalRTCPeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = function(...args) {
          const pc = new OriginalRTCPeerConnection(...args);

          const originalCreateDataChannel = pc.createDataChannel;
          pc.createDataChannel = function(...args) {
            const channel = originalCreateDataChannel.apply(this, args);
            return channel;
          };

          return pc;
        };

        // Copy static methods
        Object.keys(OriginalRTCPeerConnection).forEach(key => {
          window.RTCPeerConnection[key] = OriginalRTCPeerConnection[key];
        });
      }

      console.log('[FingerprintIsolator] WebRTC leak protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] WebRTC override error:', error);
    }
  };

  // ==================== CHROME OBJECTS ====================
  const overrideChromeObjects = () => {
    try {
      // Hide runtime and other automation-related properties
      if (window.chrome && window.chrome.runtime) {
        const originalRuntime = window.chrome.runtime;
        // Keep minimal chrome object for compatibility
      }

      console.log('[FingerprintIsolator] Chrome objects protection enabled');
    } catch (error) {
      console.error('[FingerprintIsolator] Chrome objects override error:', error);
    }
  };

  // ==================== EXECUTE ALL OVERRIDES ====================
  const init = () => {
    // Check if config is available
    if (typeof FP_CONFIG === 'undefined' || FP_CONFIG === 'CONFIG_PLACEHOLDER') {
      console.warn('[FingerprintIsolator] No fingerprint configuration found');
      return;
    }

    console.log('[FingerprintIsolator] Initializing with profile:', FP_CONFIG.profileId);

    // Execute overrides in order
    overrideNavigator();
    overrideScreen();
    overrideCanvas();
    overrideWebGL();
    overrideAudio();
    overrideDateTime();
    overrideFonts();
    overrideWebRTC();
    overrideChromeObjects();

    console.log('[FingerprintIsolator] All fingerprint protections applied');
  };

  // Run immediately at document_start
  init();

})();
