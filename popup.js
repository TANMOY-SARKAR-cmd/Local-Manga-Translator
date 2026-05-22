/* global MangaUtils */

(async () => {
  const enabled = document.getElementById('enabled');
  const targetLang = document.getElementById('targetLang');
  const inpaintEnabled = document.getElementById('inpaintEnabled');
  const maxImageWidth = document.getElementById('maxImageWidth');
  const serverUrl = document.getElementById('serverUrl');
  const serverTimeoutMs = document.getElementById('serverTimeoutMs');
  const serverRetries = document.getElementById('serverRetries');
  const translatePage = document.getElementById('translatePage');
  const clearCache = document.getElementById('clearCache');
  const status = document.getElementById('status');
  const { DEFAULT_MAX_WIDTH, MIN_WIDTH, MAX_WIDTH } = MangaUtils.IMAGE_SIZE_LIMITS;
  const {
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    DEFAULT_RETRIES,
    MIN_RETRIES,
    MAX_RETRIES
  } = MangaUtils.NETWORK_LIMITS;

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  maxImageWidth.min = String(MIN_WIDTH);
  maxImageWidth.max = String(MAX_WIDTH);
  serverTimeoutMs.min = String(MIN_TIMEOUT_MS);
  serverTimeoutMs.max = String(MAX_TIMEOUT_MS);
  serverRetries.min = String(MIN_RETRIES);
  serverRetries.max = String(MAX_RETRIES);

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not load settings');
    }

    const settings = response.settings;
    enabled.checked = !!settings[MangaUtils.STORAGE_KEYS.ENABLED];
    targetLang.value = settings[MangaUtils.STORAGE_KEYS.TARGET_LANG];
    inpaintEnabled.checked = !!settings[MangaUtils.STORAGE_KEYS.INPAINT];
    maxImageWidth.value = settings[MangaUtils.STORAGE_KEYS.MAX_WIDTH];
    serverUrl.value = settings[MangaUtils.STORAGE_KEYS.SERVER_URL];
    serverTimeoutMs.value = settings[MangaUtils.STORAGE_KEYS.SERVER_TIMEOUT_MS];
    serverRetries.value = settings[MangaUtils.STORAGE_KEYS.SERVER_RETRIES];
  }

  async function saveSettings() {
    const normalizedServerUrl = (serverUrl.value || MangaUtils.DEFAULT_SETTINGS[MangaUtils.STORAGE_KEYS.SERVER_URL]).trim();
    if (!normalizedServerUrl) {
      throw new Error('Server URL is required');
    }

    await chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      settings: {
        [MangaUtils.STORAGE_KEYS.ENABLED]: enabled.checked,
        [MangaUtils.STORAGE_KEYS.TARGET_LANG]: targetLang.value,
        [MangaUtils.STORAGE_KEYS.INPAINT]: inpaintEnabled.checked,
        [MangaUtils.STORAGE_KEYS.MAX_WIDTH]: MangaUtils.clamp(
          Number(maxImageWidth.value || DEFAULT_MAX_WIDTH),
          MIN_WIDTH,
          MAX_WIDTH
        ),
        [MangaUtils.STORAGE_KEYS.SERVER_URL]: normalizedServerUrl,
        [MangaUtils.STORAGE_KEYS.SERVER_TIMEOUT_MS]: MangaUtils.clamp(
          Number(serverTimeoutMs.value || DEFAULT_TIMEOUT_MS),
          MIN_TIMEOUT_MS,
          MAX_TIMEOUT_MS
        ),
        [MangaUtils.STORAGE_KEYS.SERVER_RETRIES]: MangaUtils.clamp(
          Number(serverRetries.value || DEFAULT_RETRIES),
          MIN_RETRIES,
          MAX_RETRIES
        )
      }
    });
  }

  enabled.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));
  targetLang.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));
  inpaintEnabled.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));
  maxImageWidth.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));
  serverUrl.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));
  serverTimeoutMs.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));
  serverRetries.addEventListener('change', () => saveSettings().catch((e) => setStatus(e.message, true)));

  translatePage.addEventListener('click', async () => {
    try {
      await saveSettings();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found');
      await chrome.tabs.sendMessage(tab.id, { type: 'START_PAGE_TRANSLATION' });
      setStatus('Started translation on this page.');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  clearCache.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CLEAR_MODEL_CACHE' });
      if (!response?.ok) throw new Error(response?.error || 'Clear cache failed');
      setStatus('Cleared local extension cache.');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  try {
    await loadSettings();
    setStatus('Ready');
  } catch (error) {
    setStatus(error.message, true);
  }
})();
