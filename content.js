/* global MangaUtils */

(() => {
  const MIN_MANGA_IMAGE_AREA = 160000;

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

  async function imageElementToDataURL(img) {
    const src = img.currentSrc || img.src;
    if (!src) throw new Error('Image source is empty.');

    // Dynamically detect image type to preserve PNG/JPEG/WEBP formats
    let mimeType = 'image/jpeg'; // Default to jpeg (handles both .jpg and .jpeg)
    const lowerSrc = src.toLowerCase();
    if (lowerSrc.includes('.png')) mimeType = 'image/png';
    else if (lowerSrc.includes('.webp')) mimeType = 'image/webp';

    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not initialize canvas context.');
      ctx.drawImage(img, 0, 0);

      // Pass the detected mimeType here instead of hardcoding 'image/jpeg'
      return canvas.toDataURL(mimeType, 0.9);
    } catch (error) {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE_BACKGROUND',
        url: src
      });
      if (response?.dataUrl) return response.dataUrl;
      throw new Error(
        `Could not extract image data for ${src} due to CORS restrictions or background fetch failure.`
      );
    }
  }

  function findImages() {
    return Array.from(document.querySelectorAll('img')).filter(isLikelyMangaImage);
  }

  async function sendProcessRequest(img, settings, existingRequestId = null) {
    const originalSrc = img.src;
    const requestId = existingRequestId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let overlay = STATE.overlays.get(requestId);
    if (!overlay) {
      overlay = createOverlay(img);
      STATE.overlays.set(requestId, overlay);
    }

    STATE.activeRequests.add(requestId);

    if (!STATE.originals.has(originalSrc)) {
      STATE.originals.set(originalSrc, originalSrc);
      img.dataset.lmtOriginalSrc = originalSrc;
    }

    try {
      const imageDataUrl = await imageElementToDataURL(img);
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

      img.src = response.translatedDataUrl;
      img.dataset.lmtTranslated = '1';
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

    const images = findImages();
    const imageRequests = new Map();

    for (const img of images) {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let overlay = STATE.overlays.get(requestId);
      if (!overlay) {
        overlay = createOverlay(img);
        STATE.overlays.set(requestId, overlay);
      }
      overlay.textContent = 'Queued...';
      imageRequests.set(img, requestId);
    }

    for (const img of images) {
      await sendProcessRequest(img, settings, imageRequests.get(img));
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
    await sendProcessRequest(img, settings);
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
            sendProcessRequest(img, settings, requestId).catch(e => console.error('[LMT]', e));
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
