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
      ocr: 'l0wgear/manga-ocr-2025-onnx',
      translator: 'Xenova/nllb-200-distilled-600M'
    }
  };

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

  async function blobToDataURL(blob) {
    // Standard DOM approach (works in content scripts, offscreen, popup)
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } 
    // Fallback for Service Workers (background.js)
    else {
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 8192; // Chunking prevents call stack overflow on large images
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
    }
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

  async function clearModelCache() {
    await caches.delete('transformers-cache');
  }

  let _dbPromise = null;
  function openDB() {
    if (!_dbPromise) {
      _dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(TRANSLATION_STORE)) {
            db.createObjectStore(TRANSLATION_STORE);
          }
        };
        request.onerror = () => {
          _dbPromise = null;
          reject(request.error);
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onclose = () => { _dbPromise = null; };
          db.onversionchange = () => { db.close(); _dbPromise = null; };
          resolve(db);
        };
      });
    }
    return _dbPromise;
  }

  async function withDBStore(store, mode, callback) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = callback(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGet(store, key) {
    return withDBStore(store, 'readonly', (s) => s.get(key));
  }

  function dbSet(store, key, value) {
    return withDBStore(store, 'readwrite', (s) => s.put(value, key));
  }

  function dbClear(store) {
    return withDBStore(store, 'readwrite', (s) => s.clear());
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
