"""Disk persistence for mlx-vlm PromptCacheState.

A prompt cache is two pieces:
  - `state.cache`: a list of cache layer objects (KVCache, RotatingKVCache,
    Mamba caches, etc.). Each layer carries internal mlx arrays.
  - `state.token_ids`: the list of prefilled tokens, used by stream_generate
    to detect prefix overlap on the next request.

We serialize via the same pattern mlx-lm uses upstream (see
mlx_lm.utils.save_prompt_cache): each layer's `.state` returns a tuple of
mx.arrays; `.meta_state` returns json-friendly metadata. We tree-flatten
the arrays into a flat dict keyed by tree path, save with
`mx.save_safetensors` (mmap-friendly, atomic via tmp+rename), and stash
class names + meta_state + token_ids + a model fingerprint in the
safetensors metadata blob.

On load we walk the metadata, look up each cache class by name in the
mlx_vlm or mlx_lm namespace, instantiate it, then assign the saved
`state` and `meta_state` back. mlx arrays come back via mmap so the load
is near-instant; the restored cache is independent of the source (no
shared mutable state).

Best-effort throughout — any error returns None / silently drops. The
caller treats absence as cache miss and re-prefills.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import mlx.core as mx
from mlx.utils import tree_flatten, tree_unflatten

# Cache class lookup. mlx-vlm and mlx-lm both define KVCache /
# RotatingKVCache / etc. — try mlx_vlm first since that's what our
# server runs against; fall back to mlx_lm in case mlx-vlm re-imports
# or some operator has both installed and a model uses one set vs the
# other. We resolve lazily on each load so an import failure here
# can't take down the server module at import time.
def _resolve_cache_class(name: str) -> Optional[type]:
    candidates: list[Any] = []
    try:
        from mlx_vlm.models import cache as vlm_cache  # type: ignore[attr-defined]

        candidates.append(vlm_cache)
    except Exception:  # noqa: BLE001 — best-effort import
        pass
    try:
        from mlx_lm.models import cache as lm_cache

        candidates.append(lm_cache)
    except Exception:  # noqa: BLE001
        pass
    for module in candidates:
        cls = getattr(module, name, None)
        if isinstance(cls, type):
            return cls
    return None


# Schema version baked into sidecar metadata. Bump when the on-disk
# layout changes incompatibly so older entries are rejected on load
# instead of silently corrupting reconstruction.
SCHEMA_VERSION = "1"


def cache_path(persist_dir: Path, model_fingerprint: str, cache_id: str) -> Path:
    """Resolve the on-disk path for a (model, cache_id) pair.

    Segmenting by model fingerprint means a model swap can't accidentally
    load wrong-shape cache state — different fingerprint, different
    directory, different files.
    """
    # Avoid filesystem-hostile chars in cache_id — gezel sessionIds are
    # already safe (uuid-shape) but defensively coerce.
    safe_id = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in cache_id)
    return persist_dir / model_fingerprint / f"{safe_id}.safetensors"


def save_cache(
    persist_dir: Path,
    model_fingerprint: str,
    cache_id: str,
    state: Any,
) -> bool:
    """Write a PromptCacheState to disk. Returns True on success.

    `state` must have `.cache` (list of layer instances) and `.token_ids`
    (list[int]). Empty states (cache is None or token_ids is empty) are
    skipped — saving them buys nothing and risks overwriting a prior
    good entry.
    """
    if state is None:
        return False
    cache_layers = getattr(state, "cache", None)
    token_ids = getattr(state, "token_ids", None) or []
    if not cache_layers or not token_ids:
        return False

    try:
        layer_states = [c.state for c in cache_layers]
        # mlx-lm's `meta_state` may be missing on some custom caches;
        # default to an empty dict so reconstruction can still proceed.
        meta_state = [getattr(c, "meta_state", {}) for c in cache_layers]
        class_names = [type(c).__name__ for c in cache_layers]
        # tree_flatten turns a nested structure of arrays into a flat
        # list of (path, array) tuples — exactly what save_safetensors
        # wants. The path encoding is what tree_unflatten reads back to
        # reconstruct the structure.
        flat = dict(tree_flatten(layer_states))
        if not flat:
            # Nothing array-shaped to save; reconstruction would always
            # fail. Treat as a no-op rather than writing an empty file.
            return False

        metadata = {
            "schema_version": SCHEMA_VERSION,
            "classes": json.dumps(class_names),
            "meta_state": json.dumps(meta_state, default=str),
            "token_ids": json.dumps(token_ids),
            "model_fingerprint": model_fingerprint,
            "saved_at": str(time.time()),
            "token_count": str(len(token_ids)),
        }

        target = cache_path(persist_dir, model_fingerprint, cache_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        # tmp + rename = crash-safe atomic write. CRITICAL: the tmp
        # path must keep the `.safetensors` suffix — mx.save_safetensors
        # validates the extension and refuses to write to a `.tmp` path,
        # leaving the file uncreated. The rename then fails with
        # FileNotFoundError on the source. We use a hidden-prefix +
        # PID-suffix naming convention to preserve the extension while
        # guaranteeing uniqueness (concurrent saves of the same cache_id
        # would otherwise race for the same `.tmp` name).
        tmp = target.with_name(
            f".{target.stem}.tmp.{os.getpid()}{target.suffix}"
        )
        mx.save_safetensors(str(tmp), flat, metadata)
        os.replace(tmp, target)
        return True
    except Exception as exc:  # noqa: BLE001 — disk persistence is best-effort
        print(f"[cache] save failed for cache_id={cache_id}: {exc}", flush=True)
        return False


def load_cache(
    persist_dir: Path,
    model_fingerprint: str,
    cache_id: str,
) -> Optional[Any]:
    """Read a PromptCacheState from disk. Returns None on any failure.

    Failures are silent (treat as cache miss). The caller then runs a
    fresh prefill — no worse than before disk persistence existed.
    """
    target = cache_path(persist_dir, model_fingerprint, cache_id)
    if not target.exists():
        return None

    try:
        # mx.load with `return_metadata=True` gives back (arrays_dict,
        # metadata_dict). The arrays are mmap-backed — no full read into
        # RAM unless / until they're touched.
        flat, metadata = mx.load(str(target), return_metadata=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] load failed for cache_id={cache_id} (read): {exc}", flush=True)
        return None

    # Fingerprint check — refuse to load cache built against a different
    # model. The model dir contents can change in place (catalog upgrade
    # in-place), and an old cache against new weights produces garbage
    # generation. Hard reject is the only correct behavior.
    if metadata.get("model_fingerprint") != model_fingerprint:
        print(
            f"[cache] fingerprint mismatch for cache_id={cache_id} "
            f"(have={metadata.get('model_fingerprint')!r}); ignoring",
            flush=True,
        )
        return None

    if metadata.get("schema_version") != SCHEMA_VERSION:
        print(
            f"[cache] schema version mismatch for cache_id={cache_id} "
            f"(have={metadata.get('schema_version')!r}); ignoring",
            flush=True,
        )
        return None

    try:
        class_names = json.loads(metadata.get("classes", "[]"))
        meta_state_list = json.loads(metadata.get("meta_state", "[]"))
        token_ids = json.loads(metadata.get("token_ids", "[]"))
    except json.JSONDecodeError as exc:
        print(f"[cache] metadata parse failed for cache_id={cache_id}: {exc}", flush=True)
        return None

    if not class_names or not token_ids:
        return None

    try:
        layer_states = tree_unflatten(list(flat.items()))
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] tree_unflatten failed for cache_id={cache_id}: {exc}", flush=True)
        return None

    # Reconstruct each cache layer. Class lookup goes through the
    # mlx_vlm/mlx_lm cache module; if a class is unknown (e.g. operator
    # upgraded mlx_vlm and the cache class was renamed) we abort the
    # whole load — partial caches would silently produce wrong outputs.
    if len(class_names) != len(layer_states) or len(class_names) != len(meta_state_list):
        print(f"[cache] structure mismatch for cache_id={cache_id}; ignoring", flush=True)
        return None

    cache_layers: list[Any] = []
    for cls_name, meta, layer_state in zip(class_names, meta_state_list, layer_states):
        cls = _resolve_cache_class(cls_name)
        if cls is None:
            print(
                f"[cache] unknown cache class {cls_name!r} for cache_id={cache_id}; ignoring",
                flush=True,
            )
            return None
        try:
            # Prefer `from_state` classmethod when present (mlx-lm 0.20+
            # cache classes all expose it: it does
            # `cls.__new__(cls)` + assign state + assign meta_state in
            # the correct order to bypass __init__'s required args like
            # RotatingKVCache's `max_size`). Fall back to manual
            # __new__-and-assign for mlx-vlm cache classes that don't
            # have from_state but share the same state/meta_state
            # property contract.
            from_state = getattr(cls, "from_state", None)
            if callable(from_state):
                instance = from_state(layer_state, meta)
            else:
                instance = cls.__new__(cls)
                instance.meta_state = meta
                instance.state = layer_state
        except Exception as exc:  # noqa: BLE001
            print(
                f"[cache] reconstruct {cls_name} failed for cache_id={cache_id}: {exc}",
                flush=True,
            )
            return None
        cache_layers.append(instance)

    # Build a fresh PromptCacheState and populate. The import is
    # function-local so this module stays importable even when mlx-vlm
    # isn't (e.g. unit tests on a non-Mac CI host that nonetheless need
    # the path-helper utilities for shape).
    try:
        from mlx_vlm.generate import PromptCacheState

        state = PromptCacheState()
        state.cache = cache_layers
        state.token_ids = token_ids
        return state
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] PromptCacheState construct failed: {exc}", flush=True)
        return None


def delete_cache(persist_dir: Path, model_fingerprint: str, cache_id: str) -> bool:
    """Remove a single on-disk cache entry. Returns True if a file was
    deleted (False = file didn't exist or removal failed)."""
    target = cache_path(persist_dir, model_fingerprint, cache_id)
    try:
        target.unlink(missing_ok=True)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] delete failed for cache_id={cache_id}: {exc}", flush=True)
        return False


def list_persisted(
    persist_dir: Path, model_fingerprint: str
) -> list[tuple[str, int, float]]:
    """Enumerate persisted entries for the current model: returns
    `[(cache_id, size_bytes, mtime), ...]` sorted by mtime ascending so
    the head is the LRU candidate.

    Used by callers that want to enforce a disk-budget cap independent of
    the in-memory budget. Errors yield an empty list.
    """
    model_dir = persist_dir / model_fingerprint
    if not model_dir.is_dir():
        return []
    entries: list[tuple[str, int, float]] = []
    for path in model_dir.iterdir():
        if path.suffix != ".safetensors":
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        cache_id = path.stem
        entries.append((cache_id, stat.st_size, stat.st_mtime))
    entries.sort(key=lambda e: e[2])
    return entries
