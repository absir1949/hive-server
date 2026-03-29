/**
 * Fingerprint Loader — runs in content script (isolated world).
 * Injects fingerprint-injector.js into the page's MAIN world via <script> tag.
 * This is necessary because MV3 "world": "MAIN" is unreliable across Chromium builds.
 */
(function () {
  'use strict';
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('fingerprint-injector.js');
    (document.documentElement || document.head || document.body).appendChild(script);
    script.onload = () => script.remove();
  } catch (e) {
    // Silently fail on restricted pages (chrome://, etc.)
  }
})();
