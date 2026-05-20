(() => {
  const STORAGE_KEYS = {
    ENABLED: 'enabled',
    TARGET_LANG: 'targetLang',
    INPAINT: 'inpaintEnabled',
    MAX_WIDTH: 'maxImageWidth',
    MODEL_URLS: 'modelUrls'
  };

  const IMAGE_SIZE_LIMITS = {
    DEFAULT_MAX_WIDTH: 1280,
    MIN_WIDTH: 640,
    MAX_WIDTH: 2048
  };
  const DEFAULT_SETTINGS = {
    [STORAGE_KEYS.ENABLED]: true,
    [STORAGE_KEYS.TARGET_LANG]: 'eng_Latn',
    [STORAGE_KEYS.INPAINT]: true,
    [STORAGE_KEYS.MAX_WIDTH]: IMAGE_SIZE_LIMITS.DEFAULT_MAX_WIDTH,
    [STORAGE_KEYS.MODEL_URLS]: {
      ocr: 'Xenova/manga-ocr-base',
      translator: 'Xenova/nllb-200-distilled-600M'
    }
  };

  const MODEL_CACHE = 'lmt-model-cache-v1';
  const DB_NAME = 'lmt-cache-db';
  const DB_VERSION = 1;
  const TRANSLATION_STORE = 'translations';

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(payload) {
    return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
  }

  async function getSettings() {
    const settings = await storageGet(Object.keys(DEFAULT_SETTINGS));
    return { ...DEFAULT_SETTINGS, ...settings };
  }

  async function setSettings(nextSettings) {
    await storageSet(nextSettings);
  }

  function dataURLToBlob(dataURL) {
    const [meta, b64] = dataURL.split(',');
    const mime = (meta.match(/data:(.*);base64/) || [])[1] || 'image/png';
    const bytes = atob(b64);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      buffer[i] = bytes.charCodeAt(i);
    }
    return new Blob([buffer], { type: mime });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  function hashString(text) {
    // FNV-1a style hash to generate short deterministic cache keys for image+settings tuples.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  async function fetchAndCacheModel(url, onProgress) {
    const cache = await caches.open(MODEL_CACHE);
    const cached = await cache.match(url);
    if (cached) {
      return cached.arrayBuffer();
    }

    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) {
      throw new Error(`Failed to download model: ${url} (${response.status})`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (!response.body || !contentLength) {
      await cache.put(url, response.clone());
      return response.arrayBuffer();
    }

    const reader = response.body.getReader();
    let received = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) {
        onProgress({ received, total: contentLength });
      }
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const finalResponse = new Response(merged, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(received)
      }
    });

    await cache.put(url, finalResponse.clone());
    return finalResponse.arrayBuffer();
  }

  async function clearModelCache() {
    await caches.delete(MODEL_CACHE);
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TRANSLATION_STORE)) {
          db.createObjectStore(TRANSLATION_STORE);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function dbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbSet(store, key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbClear(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }

  function inferDirection(box) {
    return box.height > box.width ? 'vertical' : 'horizontal';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function expose() {
    return {
      STORAGE_KEYS,
      DEFAULT_SETTINGS,
      TRANSLATION_STORE,
      IMAGE_SIZE_LIMITS,
      getSettings,
      setSettings,
      dataURLToBlob,
      blobToDataURL,
      hashString,
      fetchAndCacheModel,
      clearModelCache,
      dbGet,
      dbSet,
      dbClear,
      inferDirection,
      clamp
    };
  }

  if (typeof window !== 'undefined') {
    window.MangaUtils = expose();
  }
  if (typeof self !== 'undefined') {
    self.MangaUtils = expose();
  }
})();
