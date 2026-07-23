"""
gezel_mlx_server — thin OpenAI-compatible HTTP server around mlx-vlm
that owns the prompt-cache lifecycle.

Why this exists: mlx_vlm.server (the upstream binary) clears the
prompt cache after every streamed response (see its `finally`:
`mx.clear_cache()` + `gc.collect()`). That means every turn re-prefills
the entire context — on a 25K-token Meester session at ~250 tok/s,
that's a 2-minute wait per turn. This server preserves the cache
between requests when the caller supplies a `cache_id`, and reuses any
matching prefix on the next request.

Reuse mechanism: mlx-vlm exposes `PromptCacheState` (in
mlx_vlm/generate.py) for exactly this purpose — pass it as the
`prompt_cache_state` kwarg to `stream_generate` and only the new
tokens beyond the common prefix get prefilled. We hold one
`PromptCacheState` per `cache_id` in a module-level dict, with bounded
LRU eviction by total estimated bytes.

Compatibility contract: we serve the same OpenAI-shape
`/v1/chat/completions` endpoint as mlx_vlm.server, with the same SSE
shape — the gezel `MlxSession` SSE reader and our existing tool-call
stripper / Gemma-format parser keep working unchanged. We do NOT do
server-side tool-call extraction (mlx_vlm.server's `process_tool_calls`
path); the gezel side already handles that better. The model's
textual tool-call markup flows through as content; the gezel
`LeakyToolCallStripper` extracts and repairs it.

Out of scope: vision tokens, audio tokens, batch generation,
quantized KV cache. All can be added later when the use case needs
them; today they'd just be dead code.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import os
import re
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import mlx.core as mx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# mlx_vlm internals we lean on. Importing utils.load + prompt_utils +
# generate.stream_generate gives us the same model loading, chat
# templating, and generation primitives as the upstream server. The
# PromptCacheState class is the single bit of upstream-public API
# that does the work — see its docstring in mlx_vlm/generate.py.
from mlx_vlm.generate import PromptCacheState, stream_generate
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import load

# Local module — disk persistence for PromptCacheState.
# Imported by relative path so the file works whether the server is
# launched as a module or as a free script (Electron's bundle layout
# extracts both .py files into the same dir).
sys.path.insert(0, str(Path(__file__).parent))
import cache_persist  # noqa: E402
import tool_grammar  # noqa: E402


# ───────── Leaked special-token scrub ─────────

# Chat-template framing tokens — turn / sequence / tool-response
# delimiters that tight quants (e.g. gemma4-e4b-q8) sometimes emit as
# literal special-token text. `tokenizer.decode()` keeps special tokens,
# so these render into the SSE content stream verbatim; wild-caught case
# was gemma4-e4b-q8 streaming `<eos><|tool_response><eos>` after firing
# its tool calls. We scrub them at every detokenization site so they
# never reach the client.
#
# Deliberately NOT scrubbed: the tool-CALL markers `<|tool_call>` /
# `<tool_call|>` (and `<|tool>` / `<tool|>`). The gezel-side
# LeakyToolCallStripper relies on those flowing through as text to
# salvage and repair tool calls — this server intentionally does no
# server-side tool-call extraction (see module docstring). A blanket
# `skip_special_tokens=True` would delete them too, which is why we
# strip a targeted denylist instead.
_LEAKED_MARKER_RE = re.compile(
    r"<\|?(?:eos|bos|pad|unk|mask|turn|tool_response|start_of_turn|end_of_turn|im_start|im_end)\|?>",
    re.IGNORECASE,
)


def _scrub_leaked_markers(text: str) -> str:
    """Drop chat-template framing special-tokens that leaked as text."""
    if not text or "<" not in text:
        return text
    return _LEAKED_MARKER_RE.sub("", text)


def _generation_config_eos_ids(model_dir: str) -> "List[int]":
    """Read the stop-token set a model declares in generation_config.json.

    mlx's tokenizer wrapper doesn't always surface the full eos set the
    model author declared. gemma4-e4b-q8 is the wild-caught case: it
    declares `eos_token_id: [1, 106, 50]` (`<eos>`, `<turn|>`,
    `<|tool_response>`), but the wrapper resolved a narrower set, so the
    batch engine never stopped on `<eos>` / `<|tool_response>` and
    streamed them as text after the model's tool calls. Merging these in
    halts generation at the real turn boundary instead of running on
    into framing tokens (the upstream fix that complements the scrub).
    """
    try:
        with open(os.path.join(model_dir, "generation_config.json")) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return []
    eos = cfg.get("eos_token_id")
    if isinstance(eos, bool):  # guard: bools are ints in Python
        return []
    if isinstance(eos, int):
        return [eos]
    if isinstance(eos, list):
        return [int(e) for e in eos if isinstance(e, int) and not isinstance(e, bool)]
    return []


def _tool_call_close_stop_ids(model_dir: str) -> "List[int]":
    """`</tool_call>` special-token ids to halt a turn at the first closed
    tool call — for models that expect a server-side tool-call parser we
    don't run.

    Poolside Laguna (and kin) declare `tool_call_parser` in
    generation_config.json and emit `<tool_call>…</tool_call>` WITHOUT
    listing `</tool_call>` in `eos_token_id`: their production server (the
    `*_v1` parser) detects the closed call and stops generation. On
    mlx_vlm's raw completion path nothing stops it, so the model runs on
    past the first call and loops out hundreds of calls in a single turn
    until the SSE stalls (wild-caught: laguna-s-118b/MLX — ~450
    `<tool_call>` spans in one turn, then a 300s silent stall → the whole
    turn aborts and no call lands). Making the `</tool_call>` special token
    a stop halts the turn at the first closed call; the gezel GLM salvage
    layer promotes it and the agentic loop advances one call per turn.

    Gated on the model DECLARING a non-empty `tool_call_parser` so models
    that end tool-call turns on their own eos (Qwen/Gemma) are untouched —
    zero regression risk for the already-tuned cast.
    """
    try:
        with open(os.path.join(model_dir, "generation_config.json")) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return []
    parser = cfg.get("tool_call_parser")
    if not isinstance(parser, str) or not parser:
        return []
    try:
        with open(os.path.join(model_dir, "tokenizer_config.json")) as f:
            tcfg = json.load(f)
    except (OSError, ValueError):
        return []
    added = tcfg.get("added_tokens_decoder") or {}
    ids: "List[int]" = []
    for sid, meta in added.items():
        if isinstance(meta, dict) and meta.get("content") == "</tool_call>":
            try:
                ids.append(int(sid))
            except (TypeError, ValueError):
                pass
    return ids


# ───────── Configuration (CLI args) ─────────

parser = argparse.ArgumentParser(description="gezel MLX wrapper server")
parser.add_argument("--model", required=True, help="Path to the MLX model directory")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8080)
parser.add_argument(
    "--cache-budget-mb",
    type=int,
    default=4096,
    help="Bound on total in-memory prompt-cache size before LRU eviction.",
)
parser.add_argument(
    "--prefill-step-size",
    type=int,
    default=2048,
    help="Tokens per prefill step. Lower = less peak memory, slower.",
)
parser.add_argument(
    "--persist-dir",
    type=str,
    default=None,
    help=(
        "Directory for on-disk PromptCacheState persistence. When set, "
        "in-memory cache misses fall back to a disk lookup, evictions "
        "save before dropping, and graceful shutdown flushes all warm "
        "entries. Disabled when unset (matches Phase 2 behavior)."
    ),
)
parser.add_argument(
    "--model-fingerprint",
    type=str,
    default=None,
    help=(
        "Stable identifier for the loaded model — sha256-derived from the "
        "manifest. Disk-cache entries are segmented by fingerprint so a "
        "model swap can never load wrong-shape KV state. Required when "
        "--persist-dir is set."
    ),
)
parser.add_argument(
    "--disk-cache-budget-mb",
    type=int,
    default=8192,
    help=(
        "Bound on total on-disk persisted cache size. LRU pruning runs "
        "after every save when over budget. 0 disables pruning."
    ),
)
parser.add_argument(
    "--max-concurrency",
    type=int,
    default=1,
    help=(
        "Max sequences to generate concurrently. 1 (default) keeps the "
        "serial `stream_generate` + _GENERATION_LOCK path, byte-identical to "
        "before. N>1 routes generation through a single mlx_lm BatchGenerator "
        "(continuous batching) so up to N chat turns share batched decode "
        "passes. Set from the TS provider's batchMaxConcurrency."
    ),
)
parser.add_argument(
    "--gpu-memory-limit-mb",
    type=int,
    default=0,
    help=(
        "Total GPU/unified-memory budget (MB) this engine may use — weights + "
        "KV + compute. Set from the TS capacity broker (min of the model budget "
        "and Metal's recommended working set). Drives memory-aware wave "
        "admission: when live usage nears this ceiling the BatchGenerator "
        "collapses toward serial instead of co-batching concurrent prefills "
        "into a Metal command-buffer OOM (which SIGABRTs the whole process). "
        "0 (default) = unset → admit purely on --max-concurrency, as before."
    ),
)
ARGS = parser.parse_args()


# Resolve the persistence directory once. None means disk persistence
# is disabled — every code path that touches disk gates on this.
PERSIST_DIR: Optional[Path] = (
    Path(ARGS.persist_dir).expanduser() if ARGS.persist_dir else None
)
MODEL_FINGERPRINT: Optional[str] = ARGS.model_fingerprint
if PERSIST_DIR is not None and not MODEL_FINGERPRINT:
    print(
        "[cache] --persist-dir set without --model-fingerprint; refusing to "
        "persist (mismatched fingerprints would silently corrupt outputs).",
        flush=True,
    )
    PERSIST_DIR = None


def _disk_enabled() -> bool:
    return PERSIST_DIR is not None and MODEL_FINGERPRINT is not None


# ───────── Parent-death watchdog ─────────


def _start_parent_death_watchdog() -> None:
    """Self-terminate if our parent process goes away.

    Why: this server holds 10–20 GB of model weights in unified memory.
    If the gezel daemon crashes, is force-quit, or is SIGKILL'd by
    VSCode's debug "Stop" button, we get reparented to launchd (pid 1)
    and sit on that RAM forever — orphan instances accumulate every
    dev iteration.

    macOS has no `prctl(PR_SET_PDEATHSIG)` equivalent; polling
    `getppid()` from a daemon thread is the portable substitute. The
    GIL is released during MLX/torch native compute and during uvicorn
    epoll waits, so the 2s tick still fires reliably even under load.
    A `daemon=True` thread doesn't block interpreter shutdown when the
    main thread exits cleanly — the watchdog only matters for the
    crash path.
    """
    initial_ppid = os.getppid()
    if initial_ppid == 1:
        # Already orphaned at startup — there's no parent to serve.
        # Refuse to load weights only to immediately leak them.
        print(
            "[gezel-mlx] parent already pid=1 at startup; refusing to load model",
            flush=True,
        )
        os._exit(1)

    def watch() -> None:
        while True:
            time.sleep(2.0)
            current = os.getppid()
            if current == initial_ppid:
                continue
            # Reparented — original parent is gone. The new ppid is
            # almost always 1 (launchd) or a session leader; either way
            # nobody who started us is still listening, so release the
            # model RAM. `os._exit` skips atexit/finalizers — uvicorn's
            # graceful-shutdown path would try to drain in-flight
            # streams against a dead client and stall, which defeats
            # the point of the watchdog.
            print(
                f"[gezel-mlx] parent vanished (was {initial_ppid}, now {current}); exiting",
                flush=True,
            )
            os._exit(0)

    t = threading.Thread(
        target=watch, name="gezel-parent-death-watchdog", daemon=True
    )
    t.start()


_start_parent_death_watchdog()


# ───────── Model loading (one-shot at startup) ─────────

print(f"Started server process [{os.getpid()}]", flush=True)
print("Waiting for application startup.", flush=True)
print(f"Loading model from: {ARGS.model}", flush=True)
MODEL, PROCESSOR = load(ARGS.model)
print("Model and processor loaded successfully.", flush=True)


# ───────── GPU memory ceiling (Metal) ─────────
# Effective ceiling on total unified-memory this engine may use — weights + KV
# + compute. The batch admission path (BatchEngine._admit_count) reads live
# usage against it to decide how many concurrent prefills to start, so a wave
# never piles KV past the point where a Metal command-buffer allocation aborts
# the whole python process. 0 = unset (no ceiling → admit on width alone).
_MEM_LIMIT_BYTES = 0
# Throttle a multi-sub wave down to serial once live allocation reaches this
# fraction of the ceiling. Leaves headroom for the wave's own prefill/compute
# activation buffers, which land on top of already-resident weights + KV.
_MEM_ADMIT_FRACTION = 0.85


def _safe_active_memory() -> int:
    """Live MLX allocation in bytes (weights + resident KV), or 0 if the
    runtime doesn't expose it. Read-only; never raises."""
    try:
        return int(mx.get_active_memory())
    except Exception:  # noqa: BLE001 — introspection is best-effort
        return 0


def _metal_recommended_working_set() -> int:
    """Metal's `max_recommended_working_set_size` (bytes), or 0 if unavailable.
    This is the OS's own soft ceiling for GPU-resident memory."""
    try:
        info = mx.metal.device_info()
        return int(info.get("max_recommended_working_set_size", 0) or 0)
    except Exception:  # noqa: BLE001 — API shape varies across mlx versions
        return 0


def _setup_gpu_memory_ceiling() -> None:
    """Resolve the effective memory ceiling and wire weights.

    The ceiling is the smaller of what the supervisor budgeted for this model
    (`--gpu-memory-limit-mb`, from the TS capacity broker) and what Metal
    recommends as a working set — whichever is tighter is the honest bound.
    Everything here is guarded: a version whose mlx lacks these calls must
    degrade to "no ceiling" (width-only admission), never crash startup.
    """
    global _MEM_LIMIT_BYTES
    recommended = _metal_recommended_working_set()
    arg_limit = max(0, int(getattr(ARGS, "gpu_memory_limit_mb", 0) or 0)) * 1024 * 1024
    candidates = [b for b in (recommended, arg_limit) if b > 0]
    _MEM_LIMIT_BYTES = min(candidates) if candidates else 0
    # Wire weights up to the ceiling so they aren't paged out under pressure —
    # Apple's recommended setting for steady-state inference. Guarded: harmless
    # to skip if the call is missing or rejects the value.
    if _MEM_LIMIT_BYTES > 0:
        set_wired = getattr(mx, "set_wired_limit", None)
        if set_wired is not None:
            try:
                set_wired(_MEM_LIMIT_BYTES)
            except Exception as exc:  # noqa: BLE001
                print(f"[mem] set_wired_limit skipped: {exc}", flush=True)
    print(
        f"[mem] gpu ceiling={_MEM_LIMIT_BYTES // (1024 * 1024)}MB "
        f"(budget={arg_limit // (1024 * 1024)}MB, "
        f"metal_recommended={recommended // (1024 * 1024)}MB, "
        f"active={_safe_active_memory() // (1024 * 1024)}MB)",
        flush=True,
    )


_setup_gpu_memory_ceiling()


def _augment_serial_stop_set(processor, model_dir: str) -> None:
    """Merge generation_config.json's eos ids into the serial-path stop set.

    The serial (non-batch) stream path stops on
    `tokenizer.stopping_criteria.eos_token_ids`, seeded at load from the
    tokenizer's own (sometimes narrower) eos set — the same gap that let
    gemma4-e4b-q8 stream `<eos>` / `<|tool_response>` as text. We append
    the declared ids directly (not via `add_eos_token_ids`, which expects
    token *strings*). Defensive: mlx internals vary by version, so any
    structural mismatch is logged and skipped rather than crashing
    startup — the leaked-marker scrub still covers this path.
    """
    declared = _generation_config_eos_ids(model_dir) + _tool_call_close_stop_ids(model_dir)
    if not declared:
        return
    try:
        tok = getattr(processor, "tokenizer", None) or processor
        criteria = getattr(tok, "stopping_criteria", None)
        existing = getattr(criteria, "eos_token_ids", None)
        if existing is None:
            return
        added = [e for e in declared if e not in existing]
        existing.extend(added)
        print(
            f"[serial] stop set +{len(added)} from generation_config "
            f"(now {len(existing)})",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001 — never fail startup over this
        print(f"[serial] stop-set augment skipped: {exc}", flush=True)


_augment_serial_stop_set(PROCESSOR, ARGS.model)
print("Application startup complete.", flush=True)
print(
    f"Uvicorn running on http://{ARGS.host}:{ARGS.port} (Press CTRL+C to quit)",
    flush=True,
)


# ───────── Prompt cache layer ─────────

# Per-cache_id state: (cache_state, est_bytes, last_used_ts).
# The cache_state holds both the KV cache list and the token_ids
# prefix; mlx-vlm uses these together to decide what to prefill.
class CacheEntry:
    __slots__ = ("state", "est_bytes", "last_used_ts")

    def __init__(self, state: PromptCacheState, est_bytes: int, last_used_ts: float):
        self.state = state
        self.est_bytes = est_bytes
        self.last_used_ts = last_used_ts


# Module-level cache. Bounded by `--cache-budget-mb` via LRU eviction.
_CACHE: Dict[str, CacheEntry] = {}


# Cache ids (session + its seed prefix) currently being SERVED — registered
# at the top of a chat-completions request and cleared when its stream ends.
# Eviction (both in-memory `_enforce_budget` and `_enforce_disk_budget`) skips
# these so the very entry a live turn is about to reuse can't be dropped out
# from under it mid-flight. Without this pin, a long turn on a busy multi-
# session box can have its own (least-recently-used, because it's been
# streaming) prefix evicted, forcing a cold full re-prefill on the next step
# — exactly the kind of churn that compounds the 27B first-token stall.
# Multiset-counted (a value > 0 means pinned) so overlapping requests that
# share a prefix id don't unpin each other early.
_INFLIGHT_CACHE_IDS: "collections.Counter[str]" = collections.Counter()


def _mark_inflight(*cache_ids: Optional[str]) -> List[str]:
    """Pin the given (non-empty) cache ids from eviction. Returns the list
    actually pinned, to hand to {@link _unmark_inflight} in a finally."""
    pinned: List[str] = []
    for cid in cache_ids:
        if cid:
            _INFLIGHT_CACHE_IDS[cid] += 1
            pinned.append(cid)
    return pinned


def _unmark_inflight(cache_ids: List[str]) -> None:
    # `.get` / `.pop(default)` rather than `[cid]` / `del`: a Counter returns 0
    # for an absent key but `del` on it raises KeyError, so a stray double-
    # release (or release of something never marked) must not crash the worker.
    for cid in cache_ids:
        count = _INFLIGHT_CACHE_IDS.get(cid, 0)
        if count <= 1:
            _INFLIGHT_CACHE_IDS.pop(cid, None)
        else:
            _INFLIGHT_CACHE_IDS[cid] = count - 1


# Serializes the actual `stream_generate` GPU work across concurrent
# requests. MLX text-only generation isn't safely batched in our wrapper
# (no shared-prefix batching path, KV state lives on one Metal stream),
# so two simultaneous chat completions would race the shared model
# state and the per-cache_id KV save/restore. The TS-side ProviderQueue
# now defaults to concurrency=2 to break the `ask_specialist`/`ask_gezel`
# deadlock; this lock guarantees the engine still sees one stream at a
# time. The lock is only held across the `for chunk in stream_generate(...)`
# loop — cache lookup and cache save run outside it so the second request
# can start its prefill prep while the first is still streaming.
#
# NOTE: must be constructed inside an event loop. FastAPI's lifespan
# handles that — the lock is lazily allocated on first request.
_GENERATION_LOCK: Optional[asyncio.Lock] = None


def _get_generation_lock() -> asyncio.Lock:
    global _GENERATION_LOCK
    if _GENERATION_LOCK is None:
        _GENERATION_LOCK = asyncio.Lock()
    return _GENERATION_LOCK


def _budget_bytes() -> int:
    return ARGS.cache_budget_mb * 1024 * 1024


# Per-token byte estimate. 100 KB is a reasonable mid-figure for
# sliding-window-attention models (Gemma 3/4) where most layers are
# windowed and don't grow linearly with token count. Higher estimates
# (e.g. naive 2 × num_layers × hidden_size × 2 bytes for full KV)
# overcommit memory and trigger spurious eviction. Used purely for
# LRU + budget math; the underlying mlx_vlm cache state is what
# actually consumes memory.
_BYTES_PER_TOKEN = 100 * 1024


def _estimate_cache_bytes(state: PromptCacheState) -> int:
    if state.token_ids is None:
        return 0
    return len(state.token_ids) * _BYTES_PER_TOKEN


def _enforce_budget() -> None:
    """LRU eviction down to <= 80% of budget when over budget.

    Two safety rails on top of the basic LRU:
      1. NEVER evict the only entry. Evicting it buys nothing — the
         next chat-completions request will immediately re-prefill it
         back to the same size. Single-session users would loop
         forever paying full prefill cost otherwise.
      2. Stop evicting once one entry remains, regardless of budget.
         An over-budget single entry is a signal that the budget is
         too tight for this model; keeping the entry preserves cache
         reuse across turns. Operators see usage exceeding budget
         in /v1/cache/stats and can tune up.

    When disk persistence is enabled, we save each evicted entry before
    dropping it. The next session that asks for the same cache_id will
    load it back from disk (cheap mmap read) instead of paying the
    full prefill cost again.
    """
    total = sum(e.est_bytes for e in _CACHE.values())
    budget = _budget_bytes()
    if total < budget:
        return
    if len(_CACHE) <= 1:
        return  # don't evict the only entry — cache reuse needs it
    target = int(budget * 0.8)
    # Sort by lru ascending; pop oldest until under target OR only one entry left.
    items = sorted(_CACHE.items(), key=lambda kv: kv[1].last_used_ts)
    for cache_id, entry in items:
        if total < target or len(_CACHE) <= 1:
            break
        # Never evict an entry a live turn is currently serving — dropping
        # it forces that turn into a cold re-prefill mid-flight.
        if cache_id in _INFLIGHT_CACHE_IDS:
            continue
        # Persist before dropping. Best-effort — failure here just means
        # the next session pays the prefill cost, which is the
        # pre-persistence behavior.
        if _disk_enabled():
            cache_persist.save_cache(
                PERSIST_DIR, MODEL_FINGERPRINT, cache_id, entry.state  # type: ignore[arg-type]
            )
        del _CACHE[cache_id]
        total -= entry.est_bytes
        print(f"[cache] evicted cache_id={cache_id} (LRU, in-engine budget)", flush=True)
    # Disk-budget enforcement runs independently of in-memory eviction:
    # we may have just added new on-disk entries that push us over the
    # disk cap. LRU prune by mtime keeps total disk usage bounded.
    _enforce_disk_budget()


def _enforce_disk_budget() -> None:
    """Prune the oldest persisted cache files when over disk budget.

    Off-by-default-when-zero: operators on a machine with abundant SSD
    space can set --disk-cache-budget-mb=0 and let the OS reclaim
    however much it needs. The default budget (8 GB) is generous for
    the typical 25K-token Meester session (~2.5 GB) plus several
    smaller sibling sessions.
    """
    if not _disk_enabled():
        return
    if ARGS.disk_cache_budget_mb <= 0:
        return
    budget_bytes = ARGS.disk_cache_budget_mb * 1024 * 1024
    entries = cache_persist.list_persisted(PERSIST_DIR, MODEL_FINGERPRINT)  # type: ignore[arg-type]
    total = sum(size for (_, size, _) in entries)
    if total < budget_bytes:
        return
    target = int(budget_bytes * 0.8)
    for cache_id, size, _mtime in entries:
        if total < target:
            break
        # Skip the on-disk copy of an entry a live turn is serving — the
        # in-memory pin above keeps it resident, but a sibling turn that
        # disk-reloads the same prefix mid-flight must still find the file.
        if cache_id in _INFLIGHT_CACHE_IDS:
            continue
        if cache_persist.delete_cache(PERSIST_DIR, MODEL_FINGERPRINT, cache_id):  # type: ignore[arg-type]
            total -= size
            print(f"[cache] disk-evicted cache_id={cache_id} (LRU, disk budget)", flush=True)


def _save_cache(cache_id: str, state: PromptCacheState) -> None:
    bytes_est = _estimate_cache_bytes(state)
    _CACHE[cache_id] = CacheEntry(state=state, est_bytes=bytes_est, last_used_ts=time.time())
    _enforce_budget()


def _try_load_from_disk(cache_id: str) -> Optional[PromptCacheState]:
    """Pull a cache entry off disk into _CACHE under the given id.

    Returns the loaded state on hit (also installs in _CACHE), None on
    miss / corruption / fingerprint mismatch. The next save will write
    back through the normal path.
    """
    if not _disk_enabled():
        return None
    state = cache_persist.load_cache(PERSIST_DIR, MODEL_FINGERPRINT, cache_id)  # type: ignore[arg-type]
    if state is None:
        return None
    bytes_est = _estimate_cache_bytes(state)
    _CACHE[cache_id] = CacheEntry(
        state=state, est_bytes=bytes_est, last_used_ts=time.time()
    )
    print(
        f"[cache] disk-load cache_id={cache_id} tokens={len(state.token_ids or [])}",
        flush=True,
    )
    return state


def _try_seed_from_prefix(cache_id: str, prefix_cache_id: str) -> Optional[PromptCacheState]:
    """When a session misses, fall back to its gezel-prefix entry.

    Loads the prefix-shaped entry from disk and registers it under
    `cache_id` so the session inherits it as its starting state. The
    prefix file is never overwritten by the session — its own delta
    saves under its own cache_id. This is how new sessions for an
    existing gezel skip the system-prompt prefill cost.

    Returns None on any miss; the caller falls through to fresh state.
    """
    if not _disk_enabled():
        return None
    state = cache_persist.load_cache(
        PERSIST_DIR, MODEL_FINGERPRINT, prefix_cache_id  # type: ignore[arg-type]
    )
    if state is None:
        return None
    bytes_est = _estimate_cache_bytes(state)
    _CACHE[cache_id] = CacheEntry(
        state=state, est_bytes=bytes_est, last_used_ts=time.time()
    )
    print(
        f"[cache] prefix-seed cache_id={cache_id} from prefix={prefix_cache_id} "
        f"tokens={len(state.token_ids or [])}",
        flush=True,
    )
    return state


def _request_prefix_ids(request) -> List[str]:
    """Ordered, most-specific-first prefix ids for this request. Prefers the
    layered `prefix_cache_ids`; falls back to the singular `prefix_cache_id`
    for back-compat. Filters out empties."""
    if getattr(request, "prefix_cache_ids", None):
        return [p for p in request.prefix_cache_ids if p]
    if request.prefix_cache_id:
        return [request.prefix_cache_id]
    return []


# Prefix ids we've already seeded from a real session save this process.
# Mirrors the llama-cpp adapter's `seededPrefixes` — seed once per process
# so back-to-back sessions don't repeatedly rewrite the same prefix file.
_SEEDED_PREFIXES: set = set()


def _seed_prefix_from_session(request, state: PromptCacheState) -> None:
    """Seed the most-specific (gp) prefix entry from a real session's saved
    state so a SIBLING session (same gezel+project, different volatile state)
    inherits the warm `[system+tools]` prefix on its next turn — the
    cross-session win the layered flag exists for.

    Mirrors the llama-cpp adapter, which copies a slot save into a
    `prefix-<hash>.bin` file. The seeded entry holds this session's full
    state (system+tools+transcript); a sibling's longest-common-prefix trim
    reuses only the shared `[system+tools]` head and re-prefills its own
    divergent tail. Best-effort, once per prefix per process; never blocks
    the request path on failure.
    """
    if not _disk_enabled():
        return
    ids = _request_prefix_ids(request)
    if not ids:
        return
    gp = ids[0]
    if gp in _SEEDED_PREFIXES:
        return
    try:
        if cache_persist.save_cache(PERSIST_DIR, MODEL_FINGERPRINT, gp, state):  # type: ignore[arg-type]
            _SEEDED_PREFIXES.add(gp)
            _enforce_disk_budget()
            print(
                f"[cache] prefix-seeded {gp} from cache_id={request.cache_id} "
                f"tokens={len(state.token_ids or [])}",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001 — best-effort, never fail the turn
        print(f"[cache] prefix-seed failed for {gp}: {exc}", flush=True)


# ───────── Batched / continuous-generation engine (--max-concurrency > 1) ─────────
#
# When launched with --max-concurrency N>1, generation runs through a
# single BatchEngine instead of the serial `stream_generate` +
# _GENERATION_LOCK path. The engine owns one mlx_lm BatchGenerator
# (continuous batching) driven by ONE asyncio worker on the event-loop
# thread — MLX GPU streams are thread-local (see the chat_completions
# note), so all model work stays on that thread, multiplexed across
# sequences rather than serialized. Every per-session concern maps to a
# per-sequence list in the BatchGenerator API (sampler, logits processors
# incl. the tool grammar, seed KV cache, max_tokens); on finish we extract
# the sequence's KV and persist it via the SAME _save_cache /
# _seed_prefix_from_session path the serial route uses.


def _resolve_cache_state(request):
    """The cache cascade (memory → disk → prefix-seed → fresh), shared by
    the serial and batched paths. Returns (state, source, matched_prefix)."""
    cache_state = None
    cache_source = "fresh"
    matched_prefix = None
    if request.cache_id:
        existing_entry = _CACHE.get(request.cache_id)
        if existing_entry is not None:
            cache_state = existing_entry.state
            existing_entry.last_used_ts = time.time()
            cache_source = "memory"
        else:
            disk_state = _try_load_from_disk(request.cache_id)
            if disk_state is not None:
                cache_state = disk_state
                cache_source = "disk"
            else:
                for pid in _request_prefix_ids(request):
                    seeded = _try_seed_from_prefix(request.cache_id, pid)
                    if seeded is not None:
                        cache_state = seeded
                        cache_source = "prefix"
                        matched_prefix = pid
                        break
    if cache_state is None:
        cache_state = PromptCacheState()
    return cache_state, cache_source, matched_prefix


class _UnwrapLM:
    """mlx_vlm's LanguageModel returns LanguageModelOutput(.logits); mlx_lm's
    BatchGenerator wants a raw logits array. Thin shim: unwrap `.logits` and
    delegate every other attribute (layers, config, make_cache, …) to the
    wrapped model."""

    def __init__(self, inner):
        self._inner = inner
        self.layers = inner.layers

    def __call__(self, *args, **kwargs):
        out = self._inner(*args, **kwargs)
        return getattr(out, "logits", out)

    def __getattr__(self, name):
        return getattr(self._inner, name)


# Batched-prefill liveness tuning. Only emit a marker for waves big enough
# that prefill is non-trivial (small prompts return a first token fast, so a
# marker would just be noise), and no more often than the interval so a
# chunk-iterating worker loop doesn't spam the log.
_PREFILL_LIVENESS_MIN_TOKENS = 2048
_PREFILL_LIVENESS_INTERVAL_S = 4.0


class _Sub:
    """One in-flight batched request: its decode queue, accumulated tokens,
    and the bits needed to build its sequence + persist its KV on finish."""

    __slots__ = (
        "request", "prompt_tokens", "grammar", "seed_state", "request_id",
        "http_request", "uid", "queue", "cancelled", "token_ids", "emitted",
        "pinned_cache_ids", "prefill_total", "first_token_seen",
    )

    def __init__(self, request, prompt_tokens, grammar, seed_state, request_id, http_request):
        self.request = request
        self.prompt_tokens = prompt_tokens   # List[int], full prompt
        self.grammar = grammar               # SafeToolGrammarProcessor | None
        self.seed_state = seed_state         # PromptCacheState from the cascade
        self.request_id = request_id
        self.http_request = http_request
        self.uid = None
        self.queue: asyncio.Queue = asyncio.Queue()
        self.cancelled = False
        self.token_ids = []                  # generated token ids
        self.emitted = 0                     # chars already streamed
        self.pinned_cache_ids: List[str] = []  # eviction pins to release on stream end
        self.prefill_total = 0               # new tokens this sub must prefill
        self.first_token_seen = False        # flips once decode emits a token


class BatchEngine:
    """Owns one mlx_lm BatchGenerator + the single worker that drives it."""

    def __init__(self, model, tokenizer, max_concurrency):
        from mlx_lm.generate import BatchGenerator  # local: only when batching

        self._tok = tokenizer
        self._max = max(1, int(max_concurrency))
        eos = getattr(tokenizer, "eos_token_ids", None)
        if eos is None:
            eos = getattr(tokenizer, "eos_token_id", None)
        if eos is None:
            eos_list = []
        elif isinstance(eos, int):
            eos_list = [eos]
        else:
            eos_list = list(eos)
        # Union in the stop set the model author declared in
        # generation_config.json — the tokenizer wrapper sometimes
        # resolves a narrower eos set than the model actually ends turns
        # on (see _generation_config_eos_ids).
        eos_from_cfg = _generation_config_eos_ids(ARGS.model)
        for e in eos_from_cfg:
            if e not in eos_list:
                eos_list.append(e)
        # Halt at the first closed `<tool_call>` for models that declare a
        # server-side tool_call_parser but don't list `</tool_call>` in eos
        # (poolside Laguna) — otherwise the raw completion path never stops
        # after a call and loops hundreds of them per turn until the SSE
        # stalls. See _tool_call_close_stop_ids.
        tool_close = _tool_call_close_stop_ids(ARGS.model)
        for e in tool_close:
            if e not in eos_list:
                eos_list.append(e)
        stop_tokens = [[int(e)] for e in eos_list]
        self._gen = BatchGenerator(
            model,
            max_tokens=2048,
            stop_tokens=stop_tokens or None,
            completion_batch_size=self._max,
            prefill_batch_size=self._max,
            prefill_step_size=ARGS.prefill_step_size,
        )
        self._subs = {}            # uid -> _Sub
        self._pending = []         # _Sub awaiting insert
        self._wake = asyncio.Event()
        self._worker = None
        # Prefill-liveness for the current wave. The batched path prefills the
        # whole prompt inside BatchGenerator with NO tqdm bar (unlike the
        # serial mlx_vlm path), so the TS watchdog saw zero prefill events and
        # the engine looked silent through a long first-token wait (the
        # qwen3.6-27b 37K-token stall). We emit a `Prefill:`-shaped marker the
        # stdout-parser already understands so the watchdog knows the engine is
        # alive + prefilling N tokens, and the UI pill shows it.
        self._prefill_total = 0      # new tokens the active wave is prefilling
        self._last_prefill_emit = 0.0
        print(
            f"[batch] engine ready max_concurrency={self._max} "
            f"stop_tokens={len(stop_tokens)} (+{len(eos_from_cfg)} from generation_config"
            f"{f', +{len(tool_close)} </tool_call>' if tool_close else ''})",
            flush=True,
        )

    def submit(self, sub):
        if self._worker is None:
            self._worker = asyncio.ensure_future(self._run())
        self._pending.append(sub)
        self._wake.set()

    def _sampler_for(self, request):
        from mlx_lm.sample_utils import make_sampler

        return make_sampler(
            temp=float(request.temperature) if request.temperature is not None else 0.0,
            top_p=float(request.top_p) if request.top_p is not None else 0.0,
            top_k=int(request.top_k) if request.top_k is not None else 0,
        )

    def _processors_for(self, request, grammar):
        from mlx_lm.sample_utils import make_logits_processors

        procs = []
        if request.repetition_penalty is not None:
            procs = make_logits_processors(
                repetition_penalty=float(request.repetition_penalty),
                repetition_context_size=int(request.repetition_context_size or 20),
            )
        if grammar is not None:
            procs = list(procs) + [grammar]
        return procs or None

    def _seed_args(self, sub):
        """(segment_tokens, caches, all_tokens): reuse the session's cached
        prefix when it's a true prefix of this prompt; else fresh prefill."""
        st = sub.seed_state
        cached = list(st.token_ids or []) if st is not None else []
        n = len(cached)
        full = sub.prompt_tokens
        if 0 < n < len(full) and getattr(st, "cache", None) and full[:n] == cached:
            return full[n:], st.cache, cached
        return full, None, []  # fresh: no seed cache, no prior tokens

    def _emit_prefill_liveness(self) -> None:
        """While the active wave is still prefilling (no token emitted yet),
        print a `Prefill:` line the supervisor's stdout-parser turns into a
        `prefill` phase event — keeping the TS pre-first-byte watchdog anchored
        on real engine liveness instead of tripping its silent-cold-start
        bound. Honest by construction: it only fires while `_prefill_total > 0`
        (cleared the instant the first token lands), and only from the live
        worker loop — a genuinely wedged engine emits nothing and still trips.

        We can't report a true mid-prefill percentage (BatchGenerator doesn't
        expose one and may prefill in a single event-loop-blocking call), so
        the marker carries 0% with the token total; the parser + watchdog only
        need the liveness signal and the size for the abort message / UI."""
        total = self._prefill_total
        if total < _PREFILL_LIVENESS_MIN_TOKENS:
            return
        now = time.time()
        if now - self._last_prefill_emit < _PREFILL_LIVENESS_INTERVAL_S:
            return
        self._last_prefill_emit = now
        # Format MUST match stdout-parser's Prefill regex:
        #   Prefill:   0%|   | 0/<total> [batched]
        print(f"Prefill:   0%|          | 0/{total} [batched]", flush=True)

    def _admit_count(self, pending: int) -> int:
        """How many of the `pending` co-arrived subs to start THIS wave.

        Ground-truth backstop to the TS-side slot ceiling: even within a
        memory-safe width, the coarse pre-spawn KV estimate can be wrong (KV
        scales with a model's layer/head geometry, which the broker estimates
        from weight bytes). So before co-batching concurrent prefills we check
        LIVE allocation against the ceiling and collapse toward serial when
        tight — one large prefill on an already-full device is what aborts
        Metal. Returns `pending` unchanged when no ceiling is configured or
        memory is roomy, so the common case is byte-identical to before."""
        if pending <= 1 or _MEM_LIMIT_BYTES <= 0:
            return pending
        threshold = _MEM_LIMIT_BYTES * _MEM_ADMIT_FRACTION
        active = _safe_active_memory()
        if active <= 0:
            return pending  # can't read usage → don't second-guess the width
        if active >= threshold:
            # Already tight before this wave even starts — reclaim any freed
            # buffer cache and re-check once before forcing serial.
            try:
                mx.clear_cache()
            except Exception:  # noqa: BLE001
                pass
            active = _safe_active_memory()
        return 1 if active >= threshold else pending

    async def _run(self):
        while True:
            if not self._pending and not self._subs:
                self._wake.clear()
                await self._wake.wait()

            # Evict client-disconnected sequences before stepping.
            gone = [uid for uid, s in self._subs.items() if s.cancelled]
            if gone:
                try:
                    self._gen.remove(gone)
                except Exception as exc:  # noqa: BLE001
                    print(f"[batch] remove failed: {exc}", flush=True)
                for uid in gone:
                    self._subs.pop(uid, None)

            # Static-wave admission: only start a new batch when the current
            # one has fully drained. mlx_lm's continuous merge of a mid-flight
            # prompt batch into the running generation batch isn't supported by
            # the mlx_vlm model caches here (raises broadcast (N),(M)), so we
            # batch co-arriving requests into a wave and run it to completion
            # before admitting the next. Co-arriving turns (multi-pane,
            # ask-chains) still share batched decode; a turn that arrives
            # mid-wave waits for the wave to drain — no worse than the old
            # serial path, and strictly better when turns arrive together.
            if self._pending and not self._subs:
                admit_n = self._admit_count(len(self._pending))
                batch = self._pending[:admit_n]
                self._pending = self._pending[admit_n:]
                if self._pending:
                    # Deferred under memory pressure — the remaining subs run in
                    # the next wave, after this one drains and frees its KV. The
                    # outer loop re-enters admission once _subs empties (it never
                    # blocks on _wake while _pending is non-empty).
                    print(
                        f"[batch] memory-throttled: admitting {len(batch)}, "
                        f"deferring {len(self._pending)} to next wave "
                        f"(active={_safe_active_memory() // (1024 * 1024)}MB, "
                        f"ceiling={_MEM_LIMIT_BYTES // (1024 * 1024)}MB)",
                        flush=True,
                    )
                prompts, caches, alltoks, samplers, lps, maxtoks = [], [], [], [], [], []
                for sub in batch:
                    seg, c, at = self._seed_args(sub)
                    prompts.append(seg)
                    caches.append(c)
                    alltoks.append(at)
                    samplers.append(self._sampler_for(sub.request))
                    lps.append(self._processors_for(sub.request, sub.grammar))
                    maxtoks.append(int(sub.request.max_tokens) if sub.request.max_tokens else 2048)
                try:
                    uids = self._gen.insert(
                        prompts=prompts,
                        max_tokens=maxtoks,
                        caches=caches,
                        all_tokens=alltoks,
                        samplers=samplers,
                        logits_processors=lps,
                    )
                except Exception as exc:  # noqa: BLE001
                    print(f"[batch] insert failed: {exc}", flush=True)
                    traceback.print_exc()
                    for sub in batch:
                        sub.queue.put_nowait(("err", str(exc)))
                    continue
                for uid, sub in zip(uids, batch):
                    sub.uid = uid
                    self._subs[uid] = sub
                # Arm prefill-liveness for the wave: total new tokens to
                # prefill across its subs. Reset the throttle so the first
                # marker emits immediately (before the blocking decode below).
                self._prefill_total = sum(
                    max(0, int(getattr(s, "prefill_total", 0))) for s in batch
                )
                self._last_prefill_emit = 0.0

            # One batched decode step across all active sequences.
            if self._subs:
                # Emit a prefill marker before the (potentially long, event-
                # loop-blocking) decode step so the watchdog sees liveness.
                # No-op once the first token lands (_prefill_total → 0).
                self._emit_prefill_liveness()
                try:
                    responses = self._gen.next_generated()
                except Exception as exc:  # noqa: BLE001
                    print(f"[batch] step failed: {exc}", flush=True)
                    traceback.print_exc()
                    for sub in list(self._subs.values()):
                        sub.queue.put_nowait(("err", str(exc)))
                    self._subs.clear()
                    continue
                if responses:
                    # A token came back → prefill for this wave is done; stop
                    # the liveness markers (the SSE first byte now drives the
                    # watchdog's tighter streaming-idle bound).
                    self._prefill_total = 0
                for r in responses:
                    sub = self._subs.get(r.uid)
                    if sub is None:
                        continue
                    sub.first_token_seen = True
                    sub.token_ids.append(int(r.token))
                    self._emit_delta(sub)
                    if r.finish_reason is not None:
                        self._finish(sub, r)
                        self._subs.pop(r.uid, None)
                # Yield so SSE generators flush + new requests get admitted.
                await asyncio.sleep(0)

    def _emit_delta(self, sub):
        # Full-decode-delta detokenization: correct across BPE merges /
        # multibyte chars (hold on a trailing replacement char until the
        # next token completes it). Fine for chat-length outputs.
        full = self._tok.decode(sub.token_ids)
        if full.endswith("�"):
            return
        # Strip leaked framing tokens before computing the delta. The scrub
        # is deterministic over the cumulative decode, so tracking `emitted`
        # against the scrubbed string stays consistent across steps.
        full = _scrub_leaked_markers(full)
        delta = full[sub.emitted :]
        if not delta:
            return
        sub.emitted = len(full)
        sub.queue.put_nowait(("tok", delta, len(sub.token_ids)))

    def _finish(self, sub, r):
        full = _scrub_leaked_markers(self._tok.decode(sub.token_ids))
        if len(full) > sub.emitted:
            sub.queue.put_nowait(("tok", full[sub.emitted :], len(sub.token_ids)))
            sub.emitted = len(full)
        try:
            if sub.request.cache_id:
                # On finish the sequence is already out of the generation
                # batch, so extract_cache(uid) misses — the Response carries
                # the final KV (`prompt_cache`) + full token list
                # (`all_tokens`). Fall back to a token reconstruction.
                cache_layers = getattr(r, "prompt_cache", None)
                all_tokens = getattr(r, "all_tokens", None)
                if cache_layers is not None:
                    state = PromptCacheState()
                    state.cache = list(cache_layers)
                    state.token_ids = (
                        [int(t) for t in all_tokens]
                        if all_tokens is not None
                        else list(sub.prompt_tokens) + list(sub.token_ids)
                    )
                    if state.token_ids:
                        _save_cache(sub.request.cache_id, state)
                        _seed_prefix_from_session(sub.request, state)
                        print(
                            f"[batch] saved cache_id={sub.request.cache_id} "
                            f"tokens={len(state.token_ids)}",
                            flush=True,
                        )
        except Exception as exc:  # noqa: BLE001
            print(f"[batch] cache save failed: {exc}", flush=True)
        sub.queue.put_nowait(("done", r.finish_reason))


async def _batched_stream_iter(sub: "_Sub"):
    """SSE generator for the batched path — same wire frames as the serial
    route, fed from the engine worker's per-sub queue."""
    request = sub.request
    rid = sub.request_id
    in_toks = len(sub.prompt_tokens)
    try:
        while True:
            item = await sub.queue.get()
            kind = item[0]
            if kind == "tok":
                _, delta, out_count = item
                if await sub.http_request.is_disconnected():
                    sub.cancelled = True
                    return
                yield "data: " + json.dumps(
                    {
                        "id": rid,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": request.model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant", "content": delta},
                                "finish_reason": None,
                            }
                        ],
                        "usage": {
                            "input_tokens": in_toks,
                            "output_tokens": out_count,
                            "total_tokens": in_toks + out_count,
                            "prompt_tps": 0.0,
                            "generation_tps": 0.0,
                        },
                    }
                ) + "\n\n"
            elif kind == "done":
                reason = item[1]
                yield "data: " + json.dumps(
                    {
                        "id": rid,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": request.model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant", "content": ""},
                                "finish_reason": "stop" if reason == "stop" else "length",
                            }
                        ],
                        "usage": {
                            "input_tokens": in_toks,
                            "output_tokens": len(sub.token_ids),
                            "total_tokens": in_toks + len(sub.token_ids),
                            "prompt_tps": 0.0,
                            "generation_tps": 0.0,
                        },
                    }
                ) + "\n\n"
                yield "data: [DONE]\n\n"
                return
            elif kind == "err":
                yield "data: " + json.dumps({"error": item[1]}) + "\n\n"
                return
    finally:
        # If we exit early (disconnect / error), make sure the worker evicts us.
        sub.cancelled = True
        # Release the eviction pins taken for this turn's cache + prefix.
        _unmark_inflight(sub.pinned_cache_ids)
        sub.pinned_cache_ids = []


_BATCH_ENGINE: "Optional[BatchEngine]" = None


def _get_batch_engine() -> "BatchEngine":
    global _BATCH_ENGINE
    if _BATCH_ENGINE is None:
        lm = getattr(MODEL, "language_model", MODEL)
        tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        _BATCH_ENGINE = BatchEngine(_UnwrapLM(lm), tok, ARGS.max_concurrency)
    return _BATCH_ENGINE


def _flush_all_to_disk() -> int:
    """Write every in-memory entry to disk. Returns the count saved.

    Called from the SIGTERM handler and the FastAPI shutdown event so a
    graceful supervisor stop preserves every warm session for the next
    boot. SIGKILL still loses everything (no handler runs); that's the
    pre-persistence cost as a worst case.
    """
    if not _disk_enabled():
        return 0
    saved = 0
    for cache_id, entry in list(_CACHE.items()):
        if cache_persist.save_cache(
            PERSIST_DIR, MODEL_FINGERPRINT, cache_id, entry.state  # type: ignore[arg-type]
        ):
            saved += 1
    if saved:
        print(f"[cache] flushed {saved} entries to disk on shutdown", flush=True)
    _enforce_disk_budget()
    return saved


# ───────── HTTP request/response models ─────────


class ChatMessageReq(BaseModel):
    role: str
    content: Any  # str or list[dict] (vision); we coerce to str below
    tool_call_id: Optional[str] = None


class ChatRequest(BaseModel):
    model: str
    messages: List[ChatMessageReq]
    stream: bool = True
    tools: Optional[List[Dict[str, Any]]] = None
    # Gezel extension. When set, the server preserves the post-generation
    # cache state under this key. When unset, behaves like upstream
    # mlx_vlm.server (cache cleared after the stream).
    cache_id: Optional[str] = None
    # Cross-session prefix sharing (Phase 1.3). When the session-specific
    # `cache_id` misses, the server falls back to loading this entry —
    # typically a per-gezel hash of the stable system prompt — and
    # registers it under the session's cache_id as a starting state.
    # First chat turn for a new session inherits the warm prefix
    # instead of cold-prefilling 2 KB of system prompt.
    prefix_cache_id: Optional[str] = None
    # Layered prefix sharing (flag `layeredPrefixCache`). An ordered,
    # most-specific-first list of prefix ids — typically
    # `[prefix-gp-<hash>, prefix-gezel-<hash>]`. On a session miss the
    # server tries each in order and seeds from the first hit, so a new
    # session inherits the warmest matching layer (gezel+project > gezel).
    # When set, takes precedence over the singular `prefix_cache_id`.
    prefix_cache_ids: Optional[List[str]] = None
    # Generation knobs (subset of mlx-vlm's). Not all are honored today —
    # we just need enough to run sensible defaults.
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    repetition_penalty: Optional[float] = None
    repetition_context_size: Optional[int] = None
    # Decode-time tool-call grammar (gezel extension). When set, the
    # server builds an llguidance logits processor that constrains the
    # function name of any tool call to the known tools — see
    # `build_tool_grammar_processor`. Shape: {"format": "...", "mode": "name-only"}.
    tool_grammar: Optional[Dict[str, Any]] = None
    # Per-request chat-template override (gezel extension). Swaps the
    # model's stored Jinja template for a curated one without reinstalling.
    chat_template_override: Optional[str] = None


class CacheStatsEntry(BaseModel):
    cache_id: str
    token_count: int
    est_bytes: int
    last_used_ts: float


# ───────── FastAPI app ─────────


app = FastAPI(title="gezel-mlx-server")


@app.on_event("shutdown")
def _on_shutdown() -> None:
    """uvicorn fires this on SIGTERM (graceful) before exiting.

    Persisting here means a clean supervisor stop preserves every warm
    session — the user comes back after lunch, the prefix loads from
    disk in <200ms instead of paying a full re-prefill.
    """
    _flush_all_to_disk()


# SIGTERM handler as a belt-and-braces complement to FastAPI's
# `on_event('shutdown')`. uvicorn's signal handling installs its own
# trap before ours, so the on_event hook is the primary path; this
# fallback runs only when uvicorn's handler doesn't reach the
# shutdown event (some kill scenarios race the handler installation).
def _sigterm_handler(_signum: int, _frame: Any) -> None:
    _flush_all_to_disk()
    # Re-raise default behavior — let uvicorn's own shutdown finish.
    sys.exit(0)


try:
    import signal as _signal

    _signal.signal(_signal.SIGTERM, _sigterm_handler)
except (ValueError, AttributeError):
    # `signal.signal` only works on the main thread; if we somehow
    # aren't there, on_event is still wired and that's the common path.
    pass


@app.get("/health")
async def health() -> JSONResponse:
    """Same shape mlx_vlm.server emits — keeps our supervisor probe happy."""
    return JSONResponse({"status": "ok"})


@app.post("/admin/flush")
async def admin_flush() -> JSONResponse:
    """Persist every in-memory cache entry to disk without dropping it.

    Called by the gezel supervisor's Stage-1 idle freeze: the user has
    been quiet long enough that we should defensively save state, but
    not so long that we want to evict the model from unified memory.
    If the user comes back during the freeze window the in-memory
    cache is still warm; if they DON'T come back and Stage 2 SIGTERMs
    the process, the freeze flush already wrote everything out so the
    next boot resumes cleanly.
    """
    saved = _flush_all_to_disk()
    return JSONResponse({"flushed": saved})


@app.get("/v1/cache/stats")
async def cache_stats() -> List[CacheStatsEntry]:
    """In-memory entries only.

    Intentionally excludes disk-only persisted entries — the controller
    polling this endpoint manages the in-memory budget against the
    in-engine LRU. Disk persistence is a separate, larger budget
    enforced internally by _enforce_disk_budget on each save. Surfacing
    disk entries here would force the controller to evict them as if
    they were live, defeating the persistence behavior.
    """
    return [
        CacheStatsEntry(
            cache_id=cid,
            token_count=len(entry.state.token_ids or []),
            est_bytes=entry.est_bytes,
            last_used_ts=entry.last_used_ts,
        )
        for cid, entry in _CACHE.items()
    ]


@app.delete("/v1/cache/{cache_id}")
async def cache_evict(cache_id: str) -> JSONResponse:
    """Drop an entry from both in-memory cache and disk persistence.

    Disk + memory in lockstep is intentional: a controller-driven evict
    means the operator (or an LRU policy) decided this session's cache
    is no longer useful. Leaving the disk entry behind would defeat
    the eviction (next access would re-load it). Deleting both is the
    "clean slate" the controller intends.
    """
    in_memory = cache_id in _CACHE
    if in_memory:
        del _CACHE[cache_id]
    on_disk = (
        cache_persist.delete_cache(PERSIST_DIR, MODEL_FINGERPRINT, cache_id)  # type: ignore[arg-type]
        if _disk_enabled()
        else False
    )
    if in_memory or on_disk:
        print(
            f"[cache] evicted cache_id={cache_id} (memory={in_memory} disk={on_disk})",
            flush=True,
        )
    return JSONResponse({"evicted": in_memory or on_disk, "cache_id": cache_id})


class CacheWarmRequest(BaseModel):
    cache_id: str
    messages: List[ChatMessageReq]
    model: Optional[str] = None
    # When True, write the warmed entry to disk immediately (don't wait
    # for eviction or shutdown). Used by the gezel-prefix warming flow
    # so subsequent sessions can load the prefix on miss without
    # depending on supervisor lifecycle. Default False matches the
    # session-warm semantics (in-memory only until evicted).
    persist: bool = False


@app.post("/v1/cache/warm")
async def cache_warm(req: CacheWarmRequest) -> JSONResponse:
    """Run prefill (+ 1 generated token) and save the resulting cache.

    Phase 4 hook — called by the gezel UI on session-open so the first
    real turn returns near-instantly. We use stream_generate with
    max_tokens=1 and discard the single generated token; the cache is
    populated by stream_generate's normal prefill path AND the
    post-loop `prompt_cache_state.update()` call only runs when the
    generator is fully exhausted. CRITICAL: if there's already a
    populated cache for this cache_id with a matching token prefix,
    the warm is a near-instant no-op (mlx-vlm reuses the cache and
    only prefills the suffix). If there's a populated cache but the
    prefix has *diverged*, we DON'T overwrite it — letting the next
    real chat-completions request handle the rebuild atomically. This
    avoids the failure mode where warming saves an empty/partial state
    that then misses on the next real send.

    Prefix warming (cache-adapter.ts warmPrefix) sends a system-only
    message list — but Qwen-family chat templates raise "No user query
    found in messages" when no user turn is present, which 500'd every
    warm and silently disabled pre-warming entirely. We append a minimal
    user turn so the template renders. The expensive system block is
    self-contained and renders identically regardless of what follows,
    so the warmed KV prefix still matches (and cache-hits) the real
    first turn, which diverges only after the system block.
    """
    warm_messages = req.messages
    if not any(m.role == "user" for m in warm_messages):
        warm_messages = list(warm_messages) + [
            ChatMessageReq(role="user", content="hi")
        ]
    prompt_text = _build_prompt(warm_messages)
    existing = _CACHE.get(req.cache_id)
    # Reuse the existing cache_state object if present so the
    # update() call mutates the same instance the dict already holds.
    # On in-memory miss, try disk — re-warming a prefix that's already
    # been persisted is a near-instant no-op (matching token_ids = no
    # new prefill) instead of paying the full system-prompt prefill
    # again. Without this, every supervisor restart's first warmPrefix
    # would re-pay the prefill cost on the same content.
    if existing is None:
        disk_state = _try_load_from_disk(req.cache_id)
        cache_state = disk_state if disk_state is not None else PromptCacheState()
    else:
        cache_state = existing.state
    prior_tokens = len(cache_state.token_ids or [])
    try:
        # Drain the generator fully — `max_tokens=1` makes it a
        # single-token cycle, but we MUST let stream_generate run to
        # completion (no early break!) because the
        # `prompt_cache_state.update(...)` call lives AFTER the inner
        # generation loop. Breaking early leaves the cache_state
        # unpopulated and corrupts any prior good entry.
        for _ in stream_generate(
            model=MODEL,
            processor=PROCESSOR,
            prompt=prompt_text,
            max_tokens=1,
            prompt_cache_state=cache_state,
            prefill_step_size=ARGS.prefill_step_size,
        ):
            pass
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))
    # Only commit if the cache state was actually populated. Belt-and-
    # braces against any path where update() didn't run.
    new_tokens = len(cache_state.token_ids or [])
    persisted = False
    if new_tokens > 0:
        _save_cache(req.cache_id, cache_state)
        # Prefix warming sets persist=True so the entry survives the next
        # supervisor stop and brand-new sessions can load it on first
        # request. Session warming leaves it in-memory only; the next
        # eviction will write through.
        if req.persist and _disk_enabled():
            persisted = cache_persist.save_cache(
                PERSIST_DIR, MODEL_FINGERPRINT, req.cache_id, cache_state  # type: ignore[arg-type]
            )
            _enforce_disk_budget()
        print(
            f"[cache] warmed cache_id={req.cache_id} tokens={new_tokens} "
            f"(prior={prior_tokens}, persist={persisted})",
            flush=True,
        )
    else:
        print(
            f"[cache] warm produced no tokens for cache_id={req.cache_id}; "
            f"leaving prior entry intact (prior={prior_tokens})",
            flush=True,
        )
    return JSONResponse(
        {
            "warmed": new_tokens > 0,
            "cache_id": req.cache_id,
            "token_count": new_tokens,
            "persisted": persisted,
        }
    )


def _build_prompt(
    messages: List[ChatMessageReq],
    tools: Optional[List[Dict[str, Any]]] = None,
    chat_template_override: Optional[str] = None,
) -> str:
    """Apply the model's chat template to OpenAI-shape messages.

    When `tools` is provided, route through the tokenizer's
    `apply_chat_template(..., tools=...)` directly. Qwen's tokenizer
    (and most tool-trained models) renders the tools list using the
    model's *canonical* tool-use template — this is what tells the
    model "use `<tool_call>{json}</tool_call>` envelopes" reliably.
    Without this, the tools array gets dropped on the floor and the
    model improvises a tool-call format from training memory.

    Failure handling peels off optional kwargs one at a time rather than
    silently abandoning `tools` on the first error: `enable_thinking` is
    a Qwen3-only kwarg, so a template that rejects it must NOT cost us the
    tool rendering. Dropping `tools` is the last resort and is logged
    loudly (it directly drives tool-call mangling, so it should surface in
    eval mechanism metrics rather than hide behind salvage).

    `chat_template_override`, when set, swaps the model's stored Jinja
    template for a curated one (per-family template fix) without
    reinstalling — used for the A/B and as an escape hatch for models
    with a known-bad embedded template.

    Vision support is out of scope for v1; list-shaped content is
    flattened to text by extracting text parts.
    """
    raw = []
    for m in messages:
        content = m.content
        if isinstance(content, list):
            parts = [p.get("text", "") for p in content if isinstance(p, dict)]
            content = "\n".join(p for p in parts if p)
        raw.append({"role": m.role, "content": content or ""})

    tokenizer = getattr(PROCESSOR, "tokenizer", None)
    use_tokenizer = (
        tokenizer is not None
        and hasattr(tokenizer, "apply_chat_template")
        and (bool(tools) or bool(chat_template_override))
    )
    if use_tokenizer:
        base_kwargs: Dict[str, Any] = dict(
            tools=tools,
            add_generation_prompt=True,
            tokenize=False,
        )
        if chat_template_override:
            base_kwargs["chat_template"] = chat_template_override
        # Attempt order, most-capable first:
        #   1. + enable_thinking  (Qwen3 reasoning forced inside <think>)
        #   2. - enable_thinking  (kwarg rejected by this template)
        #   3. - tools            (template can't render tools at all)
        try:
            return tokenizer.apply_chat_template(
                raw, enable_thinking=True, **base_kwargs
            )
        except (TypeError, ValueError) as exc_thinking:
            try:
                result = tokenizer.apply_chat_template(raw, **base_kwargs)
                print(
                    f"[tool-prompt] enable_thinking rejected by template; "
                    f"retried without it: {exc_thinking}",
                    flush=True,
                )
                return result
            except (TypeError, ValueError) as exc_tools:
                if tools:
                    print(
                        f"[tool-prompt] TOOLS DROPPED — apply_chat_template could "
                        f"not render {len(tools)} tool(s); model will not see the "
                        f"canonical tool template and may mangle calls: {exc_tools}",
                        flush=True,
                    )

    # No tools + no override, no tokenizer template, or tools-render
    # failed: text-only path. apply_chat_template signature varies across
    # mlx-vlm versions; the (processor, config, messages) form is stable.
    config = getattr(MODEL, "config", None) or {}
    return apply_chat_template(PROCESSOR, config, raw)


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(request: ChatRequest, http_request: Request):
    if request.stream is False:
        # Non-streaming path is rare from gezel's side; reject explicitly
        # rather than silently behaving differently.
        raise HTTPException(
            status_code=501,
            detail="gezel-mlx-server only supports streaming completions",
        )

    prompt_text = _build_prompt(
        request.messages, request.tools, request.chat_template_override
    )

    # Build the tool-call grammar logits processor once per request (the
    # llguidance tokenizer is cached across requests). Any failure returns
    # None — the turn then runs unconstrained + TS salvage, so this never
    # breaks a turn.
    tool_grammar_processor = None
    if request.tool_grammar:
        _grammar_tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        tool_grammar_processor = tool_grammar.build_tool_grammar_processor(
            _grammar_tok, request.tools, request.tool_grammar
        )

    # Look up or initialize cache state. Cascade:
    #   1. In-memory hit on cache_id           — best case, no I/O.
    #   2. Disk hit on cache_id                — supervisor restart or
    #                                            evicted entry, mmap load.
    #   3. Disk hit on prefix_cache_id         — new session inheriting a
    #                                            warmed gezel prefix.
    #   4. Fresh PromptCacheState              — full prefill required.
    cache_state, cache_source, matched_prefix = _resolve_cache_state(request)

    if cache_source == "memory":
        existing = len(cache_state.token_ids or [])
        print(
            f"[cache] hit cache_id={request.cache_id} prior_tokens={existing}",
            flush=True,
        )
    elif cache_source == "disk":
        existing = len(cache_state.token_ids or [])
        print(
            f"[cache] disk-hit cache_id={request.cache_id} prior_tokens={existing}",
            flush=True,
        )
    elif cache_source == "prefix":
        existing = len(cache_state.token_ids or [])
        print(
            f"[cache] prefix-hit cache_id={request.cache_id} "
            f"prefix={matched_prefix} prior_tokens={existing}",
            flush=True,
        )
    elif request.cache_id:
        print(f"[cache] miss cache_id={request.cache_id}", flush=True)

    # Pin this turn's session + seed-prefix entries from eviction for the life
    # of the request, so a concurrent save/evict can't drop the KV state this
    # turn is about to reuse out from under it (released in each stream
    # iterator's finally).
    pinned_cache_ids = _mark_inflight(request.cache_id, matched_prefix)
    prior_tokens = len(cache_state.token_ids or [])

    request_id = f"chatcmpl-{uuid.uuid4()}"

    # Batched path: with --max-concurrency > 1, multiplex this turn through
    # the shared BatchEngine (continuous batching) instead of the serial
    # stream_generate below. Everything above (prompt, grammar, cache
    # cascade) is reused as-is.
    if getattr(ARGS, "max_concurrency", 1) and ARGS.max_concurrency > 1:
        _engine = _get_batch_engine()
        _tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        prompt_tokens = [int(t) for t in _tok.encode(prompt_text)]
        sub = _Sub(
            request=request,
            prompt_tokens=prompt_tokens,
            grammar=tool_grammar_processor,
            seed_state=cache_state,
            request_id=request_id,
            http_request=http_request,
        )
        sub.pinned_cache_ids = pinned_cache_ids
        # New tokens this sub must prefill = full prompt minus the cached
        # prefix it can reuse. Drives the batched-prefill liveness marker.
        sub.prefill_total = max(0, len(prompt_tokens) - prior_tokens)
        try:
            _engine.submit(sub)
        except Exception:
            _unmark_inflight(pinned_cache_ids)
            raise
        return StreamingResponse(
            _batched_stream_iter(sub),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # IMPORTANT: this MUST be `async def`, not `def`. Starlette iterates
    # sync generators via `iterate_in_threadpool` which can hop threads
    # between yields — but MLX's GPU streams are thread-local, so any
    # `mx.synchronize` call from a different thread than the one that
    # created the stream raises `RuntimeError: There is no Stream(gpu, 0)
    # in current thread.` async generators get iterated directly in the
    # event-loop thread, which keeps the stream + generation co-located.
    # (The body remains synchronous beyond the `yield`s — `for chunk in
    # stream_generate(...)` blocks the event loop, same as upstream
    # mlx_vlm.server's pattern.)
    async def stream_iter():
        # Tracks whether the gezel client TCP-disconnected mid-stream
        # (turn timeout fired, user cancelled, etc.). When set, we
        # `break` out of `stream_generate` so MLX stops generating
        # tokens nobody will read — without this, uvicorn's underlying
        # ASGI write keeps failing per token and floods the supervisor
        # log with `socket.send() raised exception.` for the whole
        # remainder of the would-be response.
        client_gone = False
        try:
            generation_kwargs: Dict[str, Any] = {
                "prompt_cache_state": cache_state,
                "prefill_step_size": ARGS.prefill_step_size,
            }
            if request.max_tokens is not None:
                generation_kwargs["max_tokens"] = request.max_tokens
            if request.temperature is not None:
                generation_kwargs["temperature"] = request.temperature
            if request.top_p is not None:
                generation_kwargs["top_p"] = request.top_p
            if request.top_k is not None:
                generation_kwargs["top_k"] = request.top_k
            if request.repetition_penalty is not None:
                generation_kwargs["repetition_penalty"] = request.repetition_penalty
            if request.repetition_context_size is not None:
                generation_kwargs["repetition_context_size"] = (
                    request.repetition_context_size
                )
            if tool_grammar_processor is not None:
                # Forwarded through stream_generate(**kwargs) → generate_step,
                # which accepts `logits_processors`. Constrains the tool-call
                # function name to the known tools at sampling time.
                generation_kwargs["logits_processors"] = [tool_grammar_processor]

            output_text = ""
            last_chunk = None
            # Serialize generation across concurrent requests — see
            # `_GENERATION_LOCK` doc. Held only across the
            # `stream_generate` loop, NOT across cache lookup/save, so
            # request N+1 can prep its prefill state in parallel with
            # request N's streaming. The lock is fair (asyncio.Lock is
            # FIFO since Python 3.10) so a long generation can't starve
            # a queued short one indefinitely.
            async with _get_generation_lock():
                for chunk in stream_generate(
                    model=MODEL,
                    processor=PROCESSOR,
                    prompt=prompt_text,
                    **generation_kwargs,
                ):
                    if chunk is None or not hasattr(chunk, "text"):
                        continue
                    # Cooperative disconnect check. `is_disconnected()` is
                    # cheap (just peeks at the ASGI receive queue for an
                    # `http.disconnect` message) so doing it per token has
                    # no measurable overhead next to MLX's GPU work.
                    if await http_request.is_disconnected():
                        print(
                            f"[stream] client disconnected mid-generation "
                            f"after {getattr(chunk, 'generation_tokens', 0)} tokens; "
                            f"aborting",
                            flush=True,
                        )
                        client_gone = True
                        break
                    last_chunk = chunk
                    # Scrub leaked framing tokens per chunk. Special tokens
                    # finalize as their own detokenizer segment, so a marker
                    # never straddles two chunks — a per-chunk scrub is safe.
                    chunk_text = _scrub_leaked_markers(chunk.text)
                    if not chunk_text:
                        continue
                    output_text += chunk_text

                    payload = {
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": request.model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant", "content": chunk_text},
                                "finish_reason": None,
                            }
                        ],
                        "usage": {
                            "input_tokens": getattr(chunk, "prompt_tokens", 0),
                            "output_tokens": getattr(chunk, "generation_tokens", 0),
                            "total_tokens": (
                                getattr(chunk, "prompt_tokens", 0)
                                + getattr(chunk, "generation_tokens", 0)
                            ),
                            "prompt_tps": getattr(chunk, "prompt_tps", 0.0),
                            "generation_tps": getattr(chunk, "generation_tps", 0.0),
                            # Actual prefix reused by mlx-vlm after token
                            # comparison, not merely the size of the cache
                            # entry we found by id. This distinguishes a real
                            # hot continuation from a token-diverged cache
                            # that still has to re-prefill most of the prompt.
                            "cached_tokens": getattr(chunk, "cached_tokens", 0),
                        },
                    }
                    yield f"data: {json.dumps(payload)}\n\n"

            if client_gone:
                # Skip terminal + [DONE] frames — there's nobody to
                # receive them, and yielding through a closed transport
                # is what we're trying to avoid. Cache save in `finally`
                # still runs so the prefill we paid for isn't wasted.
                return

            # Terminal chunk with finish_reason. Mirrors the upstream
            # server's shape; gezel's MlxSession reads finish_reason
            # off the last chunk to decide truncation handling.
            terminal = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": request.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": ""},
                        "finish_reason": "stop",
                    }
                ],
            }
            if last_chunk is not None:
                prompt_tokens = getattr(last_chunk, "prompt_tokens", 0)
                cached_tokens = getattr(last_chunk, "cached_tokens", 0)
                terminal["usage"] = {
                    "input_tokens": prompt_tokens,
                    "output_tokens": getattr(last_chunk, "generation_tokens", 0),
                    "total_tokens": (
                        prompt_tokens
                        + getattr(last_chunk, "generation_tokens", 0)
                    ),
                    "prompt_tps": getattr(last_chunk, "prompt_tps", 0.0),
                    "generation_tps": getattr(last_chunk, "generation_tps", 0.0),
                    "cached_tokens": cached_tokens,
                }
                if request.cache_id:
                    print(
                        f"[cache] reuse cache_id={request.cache_id} "
                        f"cached_tokens={cached_tokens} "
                        f"prefilled_tokens={max(0, prompt_tokens - cached_tokens)}",
                        flush=True,
                    )
            yield f"data: {json.dumps(terminal)}\n\n"
            yield "data: [DONE]\n\n"

        except Exception as e:
            print(f"Error during stream generation: {e}", flush=True)
            traceback.print_exc()
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

        finally:
            # The cache `finally` decision:
            #   - cache_id set + state populated → save (the happy path)
            #   - cache_id set + state empty (e.g. mid-stream crash before
            #     stream_generate's update() ran) → DON'T save. Saving an
            #     empty entry would overwrite any prior good cache and
            #     guarantee the next turn misses + re-prefills full
            #   - no cache_id → upstream behavior (drop + clear memory)
            if request.cache_id:
                tokens = len(cache_state.token_ids or [])
                if tokens > 0:
                    _save_cache(request.cache_id, cache_state)
                    print(
                        f"[cache] saved cache_id={request.cache_id} tokens={tokens}",
                        flush=True,
                    )
                    # Seed the shared gezel+project prefix from this real
                    # session save so sibling sessions inherit [system+tools].
                    _seed_prefix_from_session(request, cache_state)
                else:
                    print(
                        f"[cache] generation produced no tokens for "
                        f"cache_id={request.cache_id}; leaving prior entry intact",
                        flush=True,
                    )
            else:
                mx.clear_cache()
                print("Stream finished, cleared cache.", flush=True)
            # Release the eviction pins taken for this turn — AFTER the save
            # above, so this turn's own _save_cache → _enforce_budget can't
            # evict the entry it just wrote.
            _unmark_inflight(pinned_cache_ids)

    return StreamingResponse(
        stream_iter(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # NOTE: mlx_vlm.server sets `Connection: keep-alive` here,
            # which our gezel daemon would have to strip when running
            # over HTTP/2. We're a separate process not on HTTP/2 so
            # the header is fine to send, but explicitly omit to keep
            # behavior predictable across transports.
            "X-Accel-Buffering": "no",
        },
    )


# ───────── Entry point ─────────

if __name__ == "__main__":
    import logging

    import uvicorn

    class _DropPollingAccessLogs(logging.Filter):
        # Supervisor polls /health and the gezel cache adapter polls
        # /v1/cache/stats every few seconds — at INFO that floods the
        # parent's [mlx]-prefixed logs. Drop only the 200s for those two
        # endpoints; anything else (4xx/5xx, other routes) still logs.
        _NOISY = ("/health", "/v1/cache/stats")

        def filter(self, record: logging.LogRecord) -> bool:
            args = record.args
            if not isinstance(args, tuple) or len(args) < 5:
                return True
            method, path, _http, status = args[1], args[2], args[3], args[4]
            return not (
                method == "GET" and status == 200 and path in self._NOISY
            )

    logging.getLogger("uvicorn.access").addFilter(_DropPollingAccessLogs())

    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="info")
