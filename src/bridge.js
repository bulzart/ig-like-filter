// IG Like Filter: extension-world bridge (ISOLATED world, document_start).
// The page-world filter cannot read chrome.storage, so this script hands settings over:
//   - mirrors them into localStorage, which main.js reads synchronously at document_start
//     (before the server-rendered first page is parsed);
//   - posts every change to the page so it applies without a reload;
//   - keeps the latest stats from the page for the popup.
(() => {
  'use strict';
  const LS_KEY = 'iglf:settings';
  let lastStats = null;

  // Nothing saved yet -> {} so the page falls back to its defaults (not a stale mirror).
  function push(settings) {
    const s = settings || {};
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) { /* storage blocked */ }
    window.postMessage({ __iglf: 'settings', settings: s }, location.origin);
  }

  chrome.storage.sync.get('settings').then(({ settings }) => push(settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) push(changes.settings.newValue);
  });

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__iglf === 'stats') lastStats = e.data.stats;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'iglf:getStats') sendResponse(lastStats);
  });
})();
