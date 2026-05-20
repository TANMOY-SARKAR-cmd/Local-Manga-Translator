/* global MangaUtils */
import { pipeline, env } from './vendor/transformers.js';

(() => {
  env.useBrowserCache = true;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');

  const MODEL_STATE = {
    ocr: null,
    translator: null,
    requestQueue: Promise.resolve(),
    pendingCount: 0
  };
  const REGION_PADDING = 12;
  const TEXT_BACKGROUND_COLOR = 'rgba(255, 255, 255, 0.32)';
  const TEXT_COLOR = '#121212';

  async function flushVRAM() {
    console.log('[LMT] Queue empty. Flushing WebGPU VRAM to stay under 2GB limit...');
    if (MODEL_STATE.ocr) {
      await MODEL_STATE.ocr.dispose();
      MODEL_STATE.ocr = null;
    }
    if (MODEL_STATE.translator) {
      await MODEL_STATE.translator.dispose();
      MODEL_STATE.translator = null;
    }
  }

  async function sendProgress(tabId, requestId, status) {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROGRESS', tabId, requestId, status });
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

  function detectTextRegionsHeuristic(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height).data;
    const boxes = [];
    const threshold = 120;
    const mergeDist = 40;
    const gridSize = 10;
    const darkGrids = [];
    const sampleOffsets = [
      [2, 2],
      [7, 2],
      [2, 7],
      [7, 7]
    ];

    for (let gy = 0; gy < Math.ceil(height / gridSize); gy += 1) {
      for (let gx = 0; gx < Math.ceil(width / gridSize); gx += 1) {
        let isDark = false;
        for (const [offsetX, offsetY] of sampleOffsets) {
          const px = Math.min(gx * gridSize + offsetX, width - 1);
          const py = Math.min(gy * gridSize + offsetY, height - 1);
          const idx = (py * width + px) * 4;
          const lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
          if (lum < threshold) {
            isDark = true;
            break;
          }
        }
        if (isDark) darkGrids.push({ x: gx * gridSize, y: gy * gridSize });
      }
    }

    darkGrids.forEach((cell) => {
      let merged = false;
      for (const box of boxes) {
        if (
          cell.x >= box.minX - mergeDist &&
          cell.x <= box.maxX + mergeDist &&
          cell.y >= box.minY - mergeDist &&
          cell.y <= box.maxY + mergeDist
        ) {
          box.minX = Math.min(box.minX, cell.x);
          box.minY = Math.min(box.minY, cell.y);
          box.maxX = Math.max(box.maxX, cell.x + gridSize);
          box.maxY = Math.max(box.maxY, cell.y + gridSize);
          merged = true;
          break;
        }
      }
      if (!merged) {
        boxes.push({
          minX: cell.x,
          minY: cell.y,
          maxX: cell.x + gridSize,
          maxY: cell.y + gridSize
        });
      }
    });

    return boxes.filter((b) => b.maxX - b.minX > 30 && b.maxY - b.minY > 30).map((b) => {
      const x = Math.max(0, b.minX - REGION_PADDING);
      const y = Math.max(0, b.minY - REGION_PADDING);
      const widthClamped = Math.max(1, Math.min(width, b.maxX + REGION_PADDING) - x);
      const heightClamped = Math.max(1, Math.min(height, b.maxY + REGION_PADDING) - y);
      return {
        x,
        y,
        width: widthClamped,
        height: heightClamped
      };
    });
  }

  function estimateBubbleFillColor(imageData, box, canvasWidth) {
    const data = imageData.data;
    const samples = [
      [box.x, box.y],
      [box.x + box.width - 1, box.y],
      [box.x, box.y + box.height - 1],
      [box.x + box.width - 1, box.y + box.height - 1]
    ];
    const avg = [0, 0, 0, 0];
    for (const [x, y] of samples) {
      const idx = (Math.floor(y) * canvasWidth + Math.floor(x)) * 4;
      avg[0] += data[idx];
      avg[1] += data[idx + 1];
      avg[2] += data[idx + 2];
      avg[3] += data[idx + 3];
    }
    return avg.map((c) => Math.round(c / 4));
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
        data[idx + 1] = Math.round(
          (data[left + 1] + data[right + 1] + data[up + 1] + data[down + 1]) / 4
        );
        data[idx + 2] = Math.round(
          (data[left + 2] + data[right + 2] + data[up + 2] + data[down + 2]) / 4
        );
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
        ctx.font = `bold ${fontSize}px "Noto Sans JP", sans-serif`;
        const textWidth = ctx.measureText(text).width;
        if (direction === 'vertical' || textWidth <= box.width - 8) break;
        fontSize -= 1;
      }

      ctx.fillStyle = TEXT_BACKGROUND_COLOR;
      ctx.fillRect(box.x, box.y, box.width, box.height);

      ctx.fillStyle = TEXT_COLOR;
      const drawX = box.x + 4;
      const drawY = box.y + 4;
      ctx.strokeText(text, drawX, drawY, box.width - 8);
      ctx.fillText(text, drawX, drawY, box.width - 8);
    });
  }

  async function processImage(payload, tabId) {
    const { requestId, sourceUrl, imageDataUrl, options } = payload;

    const hashKey = MangaUtils.hashString(
      `${sourceUrl}:${options.targetLang}:${options.inpaintEnabled}:${options.maxWidth}`
    );
    const cached = await MangaUtils.dbGet(MangaUtils.TRANSLATION_STORE, hashKey);
    if (cached?.translatedDataUrl) {
      return { translatedDataUrl: cached.translatedDataUrl, fromCache: true };
    }

    const settings = await MangaUtils.getSettings();

    await sendProgress(tabId, requestId, 'Loading WebGPU Models...');

    if (!MODEL_STATE.ocr) {
      try {
        MODEL_STATE.ocr = await pipeline(
          'image-to-text',
          settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].ocr,
          { device: 'webgpu', dtype: 'q8' }
        );
      } catch (e) {
        MODEL_STATE.ocr = await pipeline(
          'image-to-text',
          settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].ocr,
          { device: 'wasm', dtype: 'q8' }
        );
      }
    }

    if (!MODEL_STATE.translator) {
      try {
        MODEL_STATE.translator = await pipeline(
          'translation',
          settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].translator,
          { device: 'webgpu', dtype: 'q8' }
        );
      } catch (e) {
        MODEL_STATE.translator = await pipeline(
          'translation',
          settings[MangaUtils.STORAGE_KEYS.MODEL_URLS].translator,
          { device: 'wasm', dtype: 'q8' }
        );
      }
    }

    await sendProgress(tabId, requestId, 'Preparing image...');
    const bitmap = await decodeToImageBitmap(imageDataUrl);
    const { canvas, ctx, width, height } = await imageBitmapToCanvas(bitmap, options.maxWidth || 1280);

    await sendProgress(tabId, requestId, 'Detecting text...');
    const boxes = detectTextRegionsHeuristic(ctx, width, height);
    const translatedLines = [];

    for (let i = 0; i < boxes.length; i += 1) {
      await sendProgress(tabId, requestId, `Translating bubble ${i + 1}/${boxes.length}...`);
      const region = boxes[i];

      const cropCanvas = new OffscreenCanvas(region.width, region.height);
      const cropCtx = cropCanvas.getContext('2d');
      cropCtx.drawImage(
        canvas,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        region.width,
        region.height
      );
      try {
        const ocrResult = await MODEL_STATE.ocr(cropCanvas);
        const japaneseText = ocrResult[0]?.generated_text || '';

        if (japaneseText.trim().length > 0) {
          const transResult = await MODEL_STATE.translator(japaneseText, {
            src_lang: 'jpn_Jpan',
            tgt_lang: options.targetLang
          });
          translatedLines.push(transResult[0]?.translation_text || '');
        } else {
          translatedLines.push('');
        }
      } catch (err) {
        console.error('OCR or translation inference failed for region:', err);
        translatedLines.push('');
      }
    }

    await sendProgress(tabId, requestId, 'Inpainting...');
    inpaintRegions(ctx, boxes, !!options.inpaintEnabled);

    await sendProgress(tabId, requestId, 'Rendering text...');
    drawTranslatedText(ctx, boxes, translatedLines);

    const translatedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const translatedDataUrl = await MangaUtils.blobToDataURL(translatedBlob);

    await MangaUtils.dbSet(MangaUtils.TRANSLATION_STORE, hashKey, {
      translatedDataUrl,
      updatedAt: Date.now()
    });

    return { translatedDataUrl, fromCache: false };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen') return;

    MODEL_STATE.pendingCount += 1;

    MODEL_STATE.requestQueue = MODEL_STATE.requestQueue
      .then(async () => {
        if (message.type === 'OFFSCREEN_PROCESS_IMAGE') {
          const result = await processImage(message.payload, message.tabId);
          sendResponse(result);
        } else if (message.type === 'OFFSCREEN_CLEAR_MEMORY') {
          await flushVRAM();
          await MangaUtils.dbClear(MangaUtils.TRANSLATION_STORE);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Unknown offscreen message' });
        }
      })
      .catch((error) => {
        console.error('[LMT] offscreen error', error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      })
      .finally(async () => {
        MODEL_STATE.pendingCount -= 1;
        if (MODEL_STATE.pendingCount === 0) {
          await flushVRAM();
        }
      });

    return true;
  });
})();
