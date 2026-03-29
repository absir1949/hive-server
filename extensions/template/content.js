/**
 * Content Script
 *
 * Injected into WeChat Channels pages to extract data and monitor DOM changes.
 * Runs at document_end to ensure page is fully loaded.
 */

console.log('[Hive Bridge] Content script loaded');

/**
 * Extract page data
 * Adjust selectors based on actual WeChat Channels page structure
 */
function extractPageData() {
  const data = {
    url: window.location.href,
    title: document.title,
    timestamp: Date.now()
  };

  // Extract unread message count
  const unreadBadge = document.querySelector('.unread-badge, [class*="unread"], [class*="badge"]');
  if (unreadBadge) {
    data.unreadCount = unreadBadge.textContent || unreadBadge.getAttribute('data-count') || '0';
  }

  // Extract order list (adjust selectors based on actual page)
  const orderItems = document.querySelectorAll('[class*="order"], [data-order-id], .order-item');
  if (orderItems.length > 0) {
    data.orders = Array.from(orderItems).map(el => ({
      id: el.getAttribute('data-order-id') || el.id,
      status: el.querySelector('[class*="status"]')?.textContent || '',
      amount: el.querySelector('[class*="amount"], [class*="price"]')?.textContent || ''
    }));
  }

  // Extract message list
  const messageItems = document.querySelectorAll('[class*="message"], [class*="chat"], .message-item');
  if (messageItems.length > 0) {
    data.messages = Array.from(messageItems).map(el => ({
      id: el.id || el.getAttribute('data-id'),
      content: el.querySelector('[class*="content"]')?.textContent?.substring(0, 100) || '',
      time: el.querySelector('[class*="time"]')?.textContent || ''
    }));
  }

  // Extract notification count
  const notificationBadge = document.querySelector('[class*="notification"], [class*="notify"]');
  if (notificationBadge) {
    data.notificationCount = notificationBadge.textContent || '0';
  }

  return data;
}

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extract') {
    const data = extractPageData();
    sendResponse(data);
  }
  if (msg.action === 'click') {
    const el = document.querySelector(msg.selector);
    if (el) {
      el.click();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Element not found' });
    }
  }
  return true;
});

/**
 * Monitor DOM changes and report updates
 * Only sends data when there are actual changes to avoid excessive messages
 */
let lastData = null;
let lastSentTime = 0;
const MIN_SEND_INTERVAL = 1000; // Throttle to at most once per second

const observer = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastSentTime < MIN_SEND_INTERVAL) {
    return; // Skip if too soon since last send
  }

  const newData = extractPageData();

  // Only send if data changed
  if (JSON.stringify(newData) !== JSON.stringify(lastData)) {
    lastData = newData;
    lastSentTime = now;

    chrome.runtime.sendMessage({
      type: 'pageUpdate',
      data: newData
    });
  }
});

// Start observing when DOM is ready
if (document.body) {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: ['class', 'data-*'] // Only observe relevant attributes
  });
} else {
  // Wait for DOM to be ready
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'data-*']
    });
  });
}

// Send initial data after page loads
window.addEventListener('load', () => {
  setTimeout(() => {
    const data = extractPageData();
    chrome.runtime.sendMessage({
      type: 'pageUpdate',
      data: data
    });
  }, 1000);
});

console.log('[Hive Bridge] Content script initialized');
