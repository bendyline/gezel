"""LFM2.5 checkpoint compatibility shim for the MLX loader.

LFM2.5 checkpoints publish the feed-forward dimension only under the
HF-standard `intermediate_size` key, but the `lfm2` ModelConfig in both
mlx-lm (0.31.3) and mlx-vlm (0.6.6) still requires the LFM2-era
`block_ff_dim` field. Loading one without it dies at import-time model
construction with:

    ModelConfig.__init__() missing 1 required positional argument: 'block_ff_dim'

Wild-caught installing `mlx-community/LFM2.5-2.6B-4bit`. LiquidAI's own
MLX exports (`LiquidAI/LFM2.5-2.6B-MLX/4bit/config.json`) ship BOTH keys
carrying the same value (10752), which is what makes mirroring
`intermediate_size` into `block_ff_dim` the vendor-blessed equivalence
rather than a guess.

Scoped deliberately narrow: only `model_type == "lfm2"`, only when the
key is absent, and additive-only — no existing value is ever rewritten.
Drop this module once both upstreams default the field.
"""

from __future__ import annotations

import json
import os
from typing import Optional


def ensure_lfm2_config_compat(model_dir: str) -> Optional[int]:
    """Backfill `block_ff_dim` into an LFM2.5 config.json when missing.

    Returns the value written, or None when nothing was changed (not an
    lfm2 model, key already present, no `intermediate_size` to mirror,
    or the config is unreadable/malformed). Idempotent: a second call on
    the same directory is a no-op.
    """
    path = os.path.join(model_dir, "config.json")
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(cfg, dict) or cfg.get("model_type") != "lfm2":
        return None
    if "block_ff_dim" in cfg:
        return None
    ff_dim = cfg.get("intermediate_size")
    if not isinstance(ff_dim, int) or isinstance(ff_dim, bool):
        return None
    cfg["block_ff_dim"] = ff_dim
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, path)
    return ff_dim
