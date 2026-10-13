"""Compatibility detection for text-only Qwen 3.5 MLX checkpoints.

Some official Qwen 3.5 derivatives are exported for MLX with only the
``language_model.*`` tensors.  Their config still names the multimodal
``*ForConditionalGeneration`` architecture, but omits ``vision_config`` (or
sets it to null).  mlx-vlm 0.6.6 nevertheless constructs its default
vision tower and strict loading then rejects the intentionally absent vision
parameters.

Gezel still uses mlx-vlm for the text path because it supplies the Qwen tool
parser and shared server machinery.  For this one unambiguous checkpoint
shape, non-strict loading is safe: the language checkpoint is complete and
the unused synthetic vision tower is the only component without weights.
"""

from __future__ import annotations

import json
import os


_QWEN3_5_MODEL_TYPES = {"qwen3_5", "qwen3_5_moe"}
_VISION_PREFIXES = (
    "vision_tower.",
    "vision_model.",
    "model.visual.",
    "model.language_model.visual.",
)


def is_text_only_qwen3_5_checkpoint(model_dir: str) -> bool:
    """Return whether ``model_dir`` is an intentional text-only Qwen 3.5 export.

    Detection is deliberately fail-closed.  We relax mlx-vlm's strict loader
    only when the config opts out of vision and the sharded weight index proves
    that language tensors exist while every known vision namespace is absent.
    """

    try:
        with open(os.path.join(model_dir, "config.json")) as f:
            config = json.load(f)
        with open(os.path.join(model_dir, "model.safetensors.index.json")) as f:
            index = json.load(f)
    except (OSError, ValueError):
        return False

    if not isinstance(config, dict):
        return False
    if config.get("model_type") not in _QWEN3_5_MODEL_TYPES:
        return False
    if config.get("vision_config") is not None:
        return False

    weight_map = index.get("weight_map") if isinstance(index, dict) else None
    if not isinstance(weight_map, dict) or not weight_map:
        return False
    keys = tuple(key for key in weight_map if isinstance(key, str))
    if not any(key.startswith("language_model.") for key in keys):
        return False
    return not any(key.startswith(_VISION_PREFIXES) for key in keys)
