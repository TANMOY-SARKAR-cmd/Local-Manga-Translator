# Local Manga Translator (Chrome Extension, Manifest V3)

This repository contains a fully local manga image translation extension for Chrome.

## Highlights

- Manifest V3 architecture with:
  - `background.js` service worker
  - `offscreen.html` + `offscreen.js` for WebGPU/canvas processing
  - `content.js` for per-image page integration
  - `popup.html` + `popup.js` for controls
- Local-first pipeline: detect text → OCR → translation → inpaint → overlay translated text.
- No paid cloud APIs (all model inference runs client-side).
- Lazy model loading and cache reuse.
- iGPU/RAM-aware behavior:
  - one image at a time
  - max resolution control (default 1280 px)
  - model unload after 5 minutes of inactivity
  - WebGPU preferred, wasm fallback

## Folder structure

- `/manifest.json`
- `/background.js`
- `/content.js`
- `/offscreen.html`
- `/offscreen.js`
- `/popup.html`
- `/popup.js`
- `/styles.css`
- `/utils.js`

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/home/runner/work/Local-Manga-Translator/Local-Manga-Translator`

## Model setup

Models are downloaded on first use and cached locally (Cache Storage + IndexedDB).

Default model URLs in `utils.js`:

- Text detector (example):
  - `https://huggingface.co/l0wgear/manga-text-detector-onnx/resolve/main/model.onnx`
- Manga OCR:
  - `https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/main/model.onnx`
- Translation (NLLB distilled):
  - `https://huggingface.co/Xenova/nllb-200-distilled-600M/resolve/main/onnx/encoder_model_quantized.onnx`

> Note: ensure URLs point to public ONNX assets that fit your memory budget. For iGPU systems (4–8 GB shared RAM), prefer quantized models and smaller detector variants.

## Runtime dependency for ONNX Runtime Web

To keep this repo lightweight, ONNX Runtime Web runtime assets are expected under `vendor/`:

- `vendor/ort.min.js`
- `vendor/ort-wasm-simd.wasm` (and related wasm files if needed)

The offscreen pipeline attempts WebGPU first and falls back to wasm.

## Usage

- Click extension icon to open popup.
- Set options:
  - Enable/disable extension
  - Target language (default English)
  - Inpainting on/off
  - Max image width
- Click **Translate images on this page**.
- Right-click an image:
  - **Translate manga image**
  - **Revert translated image**
- Use **Clear cached models** to free disk space.

## Offline behavior

After models are downloaded once, the extension reuses local caches. Translation can continue offline as long as required runtime and cached model files are present.
