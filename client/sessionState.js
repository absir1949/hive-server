function isInteractiveBrowser(browser) {
  return browser?.status === 'running'
    && browser?.browserMode === 'vnc'
    && browser?.vncActive === true;
}

module.exports = { isInteractiveBrowser };
