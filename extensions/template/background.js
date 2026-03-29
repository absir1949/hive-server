/**
 * Background Service Worker
 *
 * Integrates WebSocket communication for data exchange with Electron main process.
 * Each profile extension loads its unique profileId from profile-config.json.
 */

console.log('[Hive Bridge] Background service worker initializing...');

// WebSocket client
let ws = null;
let profileId = null;
let profileConfig = null;
const WS_PORT = 37567;

/**
 * Load profile configuration from profile-config.json
 * This file is generated during extension creation by Electron
 */
async function loadProfileConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL('profile-config.json'));
    if (!response.ok) {
      throw new Error(`Failed to load profile-config.json: ${response.status}`);
    }
    profileConfig = await response.json();
    profileId = profileConfig.profileId;
    console.log('[Hive Bridge] Loaded config:', profileConfig);
    return profileConfig;
  } catch (e) {
    console.error('[Hive Bridge] Failed to load profile config:', e);
    // Fallback: generate temporary profileId
    profileId = 'profile_unknown_' + Date.now();
    profileConfig = {
      profileId: profileId,
      wsPort: WS_PORT,
      wsUrl: `ws://127.0.0.1:${WS_PORT}`
    };
    return profileConfig;
  }
}

/**
 * Connect to WebSocket server
 */
function connectWebSocket() {
  const wsUrl = profileConfig?.wsUrl || `ws://127.0.0.1:${WS_PORT}`;
  console.log('[Hive Bridge] Connecting to WebSocket:', wsUrl);

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('[Hive Bridge] WebSocket connected');

    // Send registration message with profileId
    ws.send(JSON.stringify({
      type: 'register',
      profileId: profileId,
      timestamp: Date.now()
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      await handleMessage(msg);
    } catch (e) {
      console.error('[Hive Bridge] Message parse error:', e);
    }
  };

  ws.onclose = () => {
    console.log('[Hive Bridge] WebSocket disconnected, reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('[Hive Bridge] WebSocket error:', err);
  };
}

/**
 * Handle messages from Electron
 */
async function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      console.log('[Hive Bridge] Registration confirmed for profile:', msg.profileId);
      break;

    case 'extractData':
      // Request page data from content script
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'extract' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('[Hive Bridge] Content script error:', chrome.runtime.lastError);
            ws.send(JSON.stringify({
              type: 'dataResponse',
              profileId: profileId,
              error: chrome.runtime.lastError.message
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'dataResponse',
              profileId: profileId,
              data: response
            }));
          }
        });
      }
      break;

    case 'clickElement':
      // Click element on page
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'click',
            selector: msg.selector
          });
        }
      });
      break;
  }
}

/**
 * Listen for messages from content script
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'pageUpdate') {
    // Forward page data to Electron via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'pageUpdate',
        profileId: profileId,
        data: msg.data
      }));
    }
  }
  return true;
});

/**
 * Initialize on service worker start
 */
loadProfileConfig().then(() => {
  console.log('[Hive Bridge] Initialization complete, connecting WebSocket...');
  connectWebSocket();
}).catch((e) => {
  console.error('[Hive Bridge] Initialization failed:', e);
  // Still try to connect with fallback config
  connectWebSocket();
});
