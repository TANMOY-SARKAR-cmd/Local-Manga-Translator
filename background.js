importScripts('utils.js');

const OFFSCREEN_URL = 'offscreen.html';
let offscreenCreatingPromise = null;

async function ensureDefaults() {
  const settings = await MangaUtils.getSettings();
  await MangaUtils.setSettings(settings);
}

async function hasOffscreenDocument() {
  if (!chrome.offscreen || !chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('Offscreen API unavailable in this Chrome version.');
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (!offscreenCreatingPromise) {
    offscreenCreatingPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Run ONNX/WebGPU and canvas image processing for translation pipeline'
      })
      .finally(() => {
        offscreenCreatingPromise = null;
      });
  }

  await offscreenCreatingPromise;
}

async function forwardToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {

      if (message?.type === 'ABORT_TAB_REQUESTS') {
        await forwardToOffscreen({ type: 'OFFSCREEN_ABORT_TAB_REQUESTS', tabId: sender.tab?.id });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'PROCESS_IMAGE') {
        const result = await forwardToOffscreen({
          type: 'OFFSCREEN_PROCESS_IMAGE',
          payload: message.payload,
          tabId: sender.tab?.id
        });
        sendResponse({ ok: true, ...result });
        return;
      }

      if (message?.type === 'CLEAR_MODEL_CACHE') {
        await MangaUtils.clearModelCache();
        await forwardToOffscreen({ type: 'OFFSCREEN_CLEAR_MEMORY' });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'GET_SETTINGS') {
        sendResponse({ ok: true, settings: await MangaUtils.getSettings() });
        return;
      }

      if (message?.type === 'SET_SETTINGS') {
        await MangaUtils.setSettings(message.settings || {});
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'OFFSCREEN_PROGRESS' && message.tabId) {
        await sendToTab(message.tabId, {
          type: 'IMAGE_PROGRESS',
          requestId: message.requestId,
          status: message.status
        });
        sendResponse({ ok: true });
        return;
      }

      if (message?.type === 'FETCH_IMAGE_BACKGROUND' && message.url) {
        let parsedUrl;
        try {
          parsedUrl = new URL(message.url);
        } catch {
          sendResponse({ dataUrl: null, error: 'Invalid image URL' });
          return;
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          sendResponse({ dataUrl: null, error: 'Unsupported URL protocol' });
          return;
        }

        const res = await fetch(parsedUrl.toString());
        if (!res.ok) {
          sendResponse({ dataUrl: null, error: `Image fetch failed (${res.status})` });
          return;
        }
        const blob = await res.blob();
        const dataUrl = await MangaUtils.blobToDataURL(blob);
        sendResponse({ dataUrl });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});
