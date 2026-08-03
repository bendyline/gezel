"""Prompt-cache seed planning for the gezel MLX wrapper.

Why this exists: the batched path (`--max-concurrency > 1`) originally
reused a session's cache only when the previous turn's ENTIRE saved token
sequence — prompt plus the model's raw generated tokens — was an exact
prefix of the new prompt. That almost never holds for verbose families
(Gemma): the TS side strips leaked reasoning / tool markup out of the
assistant message before persisting it, so the re-templated history
diverges from the raw tokens at the first stripped character, the exact
check failed, and every turn re-prefilled the full conversation from
token 0 (~2 minutes on a 20K-token Meester session). The serial path
never had this bug — mlx_vlm's `PromptCacheState` reuses the longest
common prefix and trims the tail — so the fix is to give the batched
path the same semantics, via each cache class's own `is_trimmable()` /
`trim(n)` protocol (never naive keys-slicing, which silently corrupts
rotated sliding-window caches).

Sliding-window caveat: RotatingKVCache reports `is_trimmable() == False`
once its offset passes the window (`max_size`), because rewinding past
overwritten positions is genuinely impossible. Gemma 3/4 use windowed
layers, so any real conversation is un-trimmable by turn 2. For those
models the server captures a KV snapshot at the end-of-prompt boundary
(before any generated token enters the cache) and saves THAT as the
session entry: the next turn's prompt re-templates the same history, so
the snapshot is a pure extension and no trim is ever needed.
`probe_needs_prompt_snapshot` decides per-model whether that capture is
worth paying for.

Pure python on purpose — no mlx import — so the logic is unit-testable
anywhere (`cache_seed_test.py`) and importable by the server the same
way `cache_persist` is.
"""

from __future__ import annotations

from typing import Any, List, NamedTuple, Optional, Sequence


class SeedPlan(NamedTuple):
    """Outcome of {@link seed_from_state} for one request.

    `segment` is what the engine must prefill; `caches` / `all_tokens`
    plug straight into BatchGenerator.insert; `reused` is the token
    count served from cache (drives the `cached_tokens` usage field and
    the reuse log); `mode` names the decision for the seed log line.
    """

    segment: List[int]
    caches: Optional[List[Any]]
    all_tokens: List[int]
    reused: int
    mode: str


def longest_common_prefix(a: Sequence[int], b: Sequence[int]) -> int:
    """Length of the shared leading run of two token sequences."""
    limit = min(len(a), len(b))
    for i in range(limit):
        if a[i] != b[i]:
            return i
    return limit


def _layer_trimmable(layer: Any) -> bool:
    fn = getattr(layer, "is_trimmable", None)
    if not callable(fn):
        return False
    try:
        return bool(fn())
    except Exception:  # noqa: BLE001 — a broken layer is an untrimmable layer
        return False


def all_trimmable(layers: Optional[Sequence[Any]]) -> bool:
    """True when every layer supports the trim protocol right now.

    Rotating caches answer False once wrapped past their window, which
    is correct — the overwritten positions cannot be recovered.
    """
    if not layers:
        return False
    return all(_layer_trimmable(c) for c in layers)


def _offsets_consistent(layers: Sequence[Any], expected: int) -> bool:
    """Every layer that exposes an `offset` must sit at `expected`.

    Guards against drifted entries (token_ids longer than the KV they
    describe) being reused into garbage generation. Layers without an
    offset attribute (Mamba-style state caches) are given the benefit of
    the doubt — they have no positional KV to misalign.
    """
    for c in layers:
        offset = getattr(c, "offset", None)
        if offset is None:
            continue
        try:
            if int(offset) != expected:
                return False
        except (TypeError, ValueError):
            return False
    return True


def trim_layers(layers: Sequence[Any], n: int) -> bool:
    """Trim `n` tokens off the end of every layer, all-or-nothing.

    Pre-verifies trimmability and offset agreement BEFORE mutating
    anything: `.trim()` clamps internally (`min(offset, n)`), so a layer
    that could only partially trim would leave the stack incoherent —
    some layers rewound, others not — which generates silent garbage.
    With the pre-checks the per-layer trims cannot come up short; the
    post-check is belt-and-braces against a cache class that lies.
    """
    if n <= 0:
        return True
    if not layers or not all_trimmable(layers):
        return False
    for c in layers:
        offset = getattr(c, "offset", None)
        if offset is None or int(offset) < n:
            return False
    for c in layers:
        try:
            trimmed = c.trim(n)
        except Exception:  # noqa: BLE001
            return False
        if trimmed != n:
            return False
    return True


def seed_from_state(state: Any, prompt_tokens: Sequence[int]) -> SeedPlan:
    """Plan cache reuse for one request: extension, trim, or fresh.

    `state` is a PromptCacheState-shaped object (`.cache` layer list +
    `.token_ids`). On the trimmed path the state is mutated in place —
    layers rewound to the common prefix and `token_ids` truncated to
    match — so the in-engine entry stays self-consistent even if the
    wave later fails before its finish-time save.
    """
    full = list(prompt_tokens)
    cached = list(getattr(state, "token_ids", None) or []) if state is not None else []
    layers = getattr(state, "cache", None) if state is not None else None
    n = len(cached)
    if n == 0 or not layers:
        return SeedPlan(full, None, [], 0, "fresh")

    lcp = longest_common_prefix(cached, full)
    if lcp >= len(full):
        # Identical (or shrunken) prompt: leave at least one token to
        # feed the decode step that produces the first new token.
        lcp = len(full) - 1
    if lcp <= 0:
        return SeedPlan(full, None, [], 0, "fresh-no-overlap")

    if lcp == n:
        if not _offsets_consistent(layers, n):
            return SeedPlan(full, None, [], 0, "fresh-inconsistent")
        return SeedPlan(full[n:], list(layers), cached, n, "extension")

    if not _offsets_consistent(layers, n):
        return SeedPlan(full, None, [], 0, "fresh-inconsistent")
    if trim_layers(layers, n - lcp):
        state.token_ids = cached[:lcp]
        return SeedPlan(full[lcp:], list(layers), cached[:lcp], lcp, "trimmed")
    return SeedPlan(full, None, [], 0, "fresh-untrimmable")


def probe_needs_prompt_snapshot(model: Any) -> bool:
    """Should the engine capture an end-of-prompt KV snapshot per turn?

    True when the model's cache stack contains layers that stop being
    trimmable as the sequence grows: windowed layers (`max_size` set —
    RotatingKVCache wraps and becomes un-rewindable) or layers that are
    un-trimmable even when fresh (Mamba-style state). For those models a
    post-generation cache is useless the moment history diverges from
    the raw tokens, so the prompt-boundary snapshot is the only state
    worth persisting. Full-attention stacks return False and skip the
    snapshot copy entirely — LCP+trim already covers them.

    Best-effort: no `make_cache`, or one that throws, means False (the
    engine then behaves exactly as before this feature).
    """
    try:
        make_cache = getattr(model, "make_cache", None)
        layers = make_cache() if callable(make_cache) else None
    except Exception:  # noqa: BLE001
        return False
    if not layers:
        return False
    for c in layers:
        try:
            if (getattr(c, "max_size", 0) or 0) > 0:
                return True
        except TypeError:
            pass
        if not _layer_trimmable(c):
            return True
    return False


def serial_reset_needed(
    cached_token_ids: Optional[Sequence[int]],
    layers: Optional[Sequence[Any]],
    prompt_token_variants: Sequence[Sequence[int]],
) -> bool:
    """Must the serial path drop this state instead of handing it to
    mlx_vlm's prefix-reuse logic?

    mlx_vlm's divergent-prefix branch trims by slicing `keys[:, :, :lcp]`
    on layers whose length exceeds the prefix — a wrapped RotatingKVCache
    is SHORTER than the prefix, so it gets skipped while full-attention
    layers are rewound, leaving per-layer offsets disagreeing and the
    generation silently corrupt. When the cache is not fully trimmable
    and the new prompt genuinely diverges, a cold prefill is the only
    correct outcome; pure extensions are safe upstream and stay.

    `prompt_token_variants` carries the caller's best re-encodings of the
    prompt (typically with and without a BOS) — the max LCP across them
    absorbs tokenizer edge differences from the engine's own encoding.
    """
    cached = list(cached_token_ids or [])
    n = len(cached)
    if n == 0 or not layers:
        return False
    if all_trimmable(layers):
        return False
    best = 0
    for variant in prompt_token_variants:
        lcp = longest_common_prefix(cached, variant)
        if lcp > best:
            best = lcp
        if best >= n:
            return False
    return best < n
