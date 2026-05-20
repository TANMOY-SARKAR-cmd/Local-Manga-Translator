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

    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.9);
    } catch (error) {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_IMAGE_BACKGROUND',
        url: src
      });
      if (response?.dataUrl) return response.dataUrl;
      throw new Error(`Cross-origin image access failed for ${src}.`);
    }
  }

  function findImages() {
    return Array.from(document.querySelectorAll('img')).filter(isLikelyMangaImage);
  }

  async function sendProcessRequest(img, settings) {
    const originalSrc = img.src;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const overlay = createOverlay(img);
    STATE.overlays.set(requestId, overlay);
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
            maxWidth: settings[MangaUtils.STORAGE_KEYS.MAX_WIDTH]
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
    for (const img of images) {
      await sendProcessRequest(img, settings);
    }
  }

  async function translateBySrc(srcUrl) {
    if (!srcUrl) return;
    const img = Array.from(document.querySelectorAll('img')).find((node) => {
      const current = node.currentSrc || node.src;
      return current === srcUrl;
    });

    if (!img) return;
    const settings = await getSettings();
    await sendProcessRequest(img, settings);
  }

  function revertBySrc(srcUrl) {
    if (!srcUrl) return;
    const img = Array.from(document.querySelectorAll('img')).find((node) => {
      const current = node.currentSrc || node.src;
      return current === srcUrl || node.dataset.lmtOriginalSrc === srcUrl;
    });

    if (!img || !img.dataset.lmtOriginalSrc) return;
    img.src = img.dataset.lmtOriginalSrc;
    img.dataset.lmtTranslated = '0';
  }

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
