import ipaddress
import os
import socket
from typing import Optional
from urllib.parse import urlparse

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from model_loader import TranslationEngine

load_dotenv() # Load environment variables from .env file

FALLBACK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
REQUEST_TIMEOUT_SECONDS = 60
BLOCKED_HOSTS = {'localhost', '127.0.0.1', '::1'}
ALLOWED_SOURCE_DOMAINS = [d.strip() for d in os.getenv("ALLOWED_DOMAINS", "kumacdn.club,rawkuma.net").split(",")]

app = FastAPI(title='Local Manga Translator Server', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)

engine = TranslationEngine()


class TranslateRequest(BaseModel):
    requestId: Optional[str] = None
    sourceUrl: Optional[str] = None
    imageDataUrl: Optional[str] = None
    pageUrl: Optional[str] = None
    targetLang: str = Field(default='eng_Latn')
    inpaintEnabled: bool = Field(default=True)
    maxWidth: int = Field(default=1280, ge=256, le=4096)


class TranslateResponse(BaseModel):
    ok: bool
    translatedDataUrl: Optional[str] = None
    boxCount: int = 0
    error: Optional[str] = None


@app.get('/health')
async def health():
    return {'ok': True}


def _validate_source_url(source_url: str):
    try:
        parsed = urlparse(source_url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f'Invalid source URL: {exc}') from exc

    if parsed.scheme not in {'http', 'https'}:
        raise HTTPException(status_code=400, detail='Unsupported source URL protocol')
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail='Credentials in source URL are not allowed')

    host = (parsed.hostname or '').strip().lower()
    if not host:
        raise HTTPException(status_code=400, detail='Source URL host is required')
    if host in BLOCKED_HOSTS:
        raise HTTPException(status_code=400, detail='Source URL host is not allowed')

    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            raise HTTPException(status_code=400, detail='Source URL host is not allowed')
        return
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail=f'Source URL host resolution failed: {exc}') from exc

    for info in infos:
        resolved_ip = info[4][0]
        ip = ipaddress.ip_address(resolved_ip)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            raise HTTPException(status_code=400, detail='Source URL resolves to a restricted address')

    if not any(host == domain or host.endswith(f'.{domain}') for domain in ALLOWED_SOURCE_DOMAINS):
        raise HTTPException(status_code=400, detail='Source URL domain is not allowed')

    return parsed


def _page_headers(page_url: Optional[str]):
    referer = page_url or ""
    origin = ""
    if page_url:
        try:
            parsed = urlparse(page_url)
            if parsed.scheme and parsed.netloc:
                origin = f'{parsed.scheme}://{parsed.netloc}'
        except Exception:
            pass

    return {
        'Referer': referer,
        **(({'Origin': origin} if origin else {})),
        'User-Agent': FALLBACK_USER_AGENT,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    }


async def _fetch_image_as_data_url(source_url: str, page_url: Optional[str]) -> str:
    parsed = _validate_source_url(source_url)
    headers = _page_headers(page_url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    path_with_query = parsed.path
    if parsed.query:
        path_with_query = f'{path_with_query}?{parsed.query}'

    async with httpx.AsyncClient(base_url=base_url, timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
        # Path/query is constrained by scheme, host, DNS/IP checks, and trusted-domain allowlisting above.
        response = await client.get(path_with_query, headers=headers)  # lgtm [py/full-ssrf]

    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f'Image fetch failed ({response.status_code})')

    mime_type = response.headers.get('content-type', 'image/jpeg').split(';')[0].strip() or 'image/jpeg'
    b64 = __import__('base64').b64encode(response.content).decode('utf-8')
    return f'data:{mime_type};base64,{b64}'


@app.post('/translate', response_model=TranslateResponse)
async def translate(req: TranslateRequest):
    try:
        image_data_url = req.imageDataUrl

        if not image_data_url and req.sourceUrl:
            image_data_url = await _fetch_image_as_data_url(req.sourceUrl, req.pageUrl)

        if not image_data_url:
            raise HTTPException(status_code=400, detail='Either imageDataUrl or sourceUrl is required')

        translated_data_url, box_count = engine.process(
            image_data_url=image_data_url,
            target_lang=req.targetLang,
            inpaint_enabled=req.inpaintEnabled,
            max_width=req.maxWidth,
        )
        return TranslateResponse(ok=True, translatedDataUrl=translated_data_url, boxCount=box_count)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'Translation failed: {exc}') from exc


def get_free_port(preferred_ports=[8000, 8080, 8081, 8082, 3000]) -> int:
    for port in preferred_ports:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue

    # Fallback
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


if __name__ == '__main__':
    port = get_free_port()
    print(f'Server starting on port: {port}')
    uvicorn.run(app, host='127.0.0.1', port=port)
