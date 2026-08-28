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
LRU eviction by total estimated bytes. The batched path plans its own
reuse via `cache_seed` (longest-common-prefix + protocol trim, plus an
end-of-prompt KV snapshot for windowed models whose rotated caches
can't rewind) — see cache_seed.py's module docstring for the why.

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
import think_budget  # noqa: E402
import cache_seed  # noqa: E402
import tool_grammar  # noqa: E402
import tool_call_stream  # noqa: E402
import template_stability  # noqa: E402
from lfm2_compat import ensure_lfm2_config_compat  # noqa: E402
from qwen3_5_text_compat import is_text_only_qwen3_5_checkpoint  # noqa: E402


# ───────── Leaked special-token scrub ─────────

# Chat-template framing tokens — turn / sequence / tool-response
# delimiters that tight quants (e.g. gemma4-e4b-q4) sometimes emit as
# literal special-token text. `tokenizer.decode()` keeps special tokens,
# so these render into the SSE content stream verbatim; wild-caught case
# was gemma4-e4b-q4 streaming `<eos><|tool_response><eos>` after firing
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


def _make_tool_stream(request_id: str, tools=None):
    """Build a splitter for this request, or None to keep the old behaviour.

    Returns None whenever the flag is off OR the model's chat template
    matches no mlx_vlm tool parser — in both cases the caller streams raw
    content and the gezel-side salvage path stays in charge. Never guess a
    marker pair: a wrong boundary would silently eat visible output.
    """
    if not getattr(ARGS, "stream_tool_calls", False):
        return None
    markers = tool_call_stream.resolve_tool_markers(PROCESSOR)
    if markers is None:
        return None
    start, end = markers
    return tool_call_stream.ToolCallStreamState(
        start_marker=start, end_marker=end, request_id=request_id, tools=tools
    )


def _tool_stream_fragments(state, chunk_text: str):
    """Fragments to emit for a chunk; empty when extraction is disabled."""
    if state is None:
        return []
    return state.feed(chunk_text)


def _tool_stream_payload(frag, request_id: str, model: str, chunk) -> Dict[str, Any]:
    """Wrap one fragment in the same chunk envelope the content path uses."""
    if frag.content is not None:
        delta: Dict[str, Any] = {"role": "assistant", "content": frag.content}
    else:
        call: Dict[str, Any] = {
            "index": frag.tool_call_index,
            "function": {"arguments": frag.arguments or ""},
        }
        if frag.tool_call_id is not None:
            call["id"] = frag.tool_call_id
            call["type"] = "function"
            # The grammar fixes the name inside the argument body, so the
            # name field stays empty rather than being guessed here; the
            # client's parser reads it from the arguments as it always has.
            call["function"]["name"] = frag.name or ""
        delta = {"role": "assistant", "tool_calls": [call]}
    return {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        "usage": {
            "input_tokens": getattr(chunk, "prompt_tokens", 0),
            "output_tokens": getattr(chunk, "generation_tokens", 0),
            "total_tokens": (
                getattr(chunk, "prompt_tokens", 0) + getattr(chunk, "generation_tokens", 0)
            ),
            "prompt_tps": getattr(chunk, "prompt_tps", 0.0),
            "generation_tps": getattr(chunk, "generation_tps", 0.0),
            "cached_tokens": getattr(chunk, "cached_tokens", 0),
        },
    }


def _scrub_leaked_markers(text: str) -> str:
    """Drop chat-template framing special-tokens that leaked as text."""
    if not text or "<" not in text:
        return text
    return _LEAKED_MARKER_RE.sub("", text)


def _generation_config_eos_ids(model_dir: str) -> "List[int]":
    """Read the stop-token set a model declares in generation_config.json.

    mlx's tokenizer wrapper doesn't always surface the full eos set the
    model author declared. gemma4-e4b-q4 is the wild-caught case: it
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
        "Max sequences to generate concurrently. Any positive value routes "
        "generation through a single mlx_lm BatchGenerator; 1 (default) is a "
        "singleton queue that still uses the cache-safe prompt-boundary "
        "snapshot path, while N>1 also enables continuous batching. Set 0 only "
        "for the legacy serial stream_generate fallback. Set from the TS "
        "provider's batchMaxConcurrency."
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
parser.add_argument(
    "--wired-limit-mb",
    type=int,
    default=0,
    help=(
        "How much this engine may PIN (MB) — the planned resident set: weights "
        "plus the KV its slots will hold. Deliberately NOT the same number as "
        "--gpu-memory-limit-mb: that is a ceiling on what may be USED, while "
        "wired pages are unreclaimable by the OS, so wiring the whole share "
        "starves the machine (a 27B wired 96 GiB for a ~45 GB working set and "
        "left 155 MB free on a 128 GB Mac). 0 (default) = leave the wired "
        "limit alone."
    ),
)
parser.add_argument(
    "--stream-tool-calls",
    action="store_true",
    help=(
        "Emit OpenAI-shaped `tool_calls` argument deltas instead of streaming "
        "the model's tool markup as content. OFF by default: the gezel-side "
        "salvage path stays the fallback for models whose chat template "
        "matches no mlx_vlm tool parser. On, the client gets a real tool-call "
        "boundary and can end a turn once the call is usable — the same lever "
        "llama-server gives us, and the reason MLX turns otherwise run to "
        "completion (measured 41 turns at a 136s median, 203 min/10 trials)."
    ),
)
parser.add_argument(
    "--kv-bits",
    type=int,
    default=0,
    help=(
        "Quantize the KV cache to this many bits. 0 (default) = f16. Halves "
        "(8-bit) or quarters (4-bit) the largest term in a long-context "
        "session: a 256K window on a 16-full-attention-layer 27B is 16 GiB of "
        "f16 KV. Applies to the SERIAL generation path only — mlx-lm's "
        "BatchGenerator builds BatchKVCache layers, which have no "
        "`to_quantized`, and `maybe_quantize_kv_cache` skips them silently. "
        "The launcher therefore plans memory at f16 whenever batching is on, "
        "so the broker never reserves a discount the engine did not take."
    ),
)
parser.add_argument(
    "--kv-group-size",
    type=int,
    default=64,
    help="Group size for KV quantization. mlx-lm's default is 64.",
)
parser.add_argument(
    "--kv-quant-scheme",
    default="uniform",
    help=(
        "Quantization scheme passed to mlx-vlm. 'uniform' is right for integer "
        "bit values; mlx-vlm selects TurboQuant for fractional ones."
    ),
)
parser.add_argument(
    "--quantized-kv-start",
    type=int,
    default=0,
    help=(
        "Only quantize a layer once its cache passes this many tokens. Leaves "
        "short turns on the f16 path, where quantization costs more than the "
        "memory it saves."
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
_LFM2_FF_DIM = ensure_lfm2_config_compat(ARGS.model)
if _LFM2_FF_DIM is not None:
    print(f"Applied lfm2 config compat: block_ff_dim={_LFM2_FF_DIM}", flush=True)
_QWEN3_5_TEXT_ONLY = is_text_only_qwen3_5_checkpoint(ARGS.model)
if _QWEN3_5_TEXT_ONLY:
    print(
        "Detected text-only Qwen 3.5 checkpoint; allowing absent vision-tower weights.",
        flush=True,
    )

# ── Tower selection (2026-08-28) ──
#
# This server has always served TEXT ONLY ("Vision support is out of scope
# for v1" — _build_prompt): mlx_vlm here is a loader, not a vision path.
# Yet mlx_vlm's language towers pay a large context-growing decode tax
# under the BatchGenerator this server runs on. Measured on
# qwen3.8-27b-q4 (matched-thermal 2x2, ms per decoded token at
# 10.9k/54.3k prompt tokens):
#
#     mlx_lm tower  x BatchGenerator : 32.1 / 41.2   (= bare serial)
#     mlx_vlm tower x BatchGenerator : 44.7 / 86.7   (slope 0.97 vs 0.34 us/tok)
#
# The vlm tower runs 3-axis multimodal RoPE with per-layer array-offset
# position ids + left-padding mask machinery per token; mlx_lm's text
# tower is plain rope(offset) + fused SDPA. Same checkpoint, ~2x decode
# at working context — so batch mode loads the mlx_lm tower when it can.
#
# Scope guards, deliberately conservative:
#   - allow-listed architectures only (verified by the 2x2 above); other
#     archs keep the vlm loader until they get their own measurement,
#   - batch mode only (--max-concurrency >= 1, the default): the legacy
#     serial path is mlx_vlm's stream_generate and keeps the vlm loader,
#   - GEZEL_MLX_TEXT_TOWER=off restores the old behavior outright;
#     =force skips the allowlist (measurement runs).
# Every branch prints a `[tower]` fingerprint line — an A/B that cannot
# prove which tower served it is how this class of defect stayed hidden.
_TEXT_TOWER = None
_TEXT_TOWER_ALLOWED_ARCHS = {"qwen3_5"}


def _model_architecture(model_dir: str) -> str:
    try:
        with open(os.path.join(model_dir, "config.json"), "r") as fh:
            return str(json.load(fh).get("model_type", ""))
    except Exception:
        return ""


_tower_pref = os.environ.get("GEZEL_MLX_TEXT_TOWER", "auto").strip().lower()
_arch = _model_architecture(ARGS.model)
if (
    _tower_pref not in ("0", "off", "false")
    and int(getattr(ARGS, "max_concurrency", 1) or 0) >= 1
    and (_tower_pref == "force" or _arch in _TEXT_TOWER_ALLOWED_ARCHS)
):
    try:
        from mlx_lm.utils import load as _mlx_lm_load

        MODEL, PROCESSOR = _mlx_lm_load(ARGS.model)
        _TEXT_TOWER = "mlx_lm"
        print(
            f"[tower] active=mlx_lm arch={_arch or 'unknown'} "
            f"(text tower; vlm loader bypassed for batch serving)",
            flush=True,
        )
    except Exception as exc:
        print(
            f"[tower] mlx_lm load failed for arch={_arch or 'unknown'}: {exc} "
            f"— falling back to mlx_vlm",
            flush=True,
        )
if _TEXT_TOWER is None:
    MODEL, PROCESSOR = load(ARGS.model, strict=not _QWEN3_5_TEXT_ONLY)
    _reason = (
        "GEZEL_MLX_TEXT_TOWER=off"
        if _tower_pref in ("0", "off", "false")
        else "serial mode (--max-concurrency 0)"
        if int(getattr(ARGS, "max_concurrency", 1) or 0) < 1
        else f"arch {_arch or 'unknown'} not in text-tower allowlist"
        if _tower_pref != "force"
        else "mlx_lm load failed"
    )
    print(f"[tower] active=mlx_vlm ({_reason})", flush=True)
print("Model and processor loaded successfully.", flush=True)


# Prefix-stability work (template relocation + reasoning-stable snapshot
# boundaries), OFF by default. Wired, unit-tested, and demonstrably firing —
# a single turn reused 6,980 tokens against 165 prefilled — but the paired
# arms measured it as a REGRESSION on its own metric:
#
#   reuse%   34 (off) -> 26 -> 22 -> 14 (all fixes on)
#   prefill/trial 37,486 (off) -> 43,586 (on)
#
# Truncating saves at the stable boundary buys matches but shrinks what each
# match is worth, and warming with tools raises the prefill denominator. Net
# negative at n=1-5 with ~3x trial spread, so it is neither shippable nor
# disproven. Same posture as GEZEL_LAYERED_PREFIX_CACHE: keep it measurable.
_STABLE_PREFIX_ENABLED = os.environ.get("GEZEL_MLX_STABLE_PREFIX") in ("1", "true")


def _resolve_stable_chat_template() -> Optional[str]:
    """Relocate the reasoning preamble below the cache-stable content.

    Qwen 3.5+ templates put the reasoning-effort line ABOVE the tool block,
    so flipping reasoning mode between turns — which the constrained-write
    path does deliberately — changed the prompt from token 3 onward and
    re-prefilled the entire tool block every time. Measured on
    qwen3.8-27b-q4: 3 shared tokens before, 2,921 after.

    Verified before adoption and abandoned on any doubt: a mis-rendered
    prompt is far worse than a cold cache.
    """
    if not _STABLE_PREFIX_ENABLED:
        return None
    tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
    original = getattr(tok, "chat_template", None)
    if not isinstance(original, str) or not original:
        return None
    patched = template_stability.relocate_reasoning_preamble(original)
    if patched is None:
        print("[template] preamble relocation not applicable to this template", flush=True)
        return None
    probe_messages = [
        {"role": "system", "content": "Your role is Builder.\n\n" + ("about text. " * 64)},
        {"role": "user", "content": "hi"},
    ]
    probe_tools = [
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write a file to the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                },
            },
        }
    ]

    def _render(template: str, kwargs: Dict[str, Any]) -> str:
        return tok.apply_chat_template(
            probe_messages,
            tools=probe_tools,
            add_generation_prompt=True,
            tokenize=False,
            chat_template=template,
            **kwargs,
        )

    try:
        ok, reason = template_stability.verify_prefix_stability(
            _render, tok.encode, patched, original
        )
    except Exception as exc:  # noqa: BLE001 — verification must never block boot
        print(f"[template] preamble relocation verification errored: {exc}", flush=True)
        return None
    if not ok:
        print(f"[template] preamble relocation REJECTED: {reason}", flush=True)
        return None
    print(f"[template] preamble relocated for prefix stability — {reason}", flush=True)
    return patched


STABLE_CHAT_TEMPLATE = _resolve_stable_chat_template()


# ───────── GPU memory ceiling (Metal) ─────────
# Effective ceiling on total unified-memory this engine may use — weights + KV
# + compute. The batch admission path (BatchEngine._admit_count) reads live
# usage against it to decide how many concurrent prefills to start, so a wave
# never piles KV past the point where a Metal command-buffer allocation aborts
# the whole python process. 0 = unset (no ceiling → admit on width alone).
_MEM_LIMIT_BYTES = 0
# The resident-set target supplied by the TS capacity broker. Keep this
# separately from the allocation ceiling: mlx_lm's BatchGenerator currently
# overwrites the process wired limit with Metal's full recommended working set
# during construction, so the Gezel policy must be reapplied afterwards.
_WIRED_LIMIT_BYTES = 0
# MLX keeps freed Metal buffers for reuse in a process-global cache. That is
# useful, but an unbounded pool made a ~62 GB working set retain another
# ~45 GB until mlx_lm's coarse 512-step clear, producing a 65 -> 120 GB
# sawtooth. This cap is intentionally distinct from the prompt/KV cache budget.
_MLX_BUFFER_CACHE_LIMIT_BYTES = 0
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


def _safe_cache_memory() -> int:
    """MLX's retained free-buffer pool in bytes, or 0 if unavailable.

    Distinct from active memory and invisible to it: MLX holds freed buffers
    for reuse rather than returning them, so a process can sit far above its
    live allocation without `get_active_memory` moving. That gap is most of
    the difference between a model's working set and its physical footprint.
    """
    try:
        return int(mx.get_cache_memory())
    except Exception:  # noqa: BLE001 — introspection is best-effort
        return 0


def _safe_peak_memory() -> int:
    """Peak MLX allocation in bytes, or 0 if unavailable."""
    try:
        return int(mx.get_peak_memory())
    except Exception:  # noqa: BLE001 — introspection is best-effort
        return 0


def _log_memory(phase: str, cache_before: Optional[int] = None) -> None:
    """One line of memory truth per turn.

    Nothing observed this engine between startup and the next restart, so a
    footprint drifting toward the wired ceiling was only ever reconstructible
    afterwards from `vm_stat`. `cache` is the number that made the difference
    invisible: it does not move `active`, and no other layer measures it —
    the in-engine prompt-cache budget tracks its own token-count estimate.
    """
    active = _safe_active_memory()
    cached = _safe_cache_memory()
    peak = _safe_peak_memory()
    if active <= 0 and cached <= 0:
        return
    mb = 1024 * 1024
    ceiling = f", ceiling={_MEM_LIMIT_BYTES // mb}MB" if _MEM_LIMIT_BYTES > 0 else ""
    wired = f", wired_limit={_WIRED_LIMIT_BYTES // mb}MB" if _WIRED_LIMIT_BYTES > 0 else ""
    cache_limit = (
        f", cache_limit={_MLX_BUFFER_CACHE_LIMIT_BYTES // mb}MB"
        if _MLX_BUFFER_CACHE_LIMIT_BYTES > 0
        else ""
    )
    peak_text = f" peak={peak // mb}MB" if peak > 0 else ""
    reclaimed_text = (
        f" cache_before={cache_before // mb}MB"
        if cache_before is not None and cache_before > cached
        else ""
    )
    print(
        f"[mem] {phase}: active={active // mb}MB cache={cached // mb}MB "
        f"total={(active + cached) // mb}MB{peak_text}{reclaimed_text}"
        f"{ceiling}{wired}{cache_limit}",
        flush=True,
    )


def _apply_mlx_memory_policy(phase: str) -> None:
    """Apply Gezel's process-wide MLX memory policy.

    This is deliberately idempotent. In particular it is called immediately
    after BatchGenerator construction because mlx_lm resets the wired limit in
    its constructor. Every MLX call is guarded for older sidecar runtimes.
    """
    if _WIRED_LIMIT_BYTES > 0:
        set_wired = getattr(mx, "set_wired_limit", None)
        if set_wired is not None:
            try:
                set_wired(_WIRED_LIMIT_BYTES)
            except Exception as exc:  # noqa: BLE001
                print(f"[mem] {phase} set_wired_limit skipped: {exc}", flush=True)
    if _MLX_BUFFER_CACHE_LIMIT_BYTES > 0:
        set_cache = getattr(mx, "set_cache_limit", None)
        if set_cache is not None:
            try:
                set_cache(_MLX_BUFFER_CACHE_LIMIT_BYTES)
            except Exception as exc:  # noqa: BLE001
                print(f"[mem] {phase} set_cache_limit skipped: {exc}", flush=True)


def _reclaim_mlx_buffer_cache(
    phase: str, force: bool = False, log: bool = False
) -> bool:
    """Release MLX's free-buffer pool at a safe boundary or under pressure.

    Active allocations (model weights and live KV state) are untouched.
    `force` is used once a batch turn is fully drained; during generation we
    clear only when total MLX memory crosses the admission threshold or the
    runtime has temporarily exceeded the configured free-buffer cap.
    """
    active = _safe_active_memory()
    cached = _safe_cache_memory()
    under_pressure = (
        _MEM_LIMIT_BYTES > 0
        and active + cached >= _MEM_LIMIT_BYTES * _MEM_ADMIT_FRACTION
    )
    over_cache_limit = (
        _MLX_BUFFER_CACHE_LIMIT_BYTES > 0
        and cached > _MLX_BUFFER_CACHE_LIMIT_BYTES
    )
    reclaimed = False
    if force or under_pressure or over_cache_limit:
        clear_cache = getattr(mx, "clear_cache", None)
        if clear_cache is not None:
            try:
                clear_cache()
                reclaimed = True
            except Exception as exc:  # noqa: BLE001
                print(f"[mem] {phase} clear_cache skipped: {exc}", flush=True)
    # Turn boundaries and actual pressure events are useful telemetry. A
    # healthy periodic probe should stay silent instead of writing one line
    # every 32 decode steps.
    if log or force or under_pressure or over_cache_limit:
        _log_memory(phase, cache_before=cached if reclaimed else None)
    return reclaimed


def _setup_gpu_memory_ceiling() -> None:
    """Resolve the effective memory ceiling and the wired limit.

    The ceiling is the smaller of what the supervisor budgeted for this model
    (`--gpu-memory-limit-mb`, from the TS capacity broker) and what Metal
    recommends as a working set — whichever is tighter is the honest bound.
    Everything here is guarded: a version whose mlx lacks these calls must
    degrade to "no ceiling" (width-only admission), never crash startup.

    The WIRED limit is a separate, smaller number (`--wired-limit-mb`): the
    planned resident set. Wiring the whole ceiling is what let a 27B hold
    ~103 GB for a ~45 GB working set — wired pages never come back under
    pressure, so this must track what steady-state inference actually needs
    resident, not what the engine is allowed to allocate. Falls back to the
    ceiling only when the supervisor passed no plan (unreadable geometry).
    """
    global _MEM_LIMIT_BYTES, _WIRED_LIMIT_BYTES, _MLX_BUFFER_CACHE_LIMIT_BYTES
    recommended = _metal_recommended_working_set()
    arg_limit = max(0, int(getattr(ARGS, "gpu_memory_limit_mb", 0) or 0)) * 1024 * 1024
    candidates = [b for b in (recommended, arg_limit) if b > 0]
    _MEM_LIMIT_BYTES = min(candidates) if candidates else 0
    planned = max(0, int(getattr(ARGS, "wired_limit_mb", 0) or 0)) * 1024 * 1024
    _WIRED_LIMIT_BYTES = (
        min(planned, _MEM_LIMIT_BYTES)
        if planned > 0 and _MEM_LIMIT_BYTES > 0
        else planned or _MEM_LIMIT_BYTES
    )
    # Retain a small amount of free Metal storage for fast reuse, scaled to
    # the planned working set but never allowed to become a second model-sized
    # pool. Current 27B geometry resolves to just under 4 GB.
    cache_scale = _WIRED_LIMIT_BYTES or _MEM_LIMIT_BYTES
    if cache_scale > 0:
        _MLX_BUFFER_CACHE_LIMIT_BYTES = max(
            256 * 1024 * 1024,
            min(4 * 1024 * 1024 * 1024, cache_scale // 16),
        )
    else:
        _MLX_BUFFER_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024
    _apply_mlx_memory_policy("startup")
    print(
        f"[mem] gpu ceiling={_MEM_LIMIT_BYTES // (1024 * 1024)}MB "
        f"(budget={arg_limit // (1024 * 1024)}MB, "
        f"metal_recommended={recommended // (1024 * 1024)}MB, "
        f"wired={_WIRED_LIMIT_BYTES // (1024 * 1024)}MB, "
        f"buffer_cache_limit={_MLX_BUFFER_CACHE_LIMIT_BYTES // (1024 * 1024)}MB, "
        f"active={_safe_active_memory() // (1024 * 1024)}MB)",
        flush=True,
    )
    # Model loading happened before this policy was known. Drop any free
    # compilation/loading buffers it left behind so the first turn starts from
    # the same bounded baseline as every later turn.
    _reclaim_mlx_buffer_cache("startup-ready", force=True)


_setup_gpu_memory_ceiling()


def _augment_serial_stop_set(processor, model_dir: str) -> None:
    """Merge generation_config.json's eos ids into the serial-path stop set.

    The serial (non-batch) stream path stops on
    `tokenizer.stopping_criteria.eos_token_ids`, seeded at load from the
    tokenizer's own (sometimes narrower) eos set — the same gap that let
    gemma4-e4b-q4 stream `<eos>` / `<|tool_response>` as text. We append
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


def _kv_quant_kwargs() -> Dict[str, Any]:
    """KV-quantization options for the serial `stream_generate` path.

    Forwarded through `stream_generate(**kwargs)` into mlx-vlm's
    `generate_step`, which converts each layer via `to_quantized` once it
    passes `quantized_kv_start`. Layer classes without that method
    (BatchKVCache, ChunkedKVCache) are skipped by `maybe_quantize_kv_cache`
    rather than raising — safe, but silent, which is why the launcher plans
    f16 whenever the batched path is in use instead of trusting this flag.

    Empty when disabled, so the default path is byte-identical to before.
    """
    if ARGS.kv_bits <= 0:
        return {}
    return {
        "kv_bits": ARGS.kv_bits,
        "kv_group_size": ARGS.kv_group_size,
        "kv_quant_scheme": ARGS.kv_quant_scheme,
        "quantized_kv_start": ARGS.quantized_kv_start,
    }


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


# ───────── BatchGenerator engine (--max-concurrency >= 1) ─────────
#
# Any positive concurrency routes through BatchEngine instead of the legacy
# serial `stream_generate` + _GENERATION_LOCK path. At N=1 this is still a
# singleton queue, but it matters for correctness/performance: BatchGenerator
# exposes prompt-segment boundaries, which lets windowed Qwen/Gemma caches save
# a coherent prompt snapshot instead of cold-prefilling after every tool-loop
# turn. At N>1 the same engine also continuously batches independent sequences.
# One asyncio worker drives the generator on the event-loop thread — MLX GPU
# streams are thread-local (see the chat_completions note). Every per-session
# concern maps to a per-sequence list in the BatchGenerator API (sampler, logits
# processors incl. the tool grammar, seed KV cache, max_tokens); on finish we
# extract the sequence's KV and persist it via the SAME _save_cache /
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

# Keep chunk-edge snapshots this many tokens clear of the prompt's end.
# The final tokens (`…<start_of_turn>model\n`) re-merge differently once
# the next turn's text continues past them (BPE boundary instability), so
# a snapshot cut too close to the end misses by a couple of tokens — and
# wrapped rotating layers can't trim even that. 16 is generous; the cost
# is at most 16 re-prefilled tokens per turn.
_SNAPSHOT_BOUNDARY_MARGIN = 16


class _Sub:
    """One in-flight batched request: its decode queue, accumulated tokens,
    and the bits needed to build its sequence + persist its KV on finish."""

    __slots__ = (
        "request", "prompt_tokens", "grammar", "seed_state", "request_id",
        "http_request", "uid", "queue", "cancelled", "token_ids", "emitted",
        "pinned_cache_ids", "prefill_total", "first_token_seen",
        "reused_tokens", "seed_mode", "prompt_snapshot", "snapshot_target",
        "saved_cache_state", "prefill_started_at", "generation_started_at",
        "prompt_tps", "generation_tps",
    )

    def __init__(
        self,
        request,
        prompt_tokens,
        grammar,
        seed_state,
        request_id,
        http_request,
        snapshot_target=None,
    ):
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
        self.reused_tokens = 0               # cache tokens actually served (seed plan)
        self.seed_mode = "fresh"             # seed decision, for logs/diagnosis
        # End-of-prompt KV snapshot (windowed models only) — captured at
        # first token, before any generated token enters the cache, so
        # the saved session entry stays a pure prefix of the next turn's
        # re-templated prompt. See cache_seed.probe_needs_prompt_snapshot.
        self.prompt_snapshot = None
        # Absolute token boundary to capture. Normal turns default to
        # len(prompt)-margin at admission; prefix warming supplies the stable
        # boundary found by comparing two different synthetic user turns.
        self.snapshot_target = snapshot_target
        # The exact state committed at finish. Cache warming uses this direct
        # reference for immediate persistence even if the memory-budget pass
        # evicts the just-built entry from the global LRU.
        self.saved_cache_state = None
        # BatchGenerator does not expose per-sequence timing. Track wall-clock
        # timing per subscription so the OpenAI-compatible usage frames retain
        # the same prompt/decode speed fields as the serial stream_generate
        # path. Values are snapshotted into queue items because the worker can
        # advance again before the SSE coroutine consumes them.
        self.prefill_started_at = None
        self.generation_started_at = None
        self.prompt_tps = 0.0
        self.generation_tps = 0.0


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
        # mlx_lm BatchGenerator sets the wired limit to Metal's entire
        # recommended working set in its constructor. Restore the smaller
        # resident-set plan and free-buffer cap selected by Gezel.
        _apply_mlx_memory_policy("batch-init")
        self._subs = {}            # uid -> _Sub
        self._pending = []         # _Sub awaiting insert
        self._wake = asyncio.Event()
        self._worker = None
        # Windowed / state-cache models can't rewind their caches once
        # the sequence outgrows the window, so a post-generation save is
        # dead weight the moment history diverges from the raw tokens
        # (reasoning stripping guarantees it does). For those models we
        # capture an end-of-prompt KV snapshot per turn instead — see
        # _maybe_snapshot_prompt_cache. Full-attention stacks skip the
        # copy; LCP+trim covers them.
        self._needs_snapshot = cache_seed.probe_needs_prompt_snapshot(model)
        self._snapshot_warned = False
        # Prefill-liveness for the current wave. The batched path prefills the
        # whole prompt inside BatchGenerator with NO tqdm bar (unlike the
        # serial mlx_vlm path), so the TS watchdog saw zero prefill events and
        # the engine looked silent through a long first-token wait (the
        # qwen3.6-27b 37K-token stall). We emit a `Prefill:`-shaped marker the
        # stdout-parser already understands so the watchdog knows the engine is
        # alive + prefilling N tokens, and the UI pill shows it.
        self._prefill_total = 0      # new tokens the active wave is prefilling
        self._prefill_done = {}      # uid → tokens prefilled so far (this wave)
        self._last_prefill_emit = 0.0
        self._memory_check_steps = 0
        print(
            f"[batch] engine ready max_concurrency={self._max} "
            f"stop_tokens={len(stop_tokens)} (+{len(eos_from_cfg)} from generation_config"
            f"{f', +{len(tool_close)} </tool_call>' if tool_close else ''}) "
            f"prompt_snapshot={'y' if self._needs_snapshot else 'n'}",
            flush=True,
        )

    def submit(self, sub):
        if self._worker is None:
            self._worker = asyncio.ensure_future(self._run())
        self._pending.append(sub)
        self._wake.set()

    def is_idle(self):
        """True once no live or queued batch sub can still use scratch buffers."""
        return not self._subs and not self._pending

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
            # Accepts a single processor or a list (grammar + think-budget).
            procs = list(procs) + (grammar if isinstance(grammar, list) else [grammar])
        # BatchGenerator receives one processor list per sequence. A mixed
        # wave (for example cache warm + pi tool call) must use [] for the
        # unconstrained sequence: mlx_lm iterates every per-sequence entry and
        # crashes on None with "'NoneType' object is not iterable".
        return list(procs or [])

    def _seed_args(self, sub):
        """Plan cache reuse for this sub: longest-common-prefix with
        trim-to-prefix, mirroring the serial path's semantics (the old
        exact-prefix-only check re-prefilled entire 20K-token sessions
        whenever one stripped reasoning character diverged the history
        from the raw tokens). Delegates to cache_seed.seed_from_state;
        stamps the authoritative prefill/reuse counts on the sub so the
        liveness marker and usage frames report engine reality, and logs
        the decision — the line to grep when turns re-prefill."""
        plan = cache_seed.seed_from_state(sub.seed_state, sub.prompt_tokens)
        sub.prefill_total = len(plan.segment)
        sub.reused_tokens = plan.reused
        sub.seed_mode = plan.mode
        if sub.request.cache_id:
            print(
                f"[batch] seed cache_id={sub.request.cache_id} mode={plan.mode} "
                f"reused={plan.reused} prefill={len(plan.segment)}",
                flush=True,
            )
            if plan.mode == "fresh-untrimmable" and plan.cached_len:
                # Name the churn instead of leaving it to inference. Two
                # rounds of this investigation guessed the cause from cache
                # SIZES (which say what was available, not what matched) and
                # both guesses were wrong; decoding the two sides at the
                # divergence point is the only thing that identifies it.
                try:
                    _tk = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
                    _cached = list(getattr(sub.seed_state, "token_ids", None) or [])
                    _lo = max(0, plan.lcp - 6)
                    print(
                        f"[batch] churn cache_id={sub.request.cache_id} "
                        f"at={plan.lcp} "
                        f"cached={_tk.decode(_cached[_lo:plan.lcp + 24])!r} "
                        f"prompt={_tk.decode(list(sub.prompt_tokens)[_lo:plan.lcp + 24])!r}",
                        flush=True,
                    )
                except Exception as exc:  # noqa: BLE001 — diagnostics never break a turn
                    print(f"[batch] churn preview unavailable: {exc}", flush=True)
            if plan.mode == "fresh-untrimmable":
                # lcp/cached is the diagnostic pair: lcp near 0 means the
                # prompt churned early (fix the prompt), lcp near cached
                # means the snapshot boundary was cut past the stable
                # region (fix the boundary). Same symptom, opposite fixes.
                print(
                    f"[batch] WARNING full prefill: cache_id={sub.request.cache_id} "
                    f"had divergent untrimmable state without a reusable prompt "
                    f"snapshot (tokens={len(plan.segment)} lcp={plan.lcp} "
                    f"cached={plan.cached_len} "
                    f"lcp_frac={plan.lcp / plan.cached_len:.2f})"
                    if plan.cached_len
                    else f"[batch] WARNING full prefill: cache_id={sub.request.cache_id} "
                    f"had divergent untrimmable state (tokens={len(plan.segment)})",
                    flush=True,
                )
        return plan.segment, plan.caches, plan.all_tokens

    def _snapshot_segments(self, sub, segment):
        """Plant exactly one per-sequence segment edge for KV extraction.

        BatchGenerator reports every prefill chunk as a prompt response. The
        old handler copied the growing cache at *every* chunk and kept only the
        last copy. Long prompts therefore paid dozens of large, discarded KV
        copies. A dedicated target makes capture one-shot and also works for
        unequal-length multi-sequence waves: mlx_lm finalizes each chunk's
        right-padding before returning, then extract_cache(uid) removes that
        sequence's left-padding.
        """
        if not self._needs_snapshot or not sub.request.cache_id:
            return [segment]
        plan = cache_seed.plan_snapshot_segments(
            segment,
            sub.reused_tokens,
            len(sub.prompt_tokens),
            sub.snapshot_target,
            _SNAPSHOT_BOUNDARY_MARGIN,
        )
        sub.snapshot_target = plan.target
        return plan.segments

    def _emit_prefill_liveness(self) -> None:
        """While the active wave is still prefilling (no token emitted yet),
        print a `Prefill:` line the supervisor's stdout-parser turns into a
        `prefill` phase event — keeping the TS pre-first-byte watchdog anchored
        on real engine liveness instead of tripping its silent-cold-start
        bound. Honest by construction: it only fires while `_prefill_total > 0`
        (cleared the instant the first token lands), and only from the live
        worker loop — a genuinely wedged engine emits nothing and still trips.

        Progress is real: the worker consumes `BatchGenerator.next()` per
        internal step, so each prompt chunk reports its (processed, total)
        and the marker carries an actual percentage instead of a constant
        0%."""
        total = self._prefill_total
        if total < _PREFILL_LIVENESS_MIN_TOKENS:
            return
        now = time.time()
        if now - self._last_prefill_emit < _PREFILL_LIVENESS_INTERVAL_S:
            return
        self._last_prefill_emit = now
        done = min(total, sum(self._prefill_done.values()))
        pct = min(99, (100 * done) // total) if total > 0 else 0
        # Format MUST match stdout-parser's Prefill regex:
        #   Prefill:  42%|   | 8192/<total> [batched]
        print(f"Prefill: {pct:3d}%|          | {done}/{total} [batched]", flush=True)

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
            _reclaim_mlx_buffer_cache("batch-admission", force=True)
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
                segments, caches, alltoks, samplers, lps, maxtoks = [], [], [], [], [], []
                for sub in batch:
                    seg, c, at = self._seed_args(sub)
                    segments.append(self._snapshot_segments(sub, seg))
                    caches.append(c)
                    alltoks.append(at)
                    samplers.append(self._sampler_for(sub.request))
                    lps.append(self._processors_for(sub.request, sub.grammar))
                    maxtoks.append(int(sub.request.max_tokens) if sub.request.max_tokens else 2048)
                try:
                    uids = self._gen.insert_segments(
                        segments=segments,
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
                    sub.prefill_started_at = time.perf_counter()
                    self._subs[uid] = sub
                # Arm prefill-liveness for the wave: total new tokens to
                # prefill across its subs (authoritative — from the seed
                # plans above). Reset the throttle so the first marker
                # emits immediately (before the blocking decode below).
                self._prefill_total = sum(
                    max(0, int(getattr(s, "prefill_total", 0))) for s in batch
                )
                self._prefill_done = {}
                self._last_prefill_emit = 0.0

            # One engine step across all active sequences. `next()` (not
            # `next_generated()`) so control returns after EVERY internal
            # step — prompt chunks included. That is what makes the
            # end-of-prompt snapshot capturable at its exact boundary
            # (see _capture_prompt_snapshot), gives the liveness marker
            # real per-chunk progress instead of a constant 0%, and lets
            # the event loop breathe between prefill chunks.
            if self._subs:
                # Emit a prefill marker before the (potentially long, event-
                # loop-blocking) step so the watchdog sees liveness.
                # No-op once the first token lands (_prefill_total → 0).
                self._emit_prefill_liveness()
                try:
                    prompt_responses, responses = self._gen.next()
                    step_ended_at = time.perf_counter()
                except Exception as exc:  # noqa: BLE001
                    print(f"[batch] step failed: {exc}", flush=True)
                    traceback.print_exc()
                    for sub in list(self._subs.values()):
                        sub.queue.put_nowait(("err", str(exc)))
                    self._subs.clear()
                    continue
                # set_cache_limit bounds future reuse, while this periodic
                # pressure check also catches temporary overshoot during a
                # long prefill/decode. It replaces reliance on mlx_lm's much
                # coarser 512-generation-step cache clear.
                self._memory_check_steps += 1
                if self._memory_check_steps >= 32:
                    self._memory_check_steps = 0
                    _reclaim_mlx_buffer_cache("batch-pressure")
                for pr in prompt_responses:
                    progress = getattr(pr, "progress", None)
                    has_progress = isinstance(progress, tuple) and len(progress) == 2
                    if has_progress:
                        self._prefill_done[pr.uid] = int(progress[0])
                    psub = self._subs.get(pr.uid)
                    if psub is None or not self._needs_snapshot or not psub.request.cache_id:
                        continue
                    if getattr(pr, "end_of_prompt", False):
                        continue
                    if has_progress and getattr(pr, "end_of_segment", False):
                        # Capture only the deliberately planted edge. Chunk
                        # edges are observable too, but copying at each one is
                        # expensive and unnecessary. extract_cache(uid) is
                        # padding-aware after PromptProcessingBatch.prompt()
                        # finalizes this step, so every sub in a multi-request
                        # wave can safely take its own snapshot.
                        boundary = psub.reused_tokens + int(progress[0])
                        if boundary == psub.snapshot_target:
                            self._capture_prompt_snapshot(psub, boundary)
                if responses:
                    # A token came back → prefill for this wave is done; stop
                    # the liveness markers (the SSE first byte now drives the
                    # watchdog's tighter streaming-idle bound).
                    self._prefill_total = 0
                    self._prefill_done = {}
                for r in responses:
                    sub = self._subs.get(r.uid)
                    if sub is None:
                        continue
                    if sub.generation_started_at is None:
                        # The step that yields the first token is the closest
                        # boundary BatchGenerator exposes between prefill and
                        # decode. Count it with prefill/TTFT, then measure decode
                        # from the inter-token intervals that follow; otherwise
                        # a short prompt can produce a near-zero denominator and
                        # a wildly inflated first-token rate.
                        sub.generation_started_at = step_ended_at
                        prefill_started_at = sub.prefill_started_at or step_ended_at
                        prefill_seconds = max(
                            step_ended_at - prefill_started_at,
                            1e-9,
                        )
                        if sub.prefill_total > 0:
                            sub.prompt_tps = sub.prefill_total / prefill_seconds
                    sub.first_token_seen = True
                    sub.token_ids.append(int(r.token))
                    generated_intervals = len(sub.token_ids) - 1
                    generation_seconds = step_ended_at - sub.generation_started_at
                    if generated_intervals > 0 and generation_seconds > 0:
                        sub.generation_tps = generated_intervals / generation_seconds
                    self._emit_delta(sub)
                    if r.finish_reason is not None:
                        self._finish(sub, r)
                        self._subs.pop(r.uid, None)
                # Yield so SSE generators flush + new requests get admitted.
                await asyncio.sleep(0)

    def _capture_prompt_snapshot(self, sub, at_tokens):
        """Capture the KV state at a mid-prompt boundary of `at_tokens`.

        Called from the worker's prompt-response handling at segment /
        chunk edges (the worker consumes `BatchGenerator.next()` per
        internal step, so the batch is quiescent between calls). A
        segment edge is a token-index cut deep inside text both turns
        share, so it is immune to the BPE boundary problem — measured
        live: the end-of-prompt token sequence `…<start_of_turn>model\\n`
        re-merges differently once the next turn's text continues past
        it, so a full-length snapshot misses by ~2 tokens and wrapped
        rotating layers can't trim even that. The admission loop plants
        a deliberate cut `_SNAPSHOT_BOUNDARY_MARGIN` tokens before the
        prompt's end so every turn gets one stable, advancing boundary.

        `extract_cache` materializes contiguous per-sequence copies and
        returns that sequence's unpadded token list, so the snapshot doesn't
        alias the live batch buffers or accidentally retain another sub's
        right-padding. Exact token-prefix + layer-offset checks are the runtime
        proof of the boundary invariant — on any mismatch the snapshot is
        dropped (logged once) and _finish falls back to the post-gen save.
        """
        try:
            got = self._gen.extract_cache([sub.uid]).get(sub.uid)
            layers = got[0] if got else None
            extracted_tokens = got[1] if got else None
            if cache_seed.snapshot_matches_prompt(
                layers, extracted_tokens, sub.prompt_tokens, at_tokens
            ):
                sub.prompt_snapshot = (list(layers), at_tokens)
            elif not self._snapshot_warned:
                self._snapshot_warned = True
                offsets = [getattr(c, "offset", None) for c in (layers or [])]
                print(
                    f"[batch] prompt snapshot skipped: boundary={at_tokens} "
                    f"extracted_tokens={len(extracted_tokens or [])} "
                    f"offsets={offsets} (post-gen save fallback)",
                    flush=True,
                )
        except Exception as exc:  # noqa: BLE001 — snapshot is best-effort
            if not self._snapshot_warned:
                self._snapshot_warned = True
                print(f"[batch] prompt snapshot failed: {exc}", flush=True)

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
        sub.queue.put_nowait(
            (
                "tok",
                delta,
                len(sub.token_ids),
                sub.prompt_tps,
                sub.generation_tps,
            )
        )

    def _finish(self, sub, r):
        full = _scrub_leaked_markers(self._tok.decode(sub.token_ids))
        if len(full) > sub.emitted:
            sub.queue.put_nowait(
                (
                    "tok",
                    full[sub.emitted :],
                    len(sub.token_ids),
                    sub.prompt_tps,
                    sub.generation_tps,
                )
            )
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
                    post_gen = list(cache_layers)
                    # Save decision: a post-generation cache is only worth
                    # keeping if a future turn can trim it back to wherever
                    # the re-templated history diverges from these raw
                    # tokens. Un-trimmable stacks (wrapped windowed layers)
                    # get the mid-prompt snapshot instead — a stable prefix
                    # of the next prompt, no trim ever needed. A tiny turn
                    # whose segment was too short to capture one keeps the
                    # PRIOR entry (still a valid prefix) rather than
                    # overwriting it with un-trimmable full-length state.
                    trimmable = cache_seed.all_trimmable(post_gen)
                    if not trimmable and sub.prompt_snapshot is None and sub.reused_tokens > 0:
                        prior_entry = _CACHE.get(sub.request.cache_id)
                        if prior_entry is not None:
                            sub.saved_cache_state = prior_entry.state
                        print(
                            f"[batch] kept prior cache entry for "
                            f"cache_id={sub.request.cache_id} (segment too short "
                            f"for a stable snapshot; post-turn cache not trimmable)",
                            flush=True,
                        )
                    else:
                        use_snapshot = sub.prompt_snapshot is not None and not trimmable
                        state = PromptCacheState()
                        if use_snapshot:
                            snap_layers, snap_count = sub.prompt_snapshot
                            state.cache = snap_layers
                            state.token_ids = list(sub.prompt_tokens[:snap_count])
                        else:
                            state.cache = post_gen
                            state.token_ids = (
                                [int(t) for t in all_tokens]
                                if all_tokens is not None
                                else list(sub.prompt_tokens) + list(sub.token_ids)
                            )
                        if state.token_ids:
                            _save_cache(sub.request.cache_id, state)
                            sub.saved_cache_state = state
                            _seed_prefix_from_session(sub.request, state)
                            print(
                                f"[batch] saved cache_id={sub.request.cache_id} "
                                f"tokens={len(state.token_ids)}"
                                + (
                                    " (prompt snapshot; post-turn cache not trimmable)"
                                    if use_snapshot
                                    else ""
                                ),
                                flush=True,
                            )
                # Reuse parity with the serial path's terminal log — the
                # line that makes "is the cache actually working?" a one-
                # line grep instead of a timing investigation.
                print(
                    f"[cache] reuse cache_id={sub.request.cache_id} "
                    f"cached_tokens={sub.reused_tokens} "
                    f"prefilled_tokens={sub.prefill_total} [batched]",
                    flush=True,
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[batch] cache save failed: {exc}", flush=True)
        sub.queue.put_nowait(
            ("done", r.finish_reason, sub.prompt_tps, sub.generation_tps)
        )


def _batched_tool_payload(frag, rid: str, model: str, in_toks: int, out_count: int, sub) -> Dict[str, Any]:
    """Batched-route envelope for one tool-stream fragment.

    Mirrors `_tool_stream_payload` but sources usage from the sub rather than
    a generation chunk — the batched worker reports counters separately.
    """
    if frag.content is not None:
        delta: Dict[str, Any] = {"role": "assistant", "content": frag.content}
    else:
        call: Dict[str, Any] = {
            "index": frag.tool_call_index,
            "function": {"arguments": frag.arguments or ""},
        }
        if frag.tool_call_id is not None:
            call["id"] = frag.tool_call_id
            call["type"] = "function"
            call["function"]["name"] = frag.name or ""
        delta = {"role": "assistant", "tool_calls": [call]}
    return {
        "id": rid,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        "usage": {
            "input_tokens": in_toks,
            "output_tokens": out_count,
            "total_tokens": in_toks + out_count,
            "prompt_tps": 0.0,
            "generation_tps": 0.0,
            "cached_tokens": sub.reused_tokens,
        },
    }


async def _batched_stream_iter(sub: "_Sub"):
    """SSE generator for the batched path — same wire frames as the serial
    route, fed from the engine worker's per-sub queue."""
    request = sub.request
    rid = sub.request_id
    in_toks = len(sub.prompt_tokens)
    # Same structured tool-call split as the serial route. The batched path
    # is the one the eval harness actually exercises (max-concurrency 1 still
    # runs through the batch engine), so wiring only the serial route left
    # the flag inert.
    tool_stream = _make_tool_stream(rid, getattr(request, 'tools', None))
    try:
        while True:
            item = await sub.queue.get()
            kind = item[0]
            if kind == "tok":
                _, delta, out_count, prompt_tps, generation_tps = item
                if await sub.http_request.is_disconnected():
                    sub.cancelled = True
                    return
                if tool_stream is not None:
                    for _frag in tool_stream.feed(delta):
                        yield "data: " + json.dumps(
                            _batched_tool_payload(_frag, rid, request.model, in_toks, out_count, sub)
                        ) + "\n\n"
                    continue
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
                            "prompt_tps": prompt_tps,
                            "generation_tps": generation_tps,
                            # Cache tokens actually served per the seed
                            # plan — parity with the serial path so the
                            # TS session's cachedInputTokens works on
                            # both. 0 means a genuinely cold prefill.
                            "cached_tokens": sub.reused_tokens,
                        },
                    }
                ) + "\n\n"
            elif kind == "done":
                _, reason, prompt_tps, generation_tps = item
                if tool_stream is not None:
                    for _frag in tool_stream.flush():
                        yield "data: " + json.dumps(
                            _batched_tool_payload(
                                _frag, rid, request.model, in_toks, len(sub.token_ids), sub
                            )
                        ) + "\n\n"
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
                            "prompt_tps": prompt_tps,
                            "generation_tps": generation_tps,
                            "cached_tokens": sub.reused_tokens,
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
        engine = _BATCH_ENGINE
        _reclaim_mlx_buffer_cache(
            "batch-turn-end",
            force=engine is None or engine.is_idle(),
            log=True,
        )


async def _await_batched_completion(sub: "_Sub") -> None:
    """Drain a non-streaming BatchEngine sub (currently cache warming)."""
    completed = False
    try:
        while True:
            item = await sub.queue.get()
            kind = item[0]
            if kind == "done":
                completed = True
                return
            if kind == "err":
                raise RuntimeError(item[1])
            # Generated token deltas are intentionally discarded: warming
            # needs one decode step to finalize the cache, not its text.
    finally:
        if not completed:
            sub.cancelled = True
        _unmark_inflight(sub.pinned_cache_ids)
        sub.pinned_cache_ids = []
        engine = _BATCH_ENGINE
        _reclaim_mlx_buffer_cache(
            "batch-warm-end",
            force=engine is None or engine.is_idle(),
            log=True,
        )


_BATCH_ENGINE: "Optional[BatchEngine]" = None


def _get_batch_engine() -> "BatchEngine":
    global _BATCH_ENGINE
    if _BATCH_ENGINE is None:
        lm = getattr(MODEL, "language_model", MODEL)
        tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        # mlx_lm models return raw logits — no LanguageModelOutput to unwrap.
        engine_model = lm if _TEXT_TOWER == "mlx_lm" else _UnwrapLM(lm)
        _BATCH_ENGINE = BatchEngine(engine_model, tok, ARGS.max_concurrency)
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
    # Undeclared fields are dropped by pydantic, and a dropped
    # `tool_calls` silently costs the model its own tool-call history:
    # Gemma's template renders a `role: "tool"` message only when it can
    # pair it with the preceding assistant call, so without this the
    # whole call/result exchange vanishes from the prompt. Wild-caught
    # on gemma4-26b-q4 — 62% of turns re-sent a prompt just ~5 tokens
    # longer than the last, the model never saw a single tool result,
    # and it re-issued the same call until the repeat-guard killed the
    # turn. Qwen masked it: Hermes templates render a bare tool message.
    tool_calls: Optional[List[Dict[str, Any]]] = None


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
    # `tuning.reasoning.thinkingBudget` — enforced here because MLX has no
    # `--reasoning-budget` equivalent; see think_budget.py.
    max_thinking_tokens: Optional[int] = None
    # Decode-time tool-call grammar (gezel extension). When set, the
    # server builds an llguidance logits processor that constrains the
    # function name of any tool call to the known tools — see
    # `build_tool_grammar_processor`. Shape: {"format": "...", "mode": "name-only"}.
    tool_grammar: Optional[Dict[str, Any]] = None
    # Per-request chat-template override (gezel extension). Swaps the
    # model's stored Jinja template for a curated one without reinstalling.
    chat_template_override: Optional[str] = None
    # Template variables the caller wants bound when rendering the prompt —
    # `enable_thinking`, `reasoning_effort`, and friends. llama-server has
    # honored this field for a while and the MLX provider has always SENT it;
    # until it was declared here pydantic dropped it silently, so every
    # constrained turn that asked for thinking to be off still rendered a
    # prompt ending in `<think>`. That one missing field was the bulk of the
    # measured MLX/llama-cpp divergence — see `_build_prompt`.
    chat_template_kwargs: Optional[Dict[str, Any]] = None


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
    # A warmed prefix is only reusable if it is a genuine token-prefix of the
    # real turns that follow, which means rendering through the SAME template
    # branch they do. Without `tools` this path fell to the non-tokenizer
    # render, and on Qwen — which puts the tool block at the top of the system
    # message — the warmed entry shared 3 tokens with every real prompt. Every
    # prefix-hit was a false hit: disk load, eviction pin, then a full
    # prefill anyway.
    tools: Optional[List[Dict[str, Any]]] = None
    chat_template_kwargs: Optional[Dict[str, Any]] = None
    # When True, write the warmed entry to disk immediately (don't wait
    # for eviction or shutdown). Used by the gezel-prefix warming flow
    # so subsequent sessions can load the prefix on miss without
    # depending on supervisor lifecycle. Default False matches the
    # session-warm semantics (in-memory only until evicted).
    persist: bool = False


@app.post("/v1/cache/warm")
async def cache_warm(req: CacheWarmRequest) -> JSONResponse:
    """Warm a cache through the same snapshot-capable BatchGenerator as chat.

    The older serial warm saved post-generation state. That is reusable for
    full-attention caches (they can trim back to the shared prefix), but not for
    wrapped sliding-window caches: their synthetic user/generated tail cannot
    be rewound, so the real first turn paid a full prefill anyway.

    System-only warms still need a synthetic user for Qwen-family templates.
    We render a second, deliberately different synthetic user and take their
    token LCP minus the normal safety margin. That gives BatchEngine an exact
    snapshot boundary inside the stable system prefix, before either fake user
    can contaminate an untrimmable entry.
    """
    synthetic_user = not any(m.role == "user" for m in req.messages)
    warm_messages = list(req.messages)
    if synthetic_user:
        warm_messages.append(ChatMessageReq(role="user", content="hi"))

    prompt_text = _build_prompt(
        warm_messages, req.tools, None, req.chat_template_kwargs
    )
    tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
    prompt_tokens = [int(t) for t in tok.encode(prompt_text)]
    snapshot_target = None
    if synthetic_user:
        alternate_messages = list(req.messages) + [
            ChatMessageReq(role="user", content="__gezel_cache_boundary_probe__")
        ]
        alternate_text = _build_prompt(
            alternate_messages, req.tools, None, req.chat_template_kwargs
        )
        alternate_tokens = [int(t) for t in tok.encode(alternate_text)]
        target = cache_seed.stable_snapshot_boundary(
            prompt_tokens, alternate_tokens, _SNAPSHOT_BOUNDARY_MARGIN
        )
        snapshot_target = target

    # A warm entry must be stable on EVERY axis the real turns vary, not just
    # the synthetic user. Measured: warming stopped at the synthetic-user
    # boundary (2,509 tokens) while a constrained turn diverges 27 tokens
    # earlier at the reasoning preamble (2,482) — and an untrimmable cache
    # cannot rewind 27 tokens any more than it can rewind 2,000, so every
    # prefix hit was still a full prefill. Take the tighter of the two.
    reasoning_target = _reasoning_stable_boundary(req, prompt_tokens)
    if reasoning_target:
        snapshot_target = (
            reasoning_target if not snapshot_target else min(snapshot_target, reasoning_target)
        )
        if snapshot_target == 0:
            print(
                f"[cache] no stable synthetic-user boundary for "
                f"cache_id={req.cache_id}; using normal finish save",
                flush=True,
            )

    warm_request = ChatRequest(
        model=req.model or str(ARGS.model),
        messages=warm_messages,
        stream=True,
        cache_id=req.cache_id,
        max_tokens=1,
        temperature=0.0,
    )
    cache_state, _, _ = _resolve_cache_state(warm_request)
    prior_tokens = len(cache_state.token_ids or [])
    sub = _Sub(
        request=warm_request,
        prompt_tokens=prompt_tokens,
        grammar=None,
        seed_state=cache_state,
        request_id=f"cachewarm-{uuid.uuid4()}",
        http_request=None,
        snapshot_target=snapshot_target,
    )
    sub.pinned_cache_ids = _mark_inflight(req.cache_id)
    sub.prefill_total = len(prompt_tokens)
    try:
        _get_batch_engine().submit(sub)
    except Exception as exc:
        _unmark_inflight(sub.pinned_cache_ids)
        sub.pinned_cache_ids = []
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))
    try:
        await _await_batched_completion(sub)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))

    cache_state = sub.saved_cache_state
    new_tokens = len(cache_state.token_ids or []) if cache_state is not None else 0
    persisted = False
    if cache_state is not None and new_tokens > 0:
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


def _template_tool_calls(tool_calls: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Shape OpenAI-wire tool calls for Jinja chat templates.

    The wire format carries `function.arguments` as a JSON *string*;
    HF chat templates near-universally expect a *mapping* and iterate it
    (`arguments | items`, `arguments.path`). Qwen's template raises
    `TypeError: Can only get item pairs from a mapping` on a string,
    which `apply_chat_template`'s caller catches — and its last-resort
    recovery is to re-render with `tools` dropped entirely, so a string
    here costs the model its whole tool surface rather than one message.
    Gemma's template tolerates both, which is why this only bites some
    families. Parse when we can; pass through untouched when we can't
    (a non-JSON string is still better than an exception).
    """
    shaped: List[Dict[str, Any]] = []
    for call in tool_calls:
        if not isinstance(call, dict):
            shaped.append(call)
            continue
        fn = call.get("function")
        args = fn.get("arguments") if isinstance(fn, dict) else None
        if not isinstance(args, str):
            shaped.append(call)
            continue
        try:
            parsed = json.loads(args)
        except (ValueError, TypeError):
            shaped.append(call)
            continue
        if not isinstance(parsed, dict):
            shaped.append(call)
            continue
        shaped.append({**call, "function": {**fn, "arguments": parsed}})
    return shaped


_TOOL_LINKAGE_PROBE: Dict[str, bool] = {}
_LINKAGE_PROBE_MARK = "__gezel_tool_linkage_probe__"


def _tool_linkage_probe_messages(linked: bool) -> List[Dict[str, Any]]:
    call = {
        "id": "probe1",
        "type": "function",
        "function": {"name": "probe_tool", "arguments": {"q": "x"}},
    }
    assistant: Dict[str, Any] = {"role": "assistant", "content": ""}
    result: Dict[str, Any] = {"role": "tool", "content": _LINKAGE_PROBE_MARK}
    if linked:
        assistant["tool_calls"] = [call]
        result["tool_call_id"] = "probe1"
    return [{"role": "user", "content": "go"}, assistant, result]


def _template_needs_tool_linkage(tokenizer: Any, chat_template_override: Any) -> bool:
    """Does this model's template DROP a tool result unless the assistant
    call it answers is linked to it?

    Gemma renders a `role: "tool"` message only as the response half of a
    call/response pair, so without the linkage the entire exchange vanishes
    and the model never sees a single tool result. Hermes-style templates
    (Qwen et al.) render a bare tool message just fine.

    That difference is why this is probed rather than always-on. Feeding
    Qwen the linkage is *more* correct on paper but measurably worse in
    practice: it starts seeing its own past `<tool_call>` blocks echoed in
    the transcript and imitates them — core-suite MLX went 8/11 -> 5/11,
    tool calls 457 -> 753, three fast passes turning into slow model-stuck
    retry loops. So we only add the linkage where its absence actually
    costs the model information, and leave every other template on the byte-
    identical legacy shape.

    Probed once per template: render a marker-bearing tool result with and
    without linkage; if the bare render loses the marker, linkage is
    required. Failures answer "no" — the legacy shape is the safe default.
    """
    key = str(chat_template_override) if chat_template_override else "<model>"
    cached = _TOOL_LINKAGE_PROBE.get(key)
    if cached is not None:
        return cached
    probe_tools = [
        {
            "type": "function",
            "function": {
                "name": "probe_tool",
                "description": "probe",
                "parameters": {
                    "type": "object",
                    "properties": {"q": {"type": "string"}},
                },
            },
        }
    ]
    kwargs: Dict[str, Any] = dict(
        tools=probe_tools, add_generation_prompt=True, tokenize=False
    )
    if chat_template_override:
        kwargs["chat_template"] = chat_template_override
    needs = False
    try:
        bare = tokenizer.apply_chat_template(
            _tool_linkage_probe_messages(False), **kwargs
        )
        linked = tokenizer.apply_chat_template(
            _tool_linkage_probe_messages(True), **kwargs
        )
        needs = (_LINKAGE_PROBE_MARK not in bare) and (_LINKAGE_PROBE_MARK in linked)
    except Exception as exc:
        print(
            f"[tool-prompt] tool-linkage probe failed ({exc}); "
            f"using legacy message shape",
            flush=True,
        )
        needs = False
    _TOOL_LINKAGE_PROBE[key] = needs
    print(
        f"[tool-prompt] tool-linkage probe: template "
        f"{'REQUIRES' if needs else 'does not need'} assistant/tool pairing"
        f"{' — passing tool_calls + tool_call_id through' if needs else ''}",
        flush=True,
    )
    return needs


# Template variables naming reasoning DEPTH rather than the on/off switch.
# Mirrors `REASONING_DEPTH_TEMPLATE_KWARGS` in providers/reasoning-depth.ts;
# kept in sync by reasoning-template-kwargs-wiring.test.ts.
_REASONING_DEPTH_KWARGS = frozenset({"reasoning_effort", "reasoning_strength"})


def _reasoning_stable_boundary(request, prompt_tokens) -> Optional[int]:
    """Last prompt position that does not depend on this turn's reasoning mode.

    Gezel flips `enable_thinking` between constrained and ordinary turns, and
    the template renders a reasoning preamble whose presence follows it. With
    the preamble relocated below the stable content that difference sits at
    the END of the system block — close enough to the whole prompt to look
    harmless, and fatal anyway, because a hybrid (linear-attention) cache
    cannot be trimmed back by even one token.

    Returns an absolute boundary to snapshot at, or None to keep the default
    end-of-prompt behaviour (correct for models whose cache CAN trim).
    """
    if not _needs_reasoning_stable_snapshot():
        return None
    kwargs = dict(request.chat_template_kwargs or {})
    flipped = dict(kwargs)
    flipped["enable_thinking"] = not bool(kwargs.get("enable_thinking", True))
    try:
        alternate = _build_prompt(
            request.messages, request.tools, request.chat_template_override, flipped
        )
        tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        alternate_tokens = [int(t) for t in tok.encode(alternate)]
    except Exception as exc:  # noqa: BLE001 — never fail a turn over a boundary hint
        print(f"[cache] reasoning-stable boundary unavailable: {exc}", flush=True)
        return None
    boundary = cache_seed.stable_snapshot_boundary(
        prompt_tokens, alternate_tokens, _SNAPSHOT_BOUNDARY_MARGIN
    )
    # 0 disables capture entirely in plan_snapshot_segments. If the two modes
    # diverge immediately there is nothing stable to save, and the default
    # end-of-prompt snapshot would just re-save an unusable entry.
    return boundary or None


def _needs_reasoning_stable_snapshot() -> bool:
    """True when a volatile tail in the saved state costs the ENTIRE entry.

    Deliberately the same predicate the engine already uses to decide whether
    to capture prompt snapshots at all (`prompt_snapshot=y` in the boot log),
    rather than a second hand-rolled cache probe: an earlier version called
    `all_trimmable(MODEL.make_cache())` and defaulted to False on any problem,
    which silently disabled this fix on precisely the untrimmable models it
    exists for. One predicate, one answer.
    """
    if not _STABLE_PREFIX_ENABLED:
        return False
    global _REASONING_SNAPSHOT_NEEDED
    if _REASONING_SNAPSHOT_NEEDED is None:
        # Probe the SAME object the engine probes — `_get_batch_engine`
        # builds `BatchEngine(_UnwrapLM(lm))`, and the VLM wrapper's
        # `make_cache` is not the language model's. Probing the wrapper
        # reported a trimmable cache for a model that logs
        # `prompt_snapshot=y` and `fresh-untrimmable` in the same run.
        _REASONING_SNAPSHOT_NEEDED = cache_seed.probe_needs_prompt_snapshot(
            getattr(MODEL, "language_model", MODEL)
        )
        print(
            f"[cache] reasoning-stable snapshot "
            f"{'ENABLED (cache cannot be rewound)' if _REASONING_SNAPSHOT_NEEDED else 'not needed (trimmable cache)'}",
            flush=True,
        )
    return _REASONING_SNAPSHOT_NEEDED


_REASONING_SNAPSHOT_NEEDED = None


def _build_prompt(
    messages: List[ChatMessageReq],
    tools: Optional[List[Dict[str, Any]]] = None,
    chat_template_override: Optional[str] = None,
    chat_template_kwargs: Optional[Dict[str, Any]] = None,
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
    # Text-only models (e.g. laguna): load_processor returns the bare
    # tokenizer itself — no `.tokenizer` attribute. Falling back to
    # PROCESSOR keeps the canonical tools render; without it this
    # function silently drops `tools` via the text-only path below.
    _probe_tokenizer = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
    link_tools = (
        any(m.tool_calls or m.tool_call_id for m in messages)
        and _probe_tokenizer is not None
        and hasattr(_probe_tokenizer, "apply_chat_template")
        and _template_needs_tool_linkage(_probe_tokenizer, chat_template_override)
    )
    raw = []
    for m in messages:
        content = m.content
        if isinstance(content, list):
            parts = [p.get("text", "") for p in content if isinstance(p, dict)]
            content = "\n".join(p for p in parts if p)
        entry: Dict[str, Any] = {"role": m.role, "content": content or ""}
        # Carry the tool-call linkage through to the template, but ONLY for
        # templates that actually need it — see _template_needs_tool_linkage.
        # Templates that render a bare tool message stay byte-identical to
        # the legacy shape (which also keeps their prompt caches valid).
        if link_tools:
            if m.tool_calls:
                entry["tool_calls"] = _template_tool_calls(m.tool_calls)
            if m.tool_call_id:
                entry["tool_call_id"] = m.tool_call_id
        raw.append(entry)

    tokenizer = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
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
        # A caller-supplied override always wins — it is the escape hatch for
        # a known-bad embedded template and must not be silently second-
        # guessed. Otherwise use the prefix-stable rewrite when one verified.
        if chat_template_override:
            base_kwargs["chat_template"] = chat_template_override
        elif STABLE_CHAT_TEMPLATE:
            base_kwargs["chat_template"] = STABLE_CHAT_TEMPLATE
        # Reasoning defaults ON (Qwen3 reasoning forced inside <think>), then
        # the caller's template vars override it. The default has to stay True:
        # every model whose template reads the switch was tuned here, and
        # flipping the default would silently disable reasoning for ordinary
        # turns rather than only the constrained ones the caller names.
        template_vars: Dict[str, Any] = {"enable_thinking": True}
        if chat_template_kwargs:
            template_vars.update(chat_template_kwargs)
        # Attempt order, most-capable first. The DEPTH dials get their own
        # rung above the switch because they are the ones that reject values:
        # Qwen 3.8's jinja `raise_exception`s on any effort outside
        # {xhigh, medium, low}, and a template raises rather than returning —
        # so a bad depth value must not cost us `enable_thinking`, which is
        # worth far more (it decides whether the turn reasons at all).
        #   1. + all template vars   (switch + caller's depth)
        #   2. - depth dials         (template rejected a depth VALUE)
        #   3. - template vars       (template reads none of them)
        #   4. - tools               (template can't render tools at all)
        #
        # Each rung catches Exception, not (TypeError, ValueError): a Jinja
        # TemplateError is neither, and the fallbacks are strictly more
        # conservative than the rung above, so degrading beats a dead turn.
        depth_keys = [k for k in template_vars if k in _REASONING_DEPTH_KWARGS]
        try:
            return tokenizer.apply_chat_template(raw, **template_vars, **base_kwargs)
        except Exception as exc_vars:
            if depth_keys:
                without_depth = {
                    k: v for k, v in template_vars.items() if k not in _REASONING_DEPTH_KWARGS
                }
                try:
                    result = tokenizer.apply_chat_template(
                        raw, **without_depth, **base_kwargs
                    )
                    print(
                        f"[tool-prompt] template rejected reasoning depth "
                        f"{ {k: template_vars[k] for k in depth_keys} }; retried "
                        f"with the switch only: {exc_vars}",
                        flush=True,
                    )
                    return result
                except Exception:
                    pass
            try:
                result = tokenizer.apply_chat_template(raw, **base_kwargs)
                # Loud, because falling back here silently restores the
                # template's own reasoning defaults — which is exactly the
                # divergence this parameter exists to close.
                print(
                    f"[tool-prompt] template rejected {sorted(template_vars)}; "
                    f"retried without them (reasoning falls back to the "
                    f"template default): {exc_vars}",
                    flush=True,
                )
                return result
            except Exception as exc_tools:
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
    # The mlx_lm tower has no vlm processor/config pair — its tokenizer
    # renders directly (same chat_template.jinja on disk either way).
    if _TEXT_TOWER == "mlx_lm":
        tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        return tok.apply_chat_template(raw, tokenize=False, add_generation_prompt=True)
    config = getattr(MODEL, "config", None) or {}
    return apply_chat_template(PROCESSOR, config, raw)


def _serial_prompt_token_variants(prompt_text: str) -> "List[List[int]]":
    """Best-effort re-encodings of the prompt for the serial-path guard.

    mlx_vlm tokenizes the prompt itself (processor pipeline, possibly
    BOS-prefixed), so our own `encode` can differ by exactly a leading
    BOS. The guard takes the max LCP across both variants, absorbing
    that edge without replicating the processor. Empty list = cannot
    encode = the guard fails safe (reset, cold prefill).
    """
    tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
    try:
        base = [int(t) for t in tok.encode(prompt_text)]
    except Exception:  # noqa: BLE001 — no encode, no verification
        return []
    variants = [base]
    bos = getattr(tok, "bos_token_id", None)
    if isinstance(bos, int) and not isinstance(bos, bool):
        if base[:1] == [bos]:
            variants.append(base[1:])
        else:
            variants.append([bos] + base)
    return variants


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
        request.messages,
        request.tools,
        request.chat_template_override,
        request.chat_template_kwargs,
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
    think_budget_processor = None
    if request.max_thinking_tokens:
        _tb_tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        think_budget_processor = think_budget.build_think_budget_processor(
            _tb_tok,
            request.max_thinking_tokens,
            # Thinking templates open the assistant turn already inside the
            # think block (`...<think>\n` generation prompt) — the open tag
            # never appears in the generated stream, so seed the state from
            # the prompt tail.
            opens_in_think=prompt_text.rstrip().endswith("<think>"),
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

    # BatchGenerator path: use it even for a singleton queue. Besides
    # concurrency, this path owns the prompt-boundary snapshot needed to reuse
    # wrapped/windowed KV caches safely after a tool result makes the next
    # prompt diverge from the raw generated-token tail. The serial fallback is
    # retained only for an explicit --max-concurrency 0.
    if int(getattr(ARGS, "max_concurrency", 1) or 0) >= 1:
        _engine = _get_batch_engine()
        _tok = getattr(PROCESSOR, "tokenizer", None) or PROCESSOR
        prompt_tokens = [int(t) for t in _tok.encode(prompt_text)]
        sub = _Sub(
            request=request,
            prompt_tokens=prompt_tokens,
            grammar=[
                p for p in (tool_grammar_processor, think_budget_processor) if p is not None
            ]
            or None,
            seed_state=cache_state,
            request_id=request_id,
            http_request=http_request,
            # Save at the last reasoning-mode-invariant position. Without
            # this the saved entry carries this turn's reasoning preamble,
            # and the next turn in the other mode diverges from it by ~27
            # tokens — which an untrimmable hybrid cache cannot rewind, so
            # the whole multi-thousand-token entry is discarded.
            snapshot_target=_reasoning_stable_boundary(request, prompt_tokens),
        )
        sub.pinned_cache_ids = pinned_cache_ids
        # Pessimistic placeholder until admission: the authoritative
        # prefill count comes from the seed plan in _seed_args (the old
        # entry-size arithmetic here under-reported by ~40× whenever the
        # seed was rejected, which suppressed the liveness markers during
        # the exact full re-prefills they exist to surface).
        sub.prefill_total = len(prompt_tokens)
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

    # Defense in depth: the tower selector requires --max-concurrency >= 1
    # for the mlx_lm text tower, so this serial branch (mlx_vlm
    # stream_generate) should be unreachable in lm mode. If a future edit
    # breaks that invariant, fail loudly instead of feeding an mlx_lm
    # model into mlx_vlm's generate loop.
    if _TEXT_TOWER == "mlx_lm":
        raise HTTPException(
            status_code=501,
            detail=(
                "serial generation path is unavailable with the mlx_lm text "
                "tower; restart without GEZEL_MLX_TEXT_TOWER or with "
                "--max-concurrency >= 1"
            ),
        )

    # Serial-path guard: mlx_vlm's divergent-prefix branch trims by
    # slicing `keys[:, :, :lcp]`, which silently corrupts wrapped
    # sliding-window layers (the rotated cache is SHORTER than the
    # prefix, gets skipped, and its offset disagrees with the trimmed
    # full-attention layers from then on). When the state can't be
    # trimmed coherently and the prompt genuinely diverges, a cold
    # prefill is the only correct outcome — reset before handing the
    # state to stream_generate. Pure extensions pass through untouched.
    if cache_state.cache is not None and (cache_state.token_ids or []):
        _variants = _serial_prompt_token_variants(prompt_text)
        if cache_seed.serial_reset_needed(cache_state.token_ids, cache_state.cache, _variants):
            print(
                f"[cache] serial divergence on untrimmable cache; cold prefill "
                f"cache_id={request.cache_id}",
                flush=True,
            )
            cache_state = PromptCacheState()

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
                **_kv_quant_kwargs(),
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
            _lps = [
                p for p in (tool_grammar_processor, think_budget_processor) if p is not None
            ]
            if _lps:
                # Forwarded through stream_generate(**kwargs) → generate_step,
                # which accepts `logits_processors`. Grammar constrains the
                # tool-call function name; think-budget forces `</think>` at
                # the configured reasoning budget (llama parity).
                generation_kwargs["logits_processors"] = _lps

            output_text = ""

            tool_stream = _make_tool_stream(request_id, getattr(request, 'tools', None))
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

                    # With --stream-tool-calls the raw text is split into
                    # content and tool-call argument deltas, so the client
                    # sees a real call boundary instead of markup embedded in
                    # prose. Without it this is a no-op passthrough and the
                    # gezel-side salvage path behaves exactly as before.
                    for _frag in _tool_stream_fragments(tool_stream, chunk_text):
                        yield "data: " + json.dumps(
                            _tool_stream_payload(_frag, request_id, request.model, chunk)
                        ) + "\n\n"
                    if tool_stream is not None:
                        continue

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

            if tool_stream is not None and last_chunk is not None:

                for _frag in tool_stream.flush():

                    yield "data: " + json.dumps(

                        _tool_stream_payload(_frag, request_id, request.model, last_chunk)

                    ) + "\n\n"

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
                print("Stream finished without a prompt-cache save.", flush=True)
            # Release the eviction pins taken for this turn — AFTER the save
            # above, so this turn's own _save_cache → _enforce_budget can't
            # evict the entry it just wrote.
            _unmark_inflight(pinned_cache_ids)
            # Agentic tool loops issue multiple HTTP sub-turns inside one user
            # turn. Reclaim scratch buffers at every one of those boundaries,
            # including the cache-preserving path above; prompt KV remains an
            # active allocation and is not touched by clear_cache().
            _reclaim_mlx_buffer_cache("turn-end", force=True, log=True)

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
