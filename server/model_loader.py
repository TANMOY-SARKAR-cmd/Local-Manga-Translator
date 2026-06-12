import base64
import gc
import io
import logging
import os
import time
import threading
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
import torch
from manga_ocr import MangaOcr
from PIL import Image, ImageDraw, ImageFont
from transformers import pipeline

logger = logging.getLogger(__name__)

MODEL_TTL_SECONDS = 120
TEXT_COLOR = (18, 18, 18)
TEXT_BACKGROUND = (255, 255, 255, 140)
MAX_IMAGE_PIXELS = 4096 * 4096
MIN_OCR_CROP_PX  = 24

_FONT_SEARCH_PATHS: List[str] = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/calibri.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
]

def _find_system_font() -> Optional[str]:
    for path in _FONT_SEARCH_PATHS:
        if os.path.isfile(path):
            return path
    return None

_SYSTEM_FONT_PATH: Optional[str] = _find_system_font()

def _get_font(size: int) -> ImageFont.ImageFont:
    if _SYSTEM_FONT_PATH:
        try:
            return ImageFont.truetype(_SYSTEM_FONT_PATH, max(6, size))
        except (IOError, OSError):
            pass
    return ImageFont.load_default()

@dataclass
class TextRegion:
    x: int
    y: int
    width: int
    height: int

class TranslationEngine:
    def __init__(self) -> None:
        self.ocr: Optional[MangaOcr] = None
        self.translator = None
        self.last_used_at: float = 0.0
        self.lock = threading.Lock()

    def _touch(self) -> None:
        self.last_used_at = time.monotonic()

    def cleanup_if_expired(self) -> None:
        with self.lock:
            if not self.last_used_at:
                return
            if time.monotonic() - self.last_used_at < MODEL_TTL_SECONDS:
                return
            logger.info("[LMT] TTL expired — unloading models.")
            self.ocr = None
            self.translator = None
            self.last_used_at = 0.0
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    def _load_models(self) -> None:
        if self.ocr is None:
            self.ocr = MangaOcr()
        if self.translator is None:
            device = 0 if torch.cuda.is_available() else -1
            self.translator = pipeline(
                "translation",
                model="facebook/nllb-200-distilled-600M",
                device=device,
            )
        self._touch()

    @staticmethod
    def _decode_image(image_data_url: str) -> Image.Image:
        if not image_data_url.startswith("data:"):
            raise ValueError('imageDataUrl must start with "data:"')
        marker = ";base64,"
        idx = image_data_url.find(marker)
        if idx <= 5:
            raise ValueError("imageDataUrl missing ;base64, marker")

        raw_bytes = base64.b64decode(image_data_url[idx + len(marker):])
        buf = io.BytesIO(raw_bytes)
        probe = Image.open(buf)
        probe.verify()
        buf.seek(0)
        img = Image.open(buf)

        if img.width * img.height > MAX_IMAGE_PIXELS:
            raise ValueError(f"Image too large ({img.width}x{img.height} px)")
        return img.convert("RGBA")

    @staticmethod
    def _encode_data_url(image: Image.Image, mime_type: str = "image/jpeg") -> str:
        buf = io.BytesIO()
        fmt = "JPEG" if mime_type == "image/jpeg" else "PNG"
        out = image.convert("RGB") if fmt == "JPEG" else image
        kw  = {"quality": 90, "optimize": True} if fmt == "JPEG" else {}
        out.save(buf, format=fmt, **kw)
        return f"data:{mime_type};base64,{base64.b64encode(buf.getvalue()).decode()}"

    @staticmethod
    def _detect_text_regions(image: Image.Image) -> List[TextRegion]:
        gray = np.array(image.convert("L"), dtype=np.uint8)
        h, w = gray.shape

        BLOCK, STRIDE = 24, 12
        DARK_THR, LIGHT_THR = 100, 160
        MIN_DARK, MAX_DARK, MIN_LIGHT = 0.03, 0.55, 0.25
        MIN_CTR, MERGE_DIST = 80, 48
        MIN_W, MIN_H, PAD = 40, 30, 10

        candidates = []
        for y in range(0, h - BLOCK + 1, STRIDE):
            for x in range(0, w - BLOCK + 1, STRIDE):
                patch = gray[y : y + BLOCK, x : x + BLOCK]
                if int(patch.max()) - int(patch.min()) < MIN_CTR:
                    continue
                sz = patch.size
                dark_r = float((patch < DARK_THR).sum()) / sz
                light_r = float((patch > LIGHT_THR).sum()) / sz
                if MIN_DARK <= dark_r <= MAX_DARK and light_r >= MIN_LIGHT:
                    candidates.append([x, y, x + BLOCK, y + BLOCK])

        merged = []
        for box in candidates:
            absorbed = False
            for m in merged:
                gap_x = max(0, max(m[0], box[0]) - min(m[2], box[2]))
                gap_y = max(0, max(m[1], box[1]) - min(m[3], box[3]))
                if gap_x <= MERGE_DIST and gap_y <= MERGE_DIST:
                    m[0] = min(m[0], box[0]); m[2] = max(m[2], box[2])
                    m[1] = min(m[1], box[1]); m[3] = max(m[3], box[3])
                    absorbed = True
                    break
            if not absorbed:
                merged.append(list(box))

        regions = []
        for x1, y1, x2, y2 in merged:
            bw, bh = x2 - x1, y2 - y1
            if bw < MIN_W or bh < MIN_H:
                continue
            if not (0.08 <= bw / max(bh, 1) <= 12.0):
                continue
            rx = max(0, x1 - PAD)
            ry = max(0, y1 - PAD)
            rw = min(w, x2 + PAD) - rx
            rh = min(h, y2 + PAD) - ry
            regions.append(TextRegion(x=rx, y=ry, width=max(1, rw), height=max(1, rh)))
        return regions

    @staticmethod
    def _estimate_fill_color(image: Image.Image, region: TextRegion) -> Tuple[Tuple[int, int, int], bool]:
        data = np.array(image)
        x2 = min(region.x + region.width  - 1, data.shape[1] - 1)
        y2 = min(region.y + region.height - 1, data.shape[0] - 1)
        pts = []
        for row in range(3):
            for col in range(3):
                px = int(region.x + (x2 - region.x) * col / 2)
                py = int(region.y + (y2 - region.y) * row / 2)
                pts.append(data[py, px, :3])
        arr = np.array(pts, dtype=np.float32)
        avg = np.mean(arr, axis=0)
        std = float(np.sqrt(np.mean((arr - avg) ** 2)))
        return tuple(int(v) for v in avg), std < 20

    @staticmethod
    def _draw_wrapped_text(draw: ImageDraw.ImageDraw, region: TextRegion, text: str) -> None:
        text = text.strip()
        if not text:
            return
        words = text.split()
        if not words:
            return

        max_size = min(42, int(region.height * 0.35), max(10, int(region.width * 0.18)))
        best_font, best_lines, best_size = None, None, 10

        for size in range(max_size, 9, -1):
            font = _get_font(size)
            lines = []
            cur = words[0]
            for word in words[1:]:
                probe = f"{cur} {word}"
                bb = draw.textbbox((0, 0), probe, font=font)
                if (bb[2] - bb[0]) <= region.width - 8:
                    cur = probe
                else:
                    lines.append(cur)
                    cur = word
            lines.append(cur)

            if len(lines) * size <= region.height - 8:
                best_font = font
                best_lines = lines
                best_size = size
                break

        if best_font is None:
            best_size = 10
            best_font = _get_font(best_size)
            best_lines = [text]

        total_h = len(best_lines) * best_size
        start_y = region.y + max(0, (region.height - total_h) // 2)

        for i, line in enumerate(best_lines):
            bb = draw.textbbox((0, 0), line, font=best_font)
            tw = bb[2] - bb[0]
            dx = region.x + max(0, (region.width - tw) // 2)
            dy = start_y + i * best_size
            for ox, oy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                draw.text((dx + ox, dy + oy), line, fill=(255, 255, 255, 210), font=best_font)
            draw.text((dx, dy), line, fill=TEXT_COLOR, font=best_font)

    def process(self, image_data_url: str, target_lang: str, inpaint_enabled: bool, max_width: int) -> Tuple[str, int]:
        with self.lock:
            self._load_models()
            source_image = self._decode_image(image_data_url)
            mime_type = "image/jpeg" if image_data_url.startswith("data:image/jpeg") else "image/png"

            try:
                if source_image.width > max_width:
                    ratio = max_width / source_image.width
                    new_h = max(1, int(source_image.height * ratio))
                    source_image = source_image.resize((max_width, new_h), Image.LANCZOS)

                boxes = self._detect_text_regions(source_image)
                raw_texts = []
                for region in boxes:
                    if region.width < MIN_OCR_CROP_PX or region.height < MIN_OCR_CROP_PX:
                        raw_texts.append("")
                        continue
                    crop = source_image.crop((region.x, region.y, region.x + region.width, region.y + region.height)).convert("RGB")
                    try:
                        raw_texts.append((self.ocr(crop) or "").strip())
                    except Exception as exc:
                        logger.warning("[LMT] OCR failed for %s: %s", region, exc)
                        raw_texts.append("")

                non_empty = [(i, t) for i, t in enumerate(raw_texts) if t]
                translated_lines = [""] * len(boxes)
                if non_empty:
                    indices, texts = zip(*non_empty)
                    try:
                        results = self.translator(list(texts), src_lang="jpn_Jpan", tgt_lang=target_lang)
                        for idx, res in zip(indices, results):
                            translated_lines[idx] = (res.get("translation_text") or "").strip()
                    except Exception as exc:
                        logger.warning("[LMT] Batch translation failed: %s", exc)

                draw = ImageDraw.Draw(source_image, "RGBA")
                for idx, region in enumerate(boxes):
                    t_text = translated_lines[idx]
                    if inpaint_enabled:
                        fill_rgb, _ = self._estimate_fill_color(source_image, region)
                        draw.rectangle(
                            [region.x, region.y, region.x + region.width - 1, region.y + region.height - 1],
                            fill=(*fill_rgb, 255),
                        )
                    else:
                        draw.rectangle(
                            [region.x, region.y, region.x + region.width - 1, region.y + region.height - 1],
                            fill=TEXT_BACKGROUND,
                        )
                    self._draw_wrapped_text(draw, region, t_text)

                self._touch()
                return self._encode_data_url(source_image, mime_type), len(boxes)
            finally:
                source_image.close()
