const BROWSER_MODES = Object.freeze({
  VNC: 'vnc',
  HEADLESS: 'headless',
});

const SUPPORTED_MODES = new Set(Object.values(BROWSER_MODES));

function normalizeBrowserMode(value) {
  const mode = value || BROWSER_MODES.VNC;
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`browserMode must be one of: ${[...SUPPORTED_MODES].join(', ')}`);
  }
  return mode;
}

function isVncMode(value) {
  return normalizeBrowserMode(value) === BROWSER_MODES.VNC;
}

module.exports = {
  BROWSER_MODES,
  normalizeBrowserMode,
  isVncMode,
};
