# Local Manga Translator (Chrome Extension, Manifest V3)

This repository contains a fully local manga image translation extension for Chrome.

## Highlights

- Manifest V3 architecture with:
  - `background.js` service worker
  - `offscreen.html` + `offscreen.mjs` for WebGPU/canvas processing
  - `content.js` for per-image page integration
  - `popup.html` + `popup.js` for controls
- Local-first pipeline: detect text → OCR → translation → inpaint → overlay translated text.
- No paid cloud APIs (all model inference runs client-side).
- Lazy model loading and cache reuse.
- iGPU/RAM-aware behavior:
  - one image at a time
  - max resolution control (default 1280 px)
  - per-request VRAM flush after queue completion
  - WebGPU preferred, wasm fallback

## Folder structure

- `/manifest.json`
- `/background.js`
- `/content.js`
- `/offscreen.html`
- `/offscreen.mjs`
- `/popup.html`
- `/popup.js`
- `/styles.css`
- `/utils.js`

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `path/to/Local-Manga-Translator`

## Model setup

Models are downloaded on first use and cached locally (browser cache + IndexedDB).

Default model IDs in `utils.js`:

- Manga OCR:
  - `Xenova/manga-ocr-base`
- Translation (NLLB distilled):
  - `Xenova/nllb-200-distilled-600M`

## Runtime dependency

This repository vendors Transformers.js assets under `vendor/`:

- `vendor/transformers.js`
- `vendor/ort-wasm-simd-threaded.jsep.wasm`

The offscreen pipeline attempts WebGPU first and falls back to wasm with quantized (`q8`) model loading.

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
