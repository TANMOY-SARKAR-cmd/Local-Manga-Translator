importScripts('utils.js');

async function ensureDefaults() {
  const settings = await MangaUtils.getSettings();
  await MangaUtils.setSettings(settings);
}

async function sendToTab(tabId, payload) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    console.warn('Failed to message content script:', error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();

  chrome.contextMenus.create({
    id: 'translate-image',
    title: 'Translate manga image',
    contexts: ['image']
  });
  chrome.contextMenus.create({
    id: 'revert-image',
    title: 'Revert translated image',
    contexts: ['image']
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  await sendToTab(tab.id, { type: 'START_PAGE_TRANSLATION' });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'translate-image') {
    await sendToTab(tab.id, {
      type: 'TRANSLATE_IMAGE_BY_SRC',
      srcUrl: info.srcUrl
    });
  }

  if (info.menuItemId === 'revert-image') {
    await sendToTab(tab.id, {
      type: 'REVERT_IMAGE_BY_SRC',
      srcUrl: info.srcUrl
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'GET_SETTINGS') {
        sendResponse({ ok: true, settings: await MangaUtils.getSettings() });
        return;
      }

      if (message?.type === 'SET_SETTINGS') {
        await MangaUtils.setSettings(message.settings || {});
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'CLEAR_MODEL_CACHE') {
        await MangaUtils.clearModelCache();
        await MangaUtils.dbClear(MangaUtils.TRANSLATION_STORE);
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'PROXY_FETCH') {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), message.timeoutMs || 120000);
          const response = await fetch(message.url, {
            ...message.options,
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          let data = null;
          try {
            data = await response.json();
          } catch {
            data = null;
          }

          sendResponse({ ok: response.ok, status: response.status, data });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return true;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});
