# Local Manga Translator (Chrome Extension + FastAPI Server)

This repository now uses a **client-server architecture**:

- **Client (Chrome extension):** image discovery, UI overlays, user settings, and request orchestration.
- **Server (FastAPI):** OCR + translation + inpainting/rendering pipeline.

## Repository structure

- `/manifest.json`
- `/background.js`
- `/content.js`
- `/popup.html`
- `/popup.js`
- `/styles.css`
- `/utils.js`
- `/server/main.py`
- `/server/model_loader.py`
- `/server/requirements.txt`

## Extension setup

1. Open `chrome://extensions`.
2. Remove any old installation of this extension.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select:
   - `/home/runner/work/Local-Manga-Translator/Local-Manga-Translator`

## Server setup

1. Create and activate a Python virtual environment.
2. Install dependencies:
   - `pip install -r /home/runner/work/Local-Manga-Translator/Local-Manga-Translator/server/requirements.txt`
3. Run the API:
   - `uvicorn main:app --host 0.0.0.0 --port 8000 --app-dir /home/runner/work/Local-Manga-Translator/Local-Manga-Translator/server`

Default extension server URL is `http://localhost:8000`.

## API

### `POST /translate`

Request body:

- `sourceUrl` (optional): image URL for server-side fetching/proxying
- `imageDataUrl` (optional): base64 data URL image payload
- `pageUrl` (optional): page URL used for referer/origin forwarding
- `targetLang` (required): NLLB target language code, e.g. `eng_Latn`
- `inpaintEnabled` (required): boolean
- `maxWidth` (required): integer

At least one of `sourceUrl` or `imageDataUrl` must be provided.

Response body:

- `ok`
- `translatedDataUrl`
- `boxCount`

### `GET /health`

Returns `{ "ok": true }`.

## Usage

1. Start the server.
2. Open the extension popup and verify **Server URL** is `http://localhost:8000` (or your server address).
3. Set as needed:
   - Request timeout
   - Retry count
   - Translation options
4. Click **Translate images on this page**.
5. Use right-click image actions to translate or revert individual images.

## Validation

- Extension validation: `npm test`
- Server syntax check: `python -m py_compile server/main.py server/model_loader.py`
