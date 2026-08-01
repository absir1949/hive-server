const test = require('node:test');
const assert = require('node:assert/strict');
const { isInteractiveBrowser } = require('../client/sessionState');

test('client marks only running VNC browsers as interactive', () => {
  assert.equal(isInteractiveBrowser({ status: 'running', browserMode: 'vnc' }), true);
  assert.equal(isInteractiveBrowser({ status: 'running', browserMode: 'headless' }), false);
  assert.equal(isInteractiveBrowser({ status: 'stopped', browserMode: 'vnc' }), false);
  assert.equal(isInteractiveBrowser(null), false);
});
