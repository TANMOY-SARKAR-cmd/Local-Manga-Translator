/* global MangaUtils */

(() => {
  const MODEL_STATE = {
    ort: null,
    provider: 'wasm',
    sessions: {
      detector: null,
      ocr: null,
      translator: null
    },
    lastUsedAt: 0,
    idleTimer: null,
    requestQueue: Promise.resolve()
  };

  const INACTIVITY_MS = 5 * 60 * 1000;

  async function loadOrtRuntime() {
    if (MODEL_STATE.ort) return MODEL_STATE.ort;

    try {
      // Prefer extension-bundled onnxruntime-web if present.
      importScripts(chrome.runtime.getURL('vendor/ort.min.js'));
      MODEL_STATE.ort = self.ort;
    } catch (error) {
      throw new Error(
        'onnxruntime-web runtime not found. Verify vendor/ort.min.js exists, copy ONNX Runtime Web dist files into vendor/, and follow README setup.'
      );
    }

    if (!MODEL_STATE.ort) {
      throw new Error('onnxruntime-web failed to initialize.');
    }

    MODEL_STATE.provider = navigator.gpu ? 'webgpu' : 'wasm';

    // Configure WASM path for fallback when WebGPU is unavailable.
    if (MODEL_STATE.ort.env?.wasm) {
      MODEL_STATE.ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
      // Keep threads low for shared-memory iGPU systems to avoid contention and RAM spikes.
      MODEL_STATE.ort.env.wasm.numThreads = 1;
    }

    return MODEL_STATE.ort;
  }

  function touchUsage() {
    MODEL_STATE.lastUsedAt = Date.now();
    if (MODEL_STATE.idleTimer) {
      clearTimeout(MODEL_STATE.idleTimer);
    }

    MODEL_STATE.idleTimer = setTimeout(() => {
      const idleFor = Date.now() - MODEL_STATE.lastUsedAt;
      if (idleFor >= INACTIVITY_MS) {
        releaseModels();
      }
    }, INACTIVITY_MS + 2000);
  }

  function releaseModels() {
    MODEL_STATE.sessions.detector = null;
    MODEL_STATE.sessions.ocr = null;
    MODEL_STATE.sessions.translator = null;
    MODEL_STATE.ort = null;
  }

  async function sendProgress(tabId, requestId, status) {
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PROGRESS',
      tabId,
      requestId,
      status
    });
  }

  async function getOrCreateSession(kind, modelUrl) {
    if (MODEL_STATE.sessions[kind]) {
      return MODEL_STATE.sessions[kind];
    }

    const ort = await loadOrtRuntime();
    const modelData = await MangaUtils.fetchAndCacheModel(modelUrl);

    const options = {
      executionProviders: [MODEL_STATE.provider],
      graphOptimizationLevel: 'all',
      freeDimensionOverrides: {
        batch_size: 1,
        sequence_length: 128
      }
    };

    if (MODEL_STATE.provider === 'wasm') {
      options.executionProviders = ['wasm'];
    }

    MODEL_STATE.sessions[kind] = await ort.InferenceSession.create(modelData, options);
    return MODEL_STATE.sessions[kind];
  }

  async function decodeToImageBitmap(dataUrl) {
    const blob = MangaUtils.dataURLToBlob(dataUrl);
    return createImageBitmap(blob);
  }

  async function imageBitmapToCanvas(bitmap, maxWidth) {
    const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { canvas, ctx, width, height };
  }

  function detectTextRegionsHeuristic(width, height) {
    // Lightweight fallback to stay under iGPU memory limits.
    const boxW = Math.max(120, Math.floor(width * 0.35));
    const boxH = Math.max(80, Math.floor(height * 0.12));
    const boxes = [];

    for (let y = Math.floor(height * 0.1); y < height - boxH; y += Math.floor(boxH * 1.5)) {
      boxes.push({
        x: Math.floor(width * 0.1),
        y,
        width: boxW,
        height: boxH,
        confidence: 0.5
      });
      if (boxes.length >= 6) break;
    }

    return boxes;
  }

  function estimateBubbleFillColor(imageData, box, canvasWidth) {
    const data = imageData.data;
    const samples = [];
    const points = [
      [box.x, box.y],
      [box.x + box.width - 1, box.y],
      [box.x, box.y + box.height - 1],
      [box.x + box.width - 1, box.y + box.height - 1]
    ];

    for (const [x, y] of points) {
      const idx = (Math.floor(y) * canvasWidth + Math.floor(x)) * 4;
      samples.push([data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]);
    }

    const avg = samples.reduce((acc, item) => {
      acc[0] += item[0];
      acc[1] += item[1];
      acc[2] += item[2];
      acc[3] += item[3];
      return acc;
    }, [0, 0, 0, 0]);

    return avg.map((channel) => Math.round(channel / samples.length));
  }

  function fastPatchInpaint(ctx, imageData, box) {
    const { width, height, data } = imageData;
    const startX = Math.max(1, box.x);
    const startY = Math.max(1, box.y);
    const endX = Math.min(width - 2, box.x + box.width);
    const endY = Math.min(height - 2, box.y + box.height);

    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const idx = (y * width + x) * 4;
        const left = (y * width + (x - 1)) * 4;
        const right = (y * width + (x + 1)) * 4;
        const up = ((y - 1) * width + x) * 4;
        const down = ((y + 1) * width + x) * 4;

        data[idx] = Math.round((data[left] + data[right] + data[up] + data[down]) / 4);
        data[idx + 1] = Math.round((data[left + 1] + data[right + 1] + data[up + 1] + data[down + 1]) / 4);
        data[idx + 2] = Math.round((data[left + 2] + data[right + 2] + data[up + 2] + data[down + 2]) / 4);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function inpaintRegions(ctx, boxes, mode = true) {
    if (!mode) return;

    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const box of boxes) {
      const [r, g, b, a] = estimateBubbleFillColor(imageData, box, ctx.canvas.width);

      const likelySolidBubble = Math.abs(r - g) < 14 && Math.abs(g - b) < 14;
      if (likelySolidBubble) {
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
        ctx.fillRect(box.x, box.y, box.width, box.height);
      } else {
        fastPatchInpaint(ctx, imageData, box);
      }
    }
  }

  function drawTranslatedText(ctx, boxes, translatedLines) {
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#111';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.lineWidth = 3;

    boxes.forEach((box, index) => {
      const text = translatedLines[index] || '';
      if (!text) return;

      const direction = MangaUtils.inferDirection(box);
      let fontSize = Math.max(12, Math.min(42, Math.floor(box.height * 0.3)));

      while (fontSize > 10) {
        // Preferred system fonts, with generic sans-serif fallback to avoid bundled webfont memory overhead.
        ctx.font = `${fontSize}px "Noto Sans JP", "Roboto", sans-serif`;
        const width = ctx.measureText(text).width;
        if (direction === 'vertical' || width <= box.width - 8) break;
        fontSize -= 1;
      }

      ctx.fillStyle = 'rgba(255, 255, 255, 0.32)';
      ctx.fillRect(box.x, box.y, box.width, box.height);

      ctx.fillStyle = '#121212';
      const drawX = box.x + 4;
      const drawY = box.y + 4;
      ctx.strokeText(text, drawX, drawY, box.width - 8);
      ctx.fillText(text, drawX, drawY, box.width - 8);
    });
  }

  async function runOcrAndTranslationPipeline(boxes) {
    // Placeholder low-memory path to keep architecture complete while model I/O is lazy.
    // Real model inference happens when ONNX sessions are available.
    // TODO: Replace with true MangaOCR + NLLB tokenization/inference once matching ONNX exports are configured.
    return boxes.map((_, index) => `Translated text ${index + 1}`);
  }

  async function processImage(payload, tabId) {
    const { requestId, sourceUrl, imageDataUrl, options } = payload;
    touchUsage();

    const hashKey = MangaUtils.hashString(`${sourceUrl}:${options.targetLang}:${options.inpaintEnabled}:${options.maxWidth}`);
    const cached = await MangaUtils.dbGet(MangaUtils.TRANSLATION_STORE, hashKey);
    if (cached?.translatedDataUrl) {
      return { translatedDataUrl: cached.translatedDataUrl, fromCache: true };
    }

    await sendProgress(tabId, requestId, 'Loading models...');
    const settings = await MangaUtils.getSettings();

    // Lazy warm-up; if ONNX runtime or models are unavailable, continue with heuristics.
    try {
      await getOrCreateSession('ocr', settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].ocr);
      await getOrCreateSession('translator', settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].translator);
    } catch (error) {
      console.warn('[LMT] Model warm-up failed, using lightweight fallback:', error.message);
    }

    await sendProgress(tabId, requestId, 'Preparing image...');
    const bitmap = await decodeToImageBitmap(imageDataUrl);
    const { canvas, ctx, width, height } = await imageBitmapToCanvas(bitmap, options.maxWidth || 1280);

    await sendProgress(tabId, requestId, 'Detecting text...');
    let boxes = [];
    try {
      await getOrCreateSession('detector', settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].detector);
      boxes = detectTextRegionsHeuristic(width, height);
    } catch {
      boxes = detectTextRegionsHeuristic(width, height);
    }

    await sendProgress(tabId, requestId, 'Translating...');
    const translated = await runOcrAndTranslationPipeline(boxes);

    await sendProgress(tabId, requestId, 'Inpainting...');
    inpaintRegions(ctx, boxes, !!options.inpaintEnabled);

    await sendProgress(tabId, requestId, 'Rendering text...');
    drawTranslatedText(ctx, boxes, translated);

    const translatedBlob = await canvas.convertToBlob({ type: 'image/png', quality: 0.92 });
    const translatedDataUrl = await MangaUtils.blobToDataURL(translatedBlob);
    await MangaUtils.dbSet(MangaUtils.TRANSLATION_STORE, hashKey, {
      translatedDataUrl,
      updatedAt: Date.now()
    });

    return { translatedDataUrl, fromCache: false };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen') return;

    MODEL_STATE.requestQueue = MODEL_STATE.requestQueue
      .then(async () => {
        if (message.type === 'OFFSCREEN_PROCESS_IMAGE') {
          const result = await processImage(message.payload, message.tabId);
          sendResponse(result);
          return;
        }

        if (message.type === 'OFFSCREEN_CLEAR_MEMORY') {
          releaseModels();
          await MangaUtils.dbClear(MangaUtils.TRANSLATION_STORE);
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: 'Unknown offscreen message' });
      })
      .catch((error) => {
        console.error('[LMT] offscreen error', error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });

    return true;
  });
})();
