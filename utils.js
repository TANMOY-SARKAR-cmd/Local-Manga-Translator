(() => {
  const STORAGE_KEYS = {
    ENABLED_DOMAINS: 'enabled_domains',
    TARGET_LANG: 'targetLang',
    INPAINT: 'inpaintEnabled',
    MAX_WIDTH: 'maxImageWidth',
    SERVER_URL: 'serverUrl',
    SERVER_TIMEOUT_MS: 'serverTimeoutMs',
    SERVER_RETRIES: 'serverRetries'
  };

  const MAX_CACHE_SIZE_MB = 200;
  const MAX_CACHE_ENTRIES = 500;

  const IMAGE_SIZE_LIMITS = {
    DEFAULT_MAX_WIDTH: 1280,
    MIN_WIDTH: 640,
    MAX_WIDTH: 2048
  };
  const NETWORK_LIMITS = {
    DEFAULT_TIMEOUT_MS: 120000,
    MIN_TIMEOUT_MS: 10000,
    MAX_TIMEOUT_MS: 600000,
    DEFAULT_RETRIES: 2,
    MIN_RETRIES: 0,
    MAX_RETRIES: 5
  };

  const DEFAULT_SETTINGS = {
    [STORAGE_KEYS.ENABLED_DOMAINS]: [],
    [STORAGE_KEYS.TARGET_LANG]: 'eng_Latn',
    [STORAGE_KEYS.INPAINT]: true,
    [STORAGE_KEYS.MAX_WIDTH]: IMAGE_SIZE_LIMITS.DEFAULT_MAX_WIDTH,
    [STORAGE_KEYS.SERVER_URL]: 'http://localhost:8000',
    [STORAGE_KEYS.SERVER_TIMEOUT_MS]: NETWORK_LIMITS.DEFAULT_TIMEOUT_MS,
    [STORAGE_KEYS.SERVER_RETRIES]: NETWORK_LIMITS.DEFAULT_RETRIES
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


  async function isDomainEnabled() {
    const settings = await getSettings();
    const enabledDomains = settings[STORAGE_KEYS.ENABLED_DOMAINS] || [];
    return enabledDomains.includes(window.location.hostname);
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
    const mime = (meta.match(/data:(.*);base64/) || [])[1] || 'image/jpeg';

    const bytes = atob(b64);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      buffer[i] = bytes.charCodeAt(i);
    }
    return new Blob([buffer], { type: mime });
  }

  async function blobToDataURL(blob) {
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }

    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  async function clearModelCache() {
    if (typeof caches === 'undefined') return;
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((key) => caches.delete(key)));
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


  async function getCacheSize() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TRANSLATION_STORE, 'readonly');
      const store = tx.objectStore(TRANSLATION_STORE);
      const request = store.openCursor();

      let sizeMB = 0;
      let count = 0;
      const entries = [];

      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const value = cursor.value;
          count++;
          if (value && value.translatedDataUrl) {
            sizeMB += (value.translatedDataUrl.length * 0.75) / (1024 * 1024);
          }
          entries.push({ key: cursor.key, updatedAt: value.updatedAt || 0 });
          cursor.continue();
        } else {
          resolve({ sizeMB, count, entries });
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  function dbGet(store, key) {
    return withDBStore(store, 'readonly', (s) => s.get(key));
  }

  async function dbSet(store, key, value) {
    if (store === TRANSLATION_STORE) {
      try {
        const cacheInfo = await getCacheSize();
        if (cacheInfo.sizeMB >= MAX_CACHE_SIZE_MB || cacheInfo.count >= MAX_CACHE_ENTRIES) {
          cacheInfo.entries.sort((a, b) => a.updatedAt - b.updatedAt);
          const toDeleteCount = Math.max(1, Math.floor(cacheInfo.entries.length * 0.1));
          const toDelete = cacheInfo.entries.slice(0, toDeleteCount);

          const db = await openDB();
          await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            const s = tx.objectStore(store);
            toDelete.forEach(entry => s.delete(entry.key));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
      } catch (e) {
        console.warn('Failed to perform cache eviction', e);
      }
    }
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
      MAX_CACHE_SIZE_MB,
      MAX_CACHE_ENTRIES,
      getCacheSize,
      STORAGE_KEYS,
      DEFAULT_SETTINGS,
      TRANSLATION_STORE,
      IMAGE_SIZE_LIMITS,
      NETWORK_LIMITS,
      isDomainEnabled,
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
