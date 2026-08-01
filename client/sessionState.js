function isInteractiveBrowser(browser) {
  return browser?.status === 'running' && browser?.browserMode === 'vnc';
}

module.exports = { isInteractiveBrowser };
