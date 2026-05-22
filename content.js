/* global MangaUtils */

(() => {
  const MIN_MANGA_IMAGE_AREA = 160000;
  const CANVAS_PLACEHOLDER_SRC = 'canvas-data';

  const STATE = {
    overlays: new Map(),
    originals: new Map(),
    activeRequests: new Set()
  };

  function isLikelyMangaImage(img) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width < 300 || height < 300) return false;
    const area = width * height;
    return area >= MIN_MANGA_IMAGE_AREA;
  }

  function createOverlay(img) {
    const wrapper = document.createElement('div');
    wrapper.className = 'lmt-overlay';
    wrapper.textContent = 'Preparing...';
    img.style.position = img.style.position || 'relative';

    const parent = img.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    if (parent) {
      parent.appendChild(wrapper);
      const rect = img.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      wrapper.style.left = `${rect.left - parentRect.left}px`;
      wrapper.style.top = `${rect.top - parentRect.top}px`;
      wrapper.style.width = `${rect.width}px`;
      wrapper.style.height = `${rect.height}px`;
    }

    return wrapper;
  }

  function updateOverlay(requestId, status) {
    const overlay = STATE.overlays.get(requestId);
    if (overlay) overlay.textContent = status;
  }

  function removeOverlay(requestId) {
    const overlay = STATE.overlays.get(requestId);
    if (overlay) overlay.remove();
    STATE.overlays.delete(requestId);
  }

  async function imageElementToDataURL(el, src) {
    if (!src) throw new Error('Image source is empty.');

    try {
      const corsImg = new Image();
      corsImg.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        corsImg.onload = resolve;
        corsImg.onerror = () => reject(new Error('Failed to reload image with CORS.'));
        corsImg.src = src;
      });

      const canvas = document.createElement('canvas');
      canvas.width = corsImg.naturalWidth || el.naturalWidth || el.width;
      canvas.height = corsImg.naturalHeight || el.naturalHeight || el.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not initialize canvas context.');
      ctx.drawImage(corsImg, 0, 0);

      let mimeType = 'image/jpeg';
      if (src.toLowerCase().includes('.png')) mimeType = 'image/png';
      else if (src.toLowerCase().includes('.webp')) mimeType = 'image/webp';
      return canvas.toDataURL(mimeType, 0.9);
    } catch (error) {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE_BACKGROUND',
        url: src
      });
      if (response?.dataUrl) return response.dataUrl;
      const reason = response?.error || 'CORS restrictions or background fetch failure';
      throw new Error(`CORS/Fetch blocked: ${src} (${reason})`);
    }
  }

  function getStandardImages() {
    return Array.from(document.querySelectorAll('img')).filter(isLikelyMangaImage).map(img => ({
      element: img,
      type: 'img',
      originalSrc: img.currentSrc || img.src
    }));
  }

  function getBackgroundImages() {
    const elements = Array.from(document.querySelectorAll('div, span, a'));
    const validElements = [];

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;

      if (bg && bg !== 'none' && bg.startsWith('url(')) {
        const rect = el.getBoundingClientRect();
        if ((rect.width * rect.height) >= MIN_MANGA_IMAGE_AREA) {
          validElements.push({
            element: el,
            type: 'bg',
            originalSrc: bg.slice(4, -1).replace(/["']/g, '')
          });
        }
      }
    }
    return validElements;
  }

  function getCanvasImages() {
    return Array.from(document.querySelectorAll('canvas')).filter(canvas => {
      return (canvas.width * canvas.height) >= MIN_MANGA_IMAGE_AREA;
    }).map(canvas => ({
      element: canvas,
      type: 'canvas',
      originalSrc: CANVAS_PLACEHOLDER_SRC
    }));
  }

  async function sendProcessRequest(item, settings, existingRequestId = null) {
    const { element, type, originalSrc } = item;
    const requestId = existingRequestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let overlay = STATE.overlays.get(requestId);
    if (!overlay) {
      overlay = createOverlay(element);
      STATE.overlays.set(requestId, overlay);
    }

    STATE.activeRequests.add(requestId);

    if (type !== 'canvas' && !STATE.originals.has(originalSrc)) {
      STATE.originals.set(originalSrc, originalSrc);
      element.dataset.lmtOriginalSrc = originalSrc;
    }

    try {
      let imageDataUrl;
      if (type === 'canvas') {
        try {
          imageDataUrl = element.toDataURL('image/jpeg', 0.9);
        } catch (secErr) {
          throw new Error(`Canvas is tainted by cross-origin content and cannot be read: ${secErr.message}`);
        }
      } else {
        imageDataUrl = await imageElementToDataURL(element, originalSrc);
      }
      updateOverlay(requestId, 'Detecting text...');

      const response = await chrome.runtime.sendMessage({
        type: 'PROCESS_IMAGE',
        payload: {
          requestId,
          sourceUrl: originalSrc,
          imageDataUrl,
          options: {
            targetLang: settings[MangaUtils.STORAGE_KEYS.TARGET_LANG],
            inpaintEnabled: settings[MangaUtils.STORAGE_KEYS.INPAINT],
            maxWidth: settings[MangaUtils.STORAGE_KEYS.MAX_WIDTH],
            modelUrls: settings[MangaUtils.STORAGE_KEYS.MODEL_URLS]
          }
        }
      });

      if (!response?.ok || !response.translatedDataUrl) {
        throw new Error(response?.error || 'Failed to translate image');
      }

      if (type === 'img') {
        element.src = response.translatedDataUrl;
      } else if (type === 'bg') {
        element.style.backgroundImage = `url('${response.translatedDataUrl}')`;
      } else if (type === 'canvas') {
        const translatedImg = new Image();
        translatedImg.onload = () => {
          const ctx = element.getContext('2d');
          if (ctx) {
            ctx.drawImage(translatedImg, 0, 0, element.width, element.height);
          }
        };
        translatedImg.onerror = () => {
          console.error('[LMT] Failed to load translated image onto canvas.');
        };
        translatedImg.src = response.translatedDataUrl;
      }
      element.dataset.lmtTranslated = '1';
      updateOverlay(requestId, 'Done');
    } catch (error) {
      console.error('[LMT] Translation failed:', error);
      updateOverlay(requestId, `Failed: ${error.message}`);
    } finally {
      STATE.activeRequests.delete(requestId);
      setTimeout(() => removeOverlay(requestId), 800);
    }
  }

  async function getSettings() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!response?.ok) throw new Error(response?.error || 'Could not load settings');
    return response.settings;
  }

  async function translatePage() {
    const settings = await getSettings();
    if (!settings[MangaUtils.STORAGE_KEYS.ENABLED]) return;

    const allTargets = [
      ...getStandardImages(),
      ...getBackgroundImages(),
      ...getCanvasImages()
    ];

    const toTranslate = allTargets.filter(item => !item.element.dataset.lmtTranslated);

    const imageRequests = new Map();

    for (const item of toTranslate) {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let overlay = STATE.overlays.get(requestId);
      if (!overlay) {
        overlay = createOverlay(item.element);
        STATE.overlays.set(requestId, overlay);
      }
      overlay.textContent = 'Queued...';
      imageRequests.set(item, requestId);
    }

    for (const item of toTranslate) {
      await sendProcessRequest(item, settings, imageRequests.get(item));
    }
  }

  function findImageBySrc(srcUrl, includeOriginal = false) {
    return Array.from(document.querySelectorAll('img')).find((node) => {
      const current = node.currentSrc || node.src;
      return current === srcUrl || (includeOriginal && node.dataset.lmtOriginalSrc === srcUrl);
    });
  }

  async function translateBySrc(srcUrl) {
    if (!srcUrl) return;
    const img = findImageBySrc(srcUrl);

    if (!img) return;
    const settings = await getSettings();
    const item = { element: img, type: 'img', originalSrc: img.currentSrc || img.src };
    await sendProcessRequest(item, settings);
  }

  function revertBySrc(srcUrl) {
    if (!srcUrl) return;
    const img = findImageBySrc(srcUrl, true);

    if (!img || !img.dataset.lmtOriginalSrc) return;
    img.src = img.dataset.lmtOriginalSrc;
    img.dataset.lmtTranslated = '0';
  }


  let dynamicTranslateTimer = null;
  const dynamicallyAddedImages = new Set();

  function triggerDynamicTranslation() {
    if (dynamicTranslateTimer) {
      clearTimeout(dynamicTranslateTimer);
    }
    dynamicTranslateTimer = setTimeout(async () => {
      try {
        const settings = await getSettings();
        if (!settings[MangaUtils.STORAGE_KEYS.ENABLED]) {
          dynamicallyAddedImages.clear();
          return;
        }

        for (const img of dynamicallyAddedImages) {
          if (!STATE.activeRequests.has(img.dataset.lmtOriginalSrc || img.src) && !img.dataset.lmtTranslated) {
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            let overlay = STATE.overlays.get(requestId);
            if (!overlay) {
              overlay = createOverlay(img);
              STATE.overlays.set(requestId, overlay);
            }
            overlay.textContent = 'Queued...';
            const item = { element: img, type: 'img', originalSrc: img.currentSrc || img.src };
            sendProcessRequest(item, settings, requestId).catch(e => console.error('[LMT]', e));
          }
        }
        dynamicallyAddedImages.clear();
      } catch (e) {
        console.error('[LMT] Dynamic translation error', e);
      }
    }, 500);
  }

  const observer = new MutationObserver((mutations) => {
    let hasNewImages = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.tagName === 'IMG') {
            if (isLikelyMangaImage(node)) {
              dynamicallyAddedImages.add(node);
              hasNewImages = true;
            }
          } else if (node.querySelectorAll) {
            const imgs = node.querySelectorAll('img');
            for (const img of imgs) {
              if (isLikelyMangaImage(img)) {
                dynamicallyAddedImages.add(img);
                hasNewImages = true;
              }
            }
          }
        }
      }
    }
    if (hasNewImages) {
      triggerDynamicTranslation();
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({ type: 'ABORT_TAB_REQUESTS' }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'START_PAGE_TRANSLATION') {
      translatePage().catch((error) => console.error('[LMT]', error));
    }

    if (message?.type === 'TRANSLATE_IMAGE_BY_SRC') {
      translateBySrc(message.srcUrl).catch((error) => console.error('[LMT]', error));
    }

    if (message?.type === 'REVERT_IMAGE_BY_SRC') {
      revertBySrc(message.srcUrl);
    }

    if (message?.type === 'IMAGE_PROGRESS' && message.requestId) {
      updateOverlay(message.requestId, message.status || 'Working...');
    }
  });
})();
