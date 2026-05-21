/* global MangaUtils */
import { pipeline, env } from './vendor/transformers.js';

(() => {
  env.useBrowserCache = true;
  env.allowLocalModels = false;

  const MODEL_STATE = {
    ocr: null,
    translator: null,
    requestQueue: Promise.resolve(),
    pendingCount: 0,
    ttlTimer: null,
    abortedTabs: new Set()
  };
  const MODEL_TTL_MS = 45000;
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

function calculateIoU(box1, box2) {
    const x1 = Math.max(box1.minX, box2.minX);
    const y1 = Math.max(box1.minY, box2.minY);
    const x2 = Math.min(box1.maxX, box2.maxX);
    const y2 = Math.min(box1.maxY, box2.maxY);

    if (x2 < x1 || y2 < y1) return 0.0;

    const intersection = (x2 - x1) * (y2 - y1);
    const area1 = (box1.maxX - box1.minX) * (box1.maxY - box1.minY);
    const area2 = (box2.maxX - box2.minX) * (box2.maxY - box2.minY);
    const union = area1 + area2 - intersection;

    return intersection / union;
  }

  function detectTextRegionsHeuristic(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height).data;
    const allBoxes = [];
    const thresholds = [80, 120, 160];
    const mergeDist = 40;
    const gridSize = 10;
    const sampleOffsets = [
      [2, 2],
      [7, 2],
      [2, 7],
      [7, 7]
    ];

    for (const threshold of thresholds) {
      const darkGrids = [];
      const boxes = [];

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
      allBoxes.push(...boxes);
    }

    // Deduplicate by IoU > 0.3
    const finalBoxes = [];
    for (const box of allBoxes) {
      let merged = false;
      for (const finalBox of finalBoxes) {
        if (calculateIoU(box, finalBox) > 0.3) {
          finalBox.minX = Math.min(finalBox.minX, box.minX);
          finalBox.minY = Math.min(finalBox.minY, box.minY);
          finalBox.maxX = Math.max(finalBox.maxX, box.maxX);
          finalBox.maxY = Math.max(finalBox.maxY, box.maxY);
          merged = true;
          break;
        }
      }
      if (!merged) {
        finalBoxes.push(box);
      }
    }

    return finalBoxes.filter((b) => {
      const boxWidth = b.maxX - b.minX;
      const boxHeight = b.maxY - b.minY;
      if (boxWidth <= 30 || boxHeight <= 30) return false;
      const aspect = boxWidth / boxHeight;
      if (aspect < 0.08 || aspect > 12) return false;
      return true;
    }).map((b) => {
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
    const samples = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x = box.x + (box.width - 1) * (col / 2);
        const y = box.y + (box.height - 1) * (row / 2);
        samples.push([x, y]);
      }
    }

    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    const colors = [];

    for (const [x, y] of samples) {
      const idx = (Math.floor(y) * canvasWidth + Math.floor(x)) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      colors.push([r, g, b]);
      sumR += r; sumG += g; sumB += b; sumA += a;
    }

    const avgR = sumR / 9;
    const avgG = sumG / 9;
    const avgB = sumB / 9;
    const avgA = sumA / 9;

    let varianceSum = 0;
    for (const [r, g, b] of colors) {
      varianceSum += Math.pow(r - avgR, 2) + Math.pow(g - avgG, 2) + Math.pow(b - avgB, 2);
    }
    const stdDev = Math.sqrt(varianceSum / (9 * 3));

    return {
      color: [Math.round(avgR), Math.round(avgG), Math.round(avgB), Math.round(avgA)],
      isSolid: stdDev < 20
    };
  }

  function fastPatchInpaint(ctx, imageData, box) {
    const { width, height, data } = imageData;
    const startX = Math.max(1, box.x);
    const startY = Math.max(1, box.y);
    const endX = Math.min(width - 2, box.x + box.width);
    const endY = Math.min(height - 2, box.y + box.height);

    let src = new Uint8ClampedArray(data);
    let dst = new Uint8ClampedArray(data);

    const maxIters = 15;
    for (let iter = 0; iter < maxIters; iter++) {
      let maxDelta = 0;

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const idx = (y * width + x) * 4;

          const up = ((y - 1) * width + x) * 4;
          const down = ((y + 1) * width + x) * 4;
          const left = (y * width + (x - 1)) * 4;
          const right = (y * width + (x + 1)) * 4;

          const upLeft = ((y - 1) * width + (x - 1)) * 4;
          const upRight = ((y - 1) * width + (x + 1)) * 4;
          const downLeft = ((y + 1) * width + (x - 1)) * 4;
          const downRight = ((y + 1) * width + (x + 1)) * 4;

          for (let c = 0; c < 3; c++) {
            const sum =
              (src[up + c] + src[down + c] + src[left + c] + src[right + c]) * 2 +
              (src[upLeft + c] + src[upRight + c] + src[downLeft + c] + src[downRight + c]);

            const newVal = Math.round(sum / 12);

            const delta = Math.abs(newVal - src[idx + c]);
            if (delta > maxDelta) maxDelta = delta;

            dst[idx + c] = newVal;
          }
          dst[idx + 3] = src[idx + 3];

          const distTop = y - box.y;
          const distBottom = box.y + box.height - 1 - y;
          const distLeft = x - box.x;
          const distRight = box.x + box.width - 1 - x;
          const minDist = Math.min(distTop, distBottom, distLeft, distRight);

          if (minDist < 3) {
             const alpha = minDist / 3.0;
             dst[idx + 3] = Math.round(alpha * 255);
          } else {
             dst[idx + 3] = 255;
          }
        }
      }

      if (maxDelta < 2) {
        src = dst;
        break;
      }

      const temp = src;
      src = dst;
      dst = temp;
    }

    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const idx = (y * width + x) * 4;
        data[idx] = src[idx];
        data[idx + 1] = src[idx + 1];
        data[idx + 2] = src[idx + 2];
        data[idx + 3] = src[idx + 3];
      }
    }
  }

  function inpaintRegions(ctx, boxes, mode = true) {
    if (!mode) return;
    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const box of boxes) {
      const { color, isSolid } = estimateBubbleFillColor(imageData, box, ctx.canvas.width);
      if (isSolid) {
        const [r, g, b, a] = color;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
        ctx.fillRect(box.x, box.y, box.width, box.height);
      } else {
        fastPatchInpaint(ctx, imageData, box);
        ctx.putImageData(imageData, 0, 0);
      }
    }
  }
  function drawTranslatedText(ctx, boxes, translatedLines, inpaintEnabled) {
    ctx.textBaseline = "top";
    ctx.fillStyle = TEXT_COLOR;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.78)";

    boxes.forEach((box, index) => {
      const text = translatedLines[index] || "";
      if (!text) return;

      const direction = MangaUtils.inferDirection(box);
      let fontSize = Math.min(42, Math.floor(box.height * 0.3), Math.floor(box.width * 0.15));
      let lines = [];

      const words = text.split(" ");

      if (direction === "vertical") {
        // vertical stacked characters
      } else {
        while (fontSize >= 10) {
          ctx.font = `bold ${fontSize}px "Noto Sans JP", sans-serif`;
          ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.08));
          lines = [];
          let currentLine = words[0];

          for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + " " + word).width;
            if (width < box.width - 8) {
              currentLine += " " + word;
            } else {
              lines.push(currentLine);
              currentLine = word;
            }
          }
          lines.push(currentLine);

          if (lines.length * fontSize <= box.height - 8 || fontSize === 10) {
            break;
          }
          fontSize -= 1;
        }
      }

      ctx.font = `bold ${fontSize}px "Noto Sans JP", sans-serif`;
      ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.08));

      if (!inpaintEnabled) {
        ctx.fillStyle = TEXT_BACKGROUND_COLOR;
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.fillStyle = TEXT_COLOR; // Reset fillStyle back for text rendering
      }

      if (direction === "vertical") {
         const chars = text.split("");
         const textHeight = chars.length * fontSize;
         const startY = box.y + (box.height - textHeight) / 2;
         const startX = box.x + (box.width - fontSize) / 2;

         ctx.save();
         for (let i = 0; i < chars.length; i++) {
            const char = chars[i];
            const charWidth = ctx.measureText(char).width;
            const drawX = startX + (fontSize - charWidth) / 2;
            const drawY = startY + (i * fontSize);

            ctx.strokeText(char, drawX, drawY);
            ctx.fillText(char, drawX, drawY);
         }
         ctx.restore();
      } else {
         const textHeight = lines.length * fontSize;
         const startY = box.y + (box.height - textHeight) / 2;

         for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const textWidth = ctx.measureText(line).width;
            const drawX = box.x + (box.width - textWidth) / 2;
            const drawY = startY + (i * fontSize);

            ctx.strokeText(line, drawX, drawY);
            ctx.fillText(line, drawX, drawY);
         }
      }
    });
  }


async function loadModel(task, url) {
    try {
      return await pipeline(task, url, { device: 'webgpu', dtype: 'q8' });
    } catch (e1) {
      try {
        return await pipeline(task, url, { device: 'wasm', dtype: 'q8' });
      } catch (e2) {
        return await pipeline(task, url, { device: 'wasm', dtype: 'fp32' });
      }
    }
  }

  async function processImage(payload, tabId) {
    if (MODEL_STATE.abortedTabs.has(tabId)) return { ok: false, error: 'Aborted', aborted: true };

    const { requestId, sourceUrl, imageDataUrl, options } = payload;

    // Extract original image format so the output matches the input
    const mimeMatch = imageDataUrl.match(/data:(.*);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const hashKey = MangaUtils.hashString(
      `${sourceUrl}:${options.targetLang}:${options.inpaintEnabled}:${options.maxWidth}`
    );
    const cached = await MangaUtils.dbGet(MangaUtils.TRANSLATION_STORE, hashKey);
    if (cached?.translatedDataUrl) {
      return { translatedDataUrl: cached.translatedDataUrl, fromCache: true };
    }

    await sendProgress(tabId, requestId, 'Loading WebGPU Models...');

    if (!MODEL_STATE.ocr) {
      MODEL_STATE.ocr = await loadModel('image-to-text', options.modelUrls.ocr);
    }

    if (!MODEL_STATE.translator) {
      MODEL_STATE.translator = await loadModel('translation', options.modelUrls.translator);
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

      // OCR Preprocessing
      const cropImgData = cropCtx.getImageData(0, 0, region.width, region.height);
      const data = cropImgData.data;
      let minLum = 255, maxLum = 0;
      for (let j = 0; j < data.length; j += 4) {
        const lum = 0.299 * data[j] + 0.587 * data[j+1] + 0.114 * data[j+2];
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      if (maxLum - minLum < 100 && maxLum > minLum) {
        const scale = 255 / (maxLum - minLum);
        for (let j = 0; j < data.length; j += 4) {
          const lum = 0.299 * data[j] + 0.587 * data[j+1] + 0.114 * data[j+2];
          const newLum = Math.max(0, Math.min(255, (lum - minLum) * scale));
          const ratio = newLum / (lum || 1);
          data[j] = Math.min(255, data[j] * ratio);
          data[j+1] = Math.min(255, data[j+1] * ratio);
          data[j+2] = Math.min(255, data[j+2] * ratio);
        }
        cropCtx.putImageData(cropImgData, 0, 0);
      }

      try {
        // --- FIX: Safely convert the OffscreenCanvas into a base64 string ---
        const blob = await cropCanvas.convertToBlob({ type: 'image/png' });
        const regionDataUrl = await MangaUtils.blobToDataURL(blob);

        // --- FIX: Pass the String (Data URL) instead of the Canvas object ---
        const ocrResult = await MODEL_STATE.ocr(regionDataUrl);
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
    drawTranslatedText(ctx, boxes, translatedLines, !!options.inpaintEnabled);

    // Use the dynamically detected mimeType instead of hardcoded 'image/jpeg'
    const translatedBlob = await canvas.convertToBlob({ type: mimeType, quality: 0.9 });
    const translatedDataUrl = await MangaUtils.blobToDataURL(translatedBlob);

    await MangaUtils.dbSet(MangaUtils.TRANSLATION_STORE, hashKey, {
      translatedDataUrl,
      updatedAt: Date.now()
    });

    return { translatedDataUrl, fromCache: false };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen') return;

    if (message.type === 'OFFSCREEN_ABORT_TAB_REQUESTS') {
      MODEL_STATE.abortedTabs.add(message.tabId);
      // Clean up after some time
      setTimeout(() => MODEL_STATE.abortedTabs.delete(message.tabId), 60000);
      sendResponse({ ok: true });
      return;
    }


    if (MODEL_STATE.ttlTimer) {
      clearTimeout(MODEL_STATE.ttlTimer);
      MODEL_STATE.ttlTimer = null;
    }

    MODEL_STATE.pendingCount += 1;

    MODEL_STATE.requestQueue = MODEL_STATE.requestQueue
      .then(async () => {
        if (message.type === 'OFFSCREEN_PROCESS_IMAGE') {
          if (MODEL_STATE.abortedTabs.has(message.tabId)) {
            sendResponse({ ok: false, error: 'Aborted', aborted: true });
            return;
          }
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
          MODEL_STATE.ttlTimer = setTimeout(async () => {
            if (MODEL_STATE.pendingCount === 0) {
              await flushVRAM();
              MODEL_STATE.ttlTimer = null;
            }
          }, MODEL_TTL_MS);
        }
      });

    return true;
  });
})();
