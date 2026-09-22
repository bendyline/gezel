"""Bounded in-memory images for MLX vision; never fetch URLs or read paths."""

import base64
import io
from contextlib import contextmanager

MAX_IMAGES = 32
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024


@contextmanager
def isolated_position_state(model):
    """Qwen's multimodal RoPE state is model-local, outside the KV cache."""
    tower = getattr(model, 'language_model', model)
    saved = {key: getattr(tower, key) for key in ('_position_ids', '_rope_deltas')
             if hasattr(tower, key)}
    try:
        for key in saved: setattr(tower, key, None)
        yield
    finally:
        for key, value in saved.items(): setattr(tower, key, value)


def decode_images(messages):
    from PIL import Image
    encoded = [value for message in messages for value in (message.images or [])]
    if len(encoded) > MAX_IMAGES:
        raise ValueError(f"At most {MAX_IMAGES} images may be included in a vision request")
    images, total = [], 0
    try:
        for value in encoded:
            if not isinstance(value, str) or len(value) > (MAX_IMAGE_BYTES * 4 // 3 + 4):
                raise ValueError("Image exceeds the 8 MiB encoded-input limit")
            raw = base64.b64decode(value, validate=True)
            total += len(raw)
            if len(raw) > MAX_IMAGE_BYTES or total > MAX_TOTAL_BYTES:
                raise ValueError("Vision request exceeds its image byte budget")
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in ("PNG", "JPEG", "WEBP"):
                    raise ValueError("Vision accepts PNG, JPEG and WebP images")
                if source.width * source.height > 20_000_000:
                    raise ValueError("Image exceeds 20 megapixels")
                # Bound patch expansion and transient memory before GPU input.
                source.thumbnail((1024, 1024))
                images.append(source.convert("RGB"))
        return images
    except Exception:
        for image in images:
            image.close()
        raise


def message_content(message):
    content = message.content
    if isinstance(content, list):
        # Reject alternative image encodings instead of silently dropping them.
        if any(isinstance(part, dict) and part.get("type") != "text" for part in content):
            raise ValueError("Use the message images array for MLX image input")
        content = "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    if message.images:
        return ([{"type": "image"} for _ in message.images]
                + [{"type": "text", "text": content or ""}])
    return content or ""
