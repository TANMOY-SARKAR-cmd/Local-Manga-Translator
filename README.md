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
   - `python /home/runner/work/Local-Manga-Translator/Local-Manga-Translator/server/main.py`

`server/main.py` now selects a free localhost port at startup and prints:

- `Server starting on port: <port>`

Default extension server URL is still `http://localhost:8000`, but if that URL is unavailable the extension will automatically probe:

- `http://localhost:8000`
- `http://localhost:8080`
- `http://localhost:8081`
- `http://localhost:8082`
- `http://localhost:3000`

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
2. Open the extension popup and verify **Server URL** is `http://localhost:8000` (or your preferred server address).
3. Set as needed:
   - Request timeout
   - Retry count
   - Translation options
4. Click **Translate images on this page**. If the configured server URL is down, the extension will auto-discover the server on supported localhost ports.
5. Use right-click image actions to translate or revert individual images.

## Validation

- Extension validation: `npm test`
- Server syntax check: `python -m py_compile server/main.py server/model_loader.py`
