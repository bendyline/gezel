"""Stdlib-only tests for the Qwen 3.5 text-only checkpoint detector."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from qwen3_5_text_compat import is_text_only_qwen3_5_checkpoint  # noqa: E402


def model_dir(config, weight_map=None) -> str:
    root = Path(tempfile.mkdtemp())
    (root / "config.json").write_text(json.dumps(config))
    if weight_map is not None:
        (root / "model.safetensors.index.json").write_text(
            json.dumps({"weight_map": weight_map})
        )
    return str(root)


def test_accepts_dense_and_moe_text_only_exports() -> None:
    for model_type, vision_fields in (
        ("qwen3_5", {}),
        ("qwen3_5_moe", {"vision_config": None}),
    ):
        root = model_dir(
            {"model_type": model_type, **vision_fields},
            {"language_model.model.layers.0.input_layernorm.weight": "model.safetensors"},
        )
        assert is_text_only_qwen3_5_checkpoint(root)


def test_rejects_a_declared_or_present_vision_tower() -> None:
    declared = model_dir(
        {"model_type": "qwen3_5", "vision_config": {"depth": 27}},
        {"language_model.model.embed_tokens.weight": "model.safetensors"},
    )
    assert not is_text_only_qwen3_5_checkpoint(declared)

    present = model_dir(
        {"model_type": "qwen3_5", "vision_config": None},
        {
            "language_model.model.embed_tokens.weight": "model.safetensors",
            "vision_tower.blocks.0.attn.proj.weight": "model.safetensors",
        },
    )
    assert not is_text_only_qwen3_5_checkpoint(present)


def test_fails_closed_for_other_or_incomplete_checkpoints() -> None:
    other = model_dir(
        {"model_type": "qwen3", "vision_config": None},
        {"language_model.model.embed_tokens.weight": "model.safetensors"},
    )
    assert not is_text_only_qwen3_5_checkpoint(other)

    missing_index = model_dir({"model_type": "qwen3_5", "vision_config": None})
    assert not is_text_only_qwen3_5_checkpoint(missing_index)

    no_language = model_dir(
        {"model_type": "qwen3_5", "vision_config": None},
        {"unexpected.weight": "model.safetensors"},
    )
    assert not is_text_only_qwen3_5_checkpoint(no_language)


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
