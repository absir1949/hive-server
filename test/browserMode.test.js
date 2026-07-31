const test = require('node:test');
const assert = require('node:assert/strict');
const { BROWSER_MODES, isVncMode, normalizeBrowserMode } = require('../lib/browserMode');

test('browser mode defaults to headless for resource-safe startup', () => {
  assert.equal(normalizeBrowserMode(), BROWSER_MODES.HEADLESS);
  assert.equal(normalizeBrowserMode('vnc'), BROWSER_MODES.VNC);
  assert.equal(isVncMode(undefined), false);
});

test('headless mode is supported and is not a VNC mode', () => {
  assert.equal(normalizeBrowserMode('headless'), BROWSER_MODES.HEADLESS);
  assert.equal(isVncMode('headless'), false);
});

test('unsupported browser modes are rejected', () => {
  assert.throws(
    () => normalizeBrowserMode('lightpanda'),
    /browserMode must be one of: vnc, headless/,
  );
});
