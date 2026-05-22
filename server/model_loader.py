import gc
import io
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
from manga_ocr import MangaOcr
from PIL import Image, ImageDraw, ImageFont
from transformers import pipeline

MODEL_TTL_SECONDS = 120
TEXT_COLOR = (18, 18, 18)
TEXT_BACKGROUND = (255, 255, 255, 140)


@dataclass
class TextRegion:
    x: int
    y: int
    width: int
    height: int


class TranslationEngine:
    def __init__(self):
        self.ocr: Optional[MangaOcr] = None
        self.translator = None
        self.last_used_at = 0.0

    def _touch(self):
        self.last_used_at = time.time()

    def _cleanup_if_expired(self):
        if not self.last_used_at:
            return
        if time.time() - self.last_used_at < MODEL_TTL_SECONDS:
            return
        self.ocr = None
        self.translator = None
        self.last_used_at = 0.0
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _load_models(self):
        self._cleanup_if_expired()
        if self.ocr is None:
            self.ocr = MangaOcr()
        if self.translator is None:
            device = 0 if torch.cuda.is_available() else -1
            self.translator = pipeline(
                'translation',
                model='facebook/nllb-200-distilled-600M',
                device=device
            )
        self._touch()

    @staticmethod
    def _decode_image(image_data_url: str) -> Image.Image:
        if not image_data_url.startswith('data:'):
            raise ValueError('Invalid imageDataUrl format')
        marker = ';base64,'
        marker_idx = image_data_url.find(marker)
        if marker_idx <= 5:
            raise ValueError('Invalid imageDataUrl format')
        b64_data = image_data_url[marker_idx + len(marker):]
        if not b64_data:
            raise ValueError('Invalid imageDataUrl format')
        image_bytes = io.BytesIO()
        image_bytes.write(__import__('base64').b64decode(b64_data))
        image_bytes.seek(0)
        return Image.open(image_bytes).convert('RGBA')

    @staticmethod
    def _encode_data_url(image: Image.Image, mime_type: str = 'image/jpeg') -> str:
        buffer = io.BytesIO()
        output_format = 'JPEG' if mime_type == 'image/jpeg' else 'PNG'
        save_image = image.convert('RGB') if output_format == 'JPEG' else image
        kwargs = {'quality': 90} if output_format == 'JPEG' else {}
        save_image.save(buffer, format=output_format, **kwargs)
        encoded = __import__('base64').b64encode(buffer.getvalue()).decode('utf-8')
        return f'data:{mime_type};base64,{encoded}'

    @staticmethod
    def _detect_text_regions(image: Image.Image):
        gray = np.array(image.convert('L'))
        height, width = gray.shape

        thresholds = [80, 120, 160]
        grid_size = 10
        merge_dist = 40
        sample_offsets = [(2, 2), (7, 2), (2, 7), (7, 7)]

        boxes = []
        for threshold in thresholds:
            dark_cells = []
            for gy in range((height + grid_size - 1) // grid_size):
                for gx in range((width + grid_size - 1) // grid_size):
                    dark = False
                    for ox, oy in sample_offsets:
                        px = min(gx * grid_size + ox, width - 1)
                        py = min(gy * grid_size + oy, height - 1)
                        if gray[py, px] < threshold:
                            dark = True
                            break
                    if dark:
                        dark_cells.append((gx * grid_size, gy * grid_size))

            threshold_boxes = []
            for cell_x, cell_y in dark_cells:
                merged = False
                for box in threshold_boxes:
                    if (
                        cell_x >= box['minX'] - merge_dist
                        and cell_x <= box['maxX'] + merge_dist
                        and cell_y >= box['minY'] - merge_dist
                        and cell_y <= box['maxY'] + merge_dist
                    ):
                        box['minX'] = min(box['minX'], cell_x)
                        box['minY'] = min(box['minY'], cell_y)
                        box['maxX'] = max(box['maxX'], cell_x + grid_size)
                        box['maxY'] = max(box['maxY'], cell_y + grid_size)
                        merged = True
                        break
                if not merged:
                    threshold_boxes.append({
                        'minX': cell_x,
                        'minY': cell_y,
                        'maxX': cell_x + grid_size,
                        'maxY': cell_y + grid_size,
                    })
            boxes.extend(threshold_boxes)

        final_boxes = []
        for box in boxes:
            merged = False
            for final_box in final_boxes:
                iou = _iou(box, final_box)
                if iou > 0.3:
                    final_box['minX'] = min(final_box['minX'], box['minX'])
                    final_box['minY'] = min(final_box['minY'], box['minY'])
                    final_box['maxX'] = max(final_box['maxX'], box['maxX'])
                    final_box['maxY'] = max(final_box['maxY'], box['maxY'])
                    merged = True
                    break
            if not merged:
                final_boxes.append(box)

        regions = []
        for b in final_boxes:
            box_w = b['maxX'] - b['minX']
            box_h = b['maxY'] - b['minY']
            if box_w <= 30 or box_h <= 30:
                continue
            aspect = box_w / max(box_h, 1)
            if aspect < 0.08 or aspect > 12:
                continue

            x = max(0, b['minX'] - 12)
            y = max(0, b['minY'] - 12)
            clamped_w = max(1, min(width, b['maxX'] + 12) - x)
            clamped_h = max(1, min(height, b['maxY'] + 12) - y)
            regions.append(TextRegion(x=x, y=y, width=clamped_w, height=clamped_h))

        return regions

    @staticmethod
    def _estimate_fill_color(image: Image.Image, region: TextRegion):
        data = np.array(image)
        x2 = min(region.x + region.width - 1, data.shape[1] - 1)
        y2 = min(region.y + region.height - 1, data.shape[0] - 1)
        points = []
        for row in range(3):
            for col in range(3):
                px = int(region.x + (x2 - region.x) * (col / 2))
                py = int(region.y + (y2 - region.y) * (row / 2))
                points.append(data[py, px, :3])
        arr = np.array(points, dtype=np.float32)
        avg = np.mean(arr, axis=0)
        std = np.sqrt(np.mean((arr - avg) ** 2))
        return tuple(int(v) for v in avg), std < 20

    @staticmethod
    def _draw_wrapped_text(draw: ImageDraw.ImageDraw, region: TextRegion, text: str):
        if not text.strip():
            return

        max_font = min(42, int(region.height * 0.3), max(10, int(region.width * 0.15)))
        font = ImageFont.load_default()

        words = text.split(' ')
        lines = [text]
        font_size = max_font

        for candidate in range(max_font, 9, -1):
            test_lines = []
            current = words[0] if words else ''
            for word in words[1:]:
                probe = f'{current} {word}'
                bbox = draw.textbbox((0, 0), probe, font=font)
                if (bbox[2] - bbox[0]) <= region.width - 8:
                    current = probe
                else:
                    test_lines.append(current)
                    current = word
            if current:
                test_lines.append(current)

            if len(test_lines) * candidate <= region.height - 8 or candidate == 10:
                lines = test_lines
                font_size = candidate
                break

        text_height = len(lines) * font_size
        start_y = region.y + max(0, (region.height - text_height) // 2)

        for i, line in enumerate(lines):
            bbox = draw.textbbox((0, 0), line, font=font)
            text_width = bbox[2] - bbox[0]
            draw_x = region.x + max(0, (region.width - text_width) // 2)
            draw_y = start_y + i * font_size
            draw.text((draw_x + 1, draw_y + 1), line, fill=(255, 255, 255, 230), font=font)
            draw.text((draw_x, draw_y), line, fill=TEXT_COLOR, font=font)

    def process(
        self,
        image_data_url: str,
        target_lang: str,
        inpaint_enabled: bool,
        max_width: int,
    ):
        self._load_models()

        source_image = self._decode_image(image_data_url)
        mime_type = 'image/jpeg' if image_data_url.startswith('data:image/jpeg') else 'image/png'

        if source_image.width > max_width:
            ratio = max_width / source_image.width
            resized_h = max(1, int(source_image.height * ratio))
            source_image = source_image.resize((max_width, resized_h), Image.LANCZOS)

        boxes = self._detect_text_regions(source_image)
        translated_lines = []

        for region in boxes:
            crop = source_image.crop((region.x, region.y, region.x + region.width, region.y + region.height)).convert('RGB')

            japanese_text = ''
            try:
                japanese_text = self.ocr(crop).strip() if self.ocr else ''
            except Exception:
                japanese_text = ''

            if japanese_text:
                try:
                    out = self.translator(
                        japanese_text,
                        src_lang='jpn_Jpan',
                        tgt_lang=target_lang
                    )
                    translated_lines.append(out[0].get('translation_text', '').strip())
                except Exception:
                    translated_lines.append('')
            else:
                translated_lines.append('')

        draw = ImageDraw.Draw(source_image, 'RGBA')

        for idx, region in enumerate(boxes):
            if inpaint_enabled:
                fill_rgb, _ = self._estimate_fill_color(source_image, region)
                draw.rectangle(
                    (region.x, region.y, region.x + region.width, region.y + region.height),
                    fill=(*fill_rgb, 255)
                )
            else:
                draw.rectangle(
                    (region.x, region.y, region.x + region.width, region.y + region.height),
                    fill=TEXT_BACKGROUND
                )

            self._draw_wrapped_text(draw, region, translated_lines[idx] if idx < len(translated_lines) else '')

        self._touch()
        return self._encode_data_url(source_image, mime_type), len(boxes)


def _iou(box1, box2):
    x1 = max(box1['minX'], box2['minX'])
    y1 = max(box1['minY'], box2['minY'])
    x2 = min(box1['maxX'], box2['maxX'])
    y2 = min(box1['maxY'], box2['maxY'])

    if x2 < x1 or y2 < y1:
        return 0.0

    inter = (x2 - x1) * (y2 - y1)
    area1 = (box1['maxX'] - box1['minX']) * (box1['maxY'] - box1['minY'])
    area2 = (box2['maxX'] - box2['minX']) * (box2['maxY'] - box2['minY'])
    union = max(1, area1 + area2 - inter)
    return inter / union
