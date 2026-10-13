"""Prepare MLX-VLM 0.7.1's disk-backed Qwen4 PLE model view.

Qwen3.8 Flash Next's hashed n-gram table is tens of GiB.  Loading every row
into Metal leaves a 128 GiB Mac with very little room for KV and activations,
even though a turn touches only a tiny fraction of those rows.  mlx-vlm 0.7.1
ships ``prepare_external_ple_model`` and ``QuantizedMMapNGramEmbedding`` for
this exact checkpoint shape.

The view contains hard links to the ordinary model shards plus a small index
that excludes resident PLE tensors.  The original install stays immutable and
is still the source of mmap reads.  Publication is lock-protected and atomic,
so concurrent replicas cannot observe a half-built view.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Callable, Optional, Tuple


PLE_MARKER = ".ple.ple_embedding.ngram_embedding.shards."
VIEW_MARKER = "GEZEL_PLE_VIEW.json"


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return None


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint_signature(source: Path) -> Optional[dict]:
    """Return the cheap immutable identity used to validate a derived view."""
    config_path = source / "config.json"
    index_path = source / "model.safetensors.index.json"
    config = _read_json(config_path)
    index = _read_json(index_path)
    if not isinstance(config, dict) or not isinstance(index, dict):
        return None

    text_config = config.get("text_config")
    if not isinstance(text_config, dict):
        text_config = {}
    model_types = {str(config.get("model_type", "")), str(text_config.get("model_type", ""))}
    if not ({"qwen4_exp", "qwen4_exp_text"} & model_types):
        return None

    weight_map = index.get("weight_map")
    if not isinstance(weight_map, dict) or not any(PLE_MARKER in str(key) for key in weight_map):
        return None

    return {
        "source": str(source.resolve()),
        "config_sha256": _file_sha256(config_path),
        "index_sha256": _file_sha256(index_path),
    }


def _valid_view(target: Path, signature: dict) -> bool:
    marker = _read_json(target / VIEW_MARKER)
    config = _read_json(target / "config.json")
    ple_manifest = target / "ple-store.json"
    if marker != signature or not isinstance(config, dict) or not ple_manifest.is_file():
        return False
    text_config = config.get("text_config")
    ple_storage = text_config.get("ple_storage") if isinstance(text_config, dict) else None
    return isinstance(ple_storage, dict) and ple_storage.get("manifest") == ple_manifest.name


def _same_device_target(source: Path, requested: Path) -> Path:
    """Prefer the managed view root, then a same-volume sibling if needed."""
    requested.parent.mkdir(parents=True, exist_ok=True)
    if source.stat().st_dev == requested.parent.stat().st_dev:
        return requested
    sibling = source.parent / ".gezel-views" / requested.name
    sibling.parent.mkdir(parents=True, exist_ok=True)
    return sibling


def prepare_external_ple_view(
    source_dir: str,
    requested_view_dir: Optional[str],
    *,
    prepare_fn: Optional[Callable[..., object]] = None,
) -> Tuple[str, str, bool]:
    """Return ``(effective_model_dir, status, applicable)``.

    Any unsupported shape or contained preparation failure returns the source
    directory plus a diagnostic status. The caller decides whether a resident
    fallback is safe for its memory reservation; Gezel's managed launcher
    requires the view for applicable checkpoints.
    """
    source = Path(source_dir).expanduser().resolve()
    if not requested_view_dir:
        return str(source), "disabled", False
    try:
        signature = checkpoint_signature(source)
    except OSError as exc:
        return str(source), f"signature unavailable: {exc}", False
    if signature is None:
        return str(source), "not a quantized Qwen4 PLE checkpoint", False

    try:
        target = _same_device_target(source, Path(requested_view_dir).expanduser().resolve())
    except OSError as exc:
        return str(source), f"view root unavailable: {exc}", True

    lock_path = target.parent / f".{target.name}.lock"
    try:
        with lock_path.open("a+b") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            if _valid_view(target, signature):
                return str(target), "reused", True

            # A SIGKILL during an earlier publication can leave a sibling
            # staging directory whose hard links would otherwise retain the
            # checkpoint after a later model deletion. The per-target lock
            # makes these unambiguously stale here.
            for stale in target.parent.glob(f".{target.name}.*.partial"):
                if stale.is_dir():
                    shutil.rmtree(stale, ignore_errors=True)

            if prepare_fn is None:
                try:
                    from mlx_vlm.models.qwen4_exp.ple_storage import (
                        prepare_external_ple_model,
                    )
                except Exception as exc:  # noqa: BLE001 - optional across configured runtimes
                    return str(source), f"mlx-vlm external PLE unavailable: {exc}", True
                prepare_fn = prepare_external_ple_model

            if target.exists():
                shutil.rmtree(target)
            staging = target.parent / f".{target.name}.{os.getpid()}.{uuid.uuid4().hex}.partial"
            try:
                prepare_fn(source, staging, cache_rows=0)
                (staging / VIEW_MARKER).write_text(json.dumps(signature, indent=2) + "\n")
                os.rename(staging, target)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
            if not _valid_view(target, signature):
                return str(source), "prepared view failed validation", True
            return str(target), "prepared", True
    except Exception as exc:  # noqa: BLE001 - report a contained preparation failure
        return str(source), f"preparation failed: {exc}", True
