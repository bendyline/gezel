"""MTP speculative decoding for the batch engine — the sidecar-owned spec wave.

Measured basis (reports/mlx-mtp-rig-20260828.md, 2026-08-28): +34% decode
over the shipped config at both 11k and 73k context on qwen3.8-27b-q4,
greedy-exact on mlx-vlm 0.6.17 — and NOT exact on 0.6.6, which is why the
pin gate exists. Config-default block size (mtp layers + 2) measured
optimal; deeper drafting went net-negative. Upstream's own spec batch
honors per-sequence logits processors for the FIRST token only and then
silently drops them, so `eligibility` keeps processor-armed requests off
the spec path entirely until the processed verify walk ships.

"Sidecar-owned" means no upstream generator runs the wave: BatchEngine
admits one eligible sub, `chunked_prefill_steps` fills its (possibly
seeded) cache with direct language-tower calls, and upstream's serial
`_mtp_rounds` produces tokens. The engine keeps its own emit, liveness,
snapshot, cancellation, and save machinery, so a spec turn is
indistinguishable downstream from a batch turn. Only probeable mlx_vlm
surfaces are touched; every degrade logs one `[spec]` reason and falls
back to the normal path.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Iterator, List, Optional, Tuple


@dataclass
class SpecState:
    drafter: Any
    kind: str
    block_size: Optional[int]
    drafter_dir: str


def _off(log: Callable[[str], None], reason: str) -> None:
    log(f"[spec] off ({reason})")


def resolve_spec(args, model, text_tower: Optional[str], log=print) -> Optional[SpecState]:
    """Boot-time capability probe. Every failure logs one `[spec] off`
    line and degrades to no-speculation — never raises. Returns an armed
    SpecState only when the drafter loads, validates against the target,
    and the vlm tower's rollback surface is present."""
    draft_dir = getattr(args, "spec_draft_model", None)
    if not draft_dir:
        return None
    env = os.environ.get("GEZEL_MLX_SPEC", "").strip().lower()
    if env in ("0", "off", "false"):
        _off(log, "GEZEL_MLX_SPEC=off")
        return None
    if text_tower == "mlx_lm":
        _off(
            log,
            "mlx_lm text tower active — MTP verify needs the vlm tower's "
            "rollback_speculative_cache (drop GEZEL_MLX_TEXT_TOWER=force to enable spec)",
        )
        return None
    if not os.path.isdir(str(draft_dir)):
        _off(log, f"drafter dir not found: {draft_dir}")
        return None
    # 0.6.6's MTP verify is measured-INEXACT (greedy spec diverged from
    # greedy nospec — reports/mlx-mtp-rig-20260828.md); exactness was
    # proven on 0.6.17. A stale venv must never serve speculation.
    try:
        from importlib.metadata import version as _pkgver

        ver = tuple(int(x) for x in _pkgver("mlx-vlm").split(".")[:3])
        if ver < (0, 6, 17):
            _off(log, f"mlx-vlm {'.'.join(map(str, ver))} < 0.6.17 — MTP verify inexact below the pin")
            return None
    except Exception as exc:  # noqa: BLE001
        _off(log, f"cannot determine mlx-vlm version: {exc}")
        return None
    lm = getattr(model, "language_model", model)
    if not hasattr(lm, "rollback_speculative_cache"):
        _off(log, f"language tower {type(lm).__name__} lacks rollback_speculative_cache")
        return None
    try:
        from mlx_vlm.speculative import mtp as _mtp
        from mlx_vlm.speculative.drafters import (
            load_drafter,
            validate_drafter_compatibility,
        )

        for attr in (
            "_mtp_rounds",
            "_mtp_shared_kv_from_prompt_cache",
            "_buffer_mtp_target_cache",
            # assisted (sampled/processed) rounds drive these directly:
            "_mtp_verify_target",
            "_mtp_draft_hidden",
            "_mtp_draft_position",
            "_mtp_cache_offset_max",
            "_mtp_next_block_size",
            "_slice_shared_kv_after_reject",
        ):
            if not hasattr(_mtp, attr):
                _off(log, f"mlx_vlm.speculative.mtp lacks {attr}")
                return None
    except Exception as exc:  # noqa: BLE001
        _off(log, f"mlx_vlm speculative surface unavailable: {exc}")
        return None
    try:
        drafter, kind = load_drafter(
            str(draft_dir), getattr(args, "spec_draft_kind", None) or None
        )
    except Exception as exc:  # noqa: BLE001
        _off(log, f"drafter load failed: {exc}")
        return None
    if kind != "mtp":
        _off(log, f"drafter kind {kind!r} — only mtp is wired")
        return None
    try:
        validate_drafter_compatibility(model, drafter, kind)
    except Exception as exc:  # noqa: BLE001
        _off(log, f"drafter incompatible with target: {exc}")
        return None
    block = getattr(args, "spec_block_size", None)
    return SpecState(
        drafter=drafter,
        kind=kind,
        block_size=int(block) if block else None,
        drafter_dir=str(draft_dir),
    )


def eligibility(request, grammar) -> Tuple[bool, str]:
    """v1 gate: greedy + processor-free requests only. Sampled acceptance
    needs the positioned-sampler bridge, and processors under upstream
    speculation fire once then vanish (measured) — for a tool grammar
    that is worse than no grammar at all."""
    t = getattr(request, "temperature", None)
    if t not in (None, 0, 0.0):
        return False, f"sampled (temperature={t})"
    if grammar is not None:
        return False, "logits processors present (tool grammar / think budget)"
    if getattr(request, "repetition_penalty", None) is not None:
        return False, "repetition_penalty set"
    if getattr(request, "top_k", None):
        return False, "top_k set"
    return True, ""


def cache_matches_tower(layers, tower) -> bool:
    """Seed-guard: a persisted entry with another tower's layer layout must
    become a miss, not a crash deep inside a spec round."""
    try:
        expect = tower.make_cache()
    except Exception:  # noqa: BLE001
        return False
    if layers is None or len(layers) != len(expect):
        return False
    return all(
        type(a).__name__ == type(b).__name__ for a, b in zip(layers, expect)
    )


def clone_layers(layers) -> List[Any]:
    """Reconstruct standalone cache layers from live ones via the
    state/meta_state round-trip (the same contract cache_persist relies
    on). MLX arrays are functionally immutable, so sharing buffers with
    the live cache is safe — later writes rebind, never mutate."""
    out = []
    for c in layers:
        out.append(type(c).from_state(c.state, c.meta_state))
    return out


def chunked_prefill_steps(
    tower,
    cache,
    tokens: List[int],
    step: int,
    *,
    cut: Optional[int] = None,
) -> Iterator[Tuple[str, int, int, Any]]:
    """Prefill `tokens` into `cache` with direct tower calls, one chunk per
    yield so the async worker can breathe, emit liveness, and check
    cancellation between chunks.

    `cut` (index into `tokens`) forces a chunk edge so the caller can
    capture a boundary snapshot from a quiescent cache. Yields
    ("cut"|"chunk", done, total, None) per chunk and finally
    ("final", n, n, bundle) where bundle carries the last chunk's logits,
    the hidden states CONCATENATED across all chunks (the MTP drafter's
    prompt-prefill needs hidden aligned with every prefilled token, and
    the tower does not accumulate across cache-continued calls), and the
    final shared_kv_states (empty-by-design on qwen3_5 — its drafter
    builds its own KV from token+hidden pairs).
    """
    import types as _types

    import mlx.core as mx

    n = len(tokens)
    i = 0
    out = None
    hidden_parts: List[Any] = []
    while i < n:
        j = min(n, i + int(step or 2048))
        if cut is not None and i < cut < j:
            j = cut
        last = j >= n
        chunk = mx.array([tokens[i:j]])
        out = tower(
            chunk,
            cache=cache,
            skip_logits=not last,
            return_hidden=True,
            return_shared_kv=True,
        )
        part = out.hidden_states[-1]
        hidden_parts.append(part)
        # Evaluate hidden with the cache each chunk — holding lazy graphs
        # across a 70k-token prefill is how peak memory runaways start.
        if last:
            mx.eval(out.logits, part)
        else:
            mx.eval([c.state for c in cache], part)
        i = j
        yield (
            "cut" if (cut is not None and i == cut) else "chunk",
            i,
            n,
            None,
        )
    hidden = (
        hidden_parts[0]
        if len(hidden_parts) == 1
        else mx.concatenate(hidden_parts, axis=1)
    )
    bundle = _types.SimpleNamespace(
        logits=out.logits,
        hidden_states=[hidden],
        shared_kv_states=getattr(out, "shared_kv_states", None) or {},
    )
    yield ("final", n, n, bundle)


def first_token_from(last_output) -> int:
    import mlx.core as mx

    return int(mx.argmax(last_output.logits[:, -1, :], axis=-1).item())


def make_rounds(
    model,
    spec: SpecState,
    cache,
    hidden_tokens: List[int],
    last_output,
    first_bonus: int,
    max_tokens: int,
):
    """Build the serial MTP round generator over a prefilled cache — the
    B==1 branch of upstream run_speculative_rounds, with one deliberate
    difference: the caller's chunked prefill ran every chunk with the MTP
    capture kwargs, so the final output's shared-kv covers the full
    context."""
    import mlx.core as mx
    from mlx_vlm.speculative.mtp import (
        _buffer_mtp_target_cache,
        _mtp_rounds,
    )

    # shared_kv_states comes from the final prefill chunk: with the MTP
    # capture kwargs on every chunk (see chunked_prefill_steps) the tower
    # accumulates it across chunks, so the last output covers the full
    # context. (_mtp_shared_kv_from_prompt_cache is NOT usable here — it
    # keys on layer.layer_type, which qwen3_5 decoder layers don't expose.)
    shared_kv = last_output.shared_kv_states
    hidden = last_output.hidden_states[-1]
    # No-op for the qwen3_5 stack (only Rotating caches get wrapped); kept
    # for parity with upstream's round setup so other archs stay correct.
    _buffer_mtp_target_cache(cache, spec.drafter, spec.block_size)
    # The tokens whose target hidden the caller actually computed — the
    # newly-prefilled span. On a fresh prefill that is the whole prompt
    # (upstream parity); on a seeded resume the drafter's own context
    # covers just the tail, which can cost acceptance, never correctness
    # (the full-context target verify decides every token).
    prompt_ids = mx.array([[int(t) for t in hidden_tokens]])

    def _greedy(logprobs):
        return mx.argmax(logprobs, axis=-1)

    return _mtp_rounds(
        model,
        spec.drafter,
        cache,
        hidden,
        shared_kv,
        prompt_tokens=prompt_ids,
        first_bonus=int(first_bonus),
        max_tokens=int(max_tokens),
        sampler=_greedy,
        draft_block_size=spec.block_size,
        token_dtype=prompt_ids.dtype,
        greedy_sampling=True,
    )


def stats_line(spec: SpecState) -> Optional[str]:
    """Per-wave acceptance telemetry (drafter counters reset per wave by
    upstream's round setup). An A/B arm without this line is retracted."""
    try:
        from mlx_vlm.speculative.utils import format_speculative_stats

        return format_speculative_stats(spec.drafter)
    except Exception:  # noqa: BLE001
        return None


def spec_mode(request, grammar) -> Tuple[Optional[str], str]:
    """Which spec route serves this request.

    "greedy"   — temp 0/unset, no processors: the C1 path, proven exact
                 against plain greedy decode.
    "assisted" — everything else: positioned target sampling (temperature/
                 top_p/top_k, deterministic per-(seed,position) keys) and/or
                 the processed sequential walk, where every emitted token is
                 a draw from the PROCESSED target distribution — lossless by
                 construction, so grammar and think-budget ride speculation.
    None       — operator restricted (`GEZEL_MLX_SPEC=greedy-only`).

    Gate-C measured why "assisted" exists: gezel's tuned profiles sample at
    temp 0.6–1.0 with top_k 20–40 on every profile, so a greedy-only gate
    reaches ~0% of product traffic.
    """
    t = getattr(request, "temperature", None)
    greedy = t in (None, 0, 0.0)
    has_procs = (
        grammar is not None
        or getattr(request, "repetition_penalty", None) is not None
    )
    if greedy and not has_procs:
        return "greedy", ""
    env = os.environ.get("GEZEL_MLX_SPEC", "").strip().lower()
    if env == "greedy-only":
        why = "processor-armed" if has_procs else f"sampled (temperature={t})"
        return None, f"GEZEL_MLX_SPEC=greedy-only and request is {why}"
    return "assisted", ""


class PositionedSampler:
    """Target sampler with stateless draws keyed by (seed, row, position).

    Same protocol as upstream's `_PositionedTargetSampler` (`sample_target`
    + plain `__call__`), extended with top_k — which upstream lacks and
    every gezel tuning profile sets (20–40). Deterministic given the seed:
    replaying a wave with the same seed reproduces it token-for-token,
    which is what makes sampled A/Bs and incident replays possible.
    """

    def __init__(self, *, temperature: float, top_p: float = 0.0,
                 top_k: int = 0, seed: int = 0):
        self.temperature = max(float(temperature), 1e-6)
        self.top_p = float(top_p or 0.0)
        self.top_k = int(top_k or 0)
        self.seed = int(seed)

    def _filtered(self, logprobs):
        import mlx.core as mx

        lp = logprobs.astype(mx.float32) if logprobs.dtype != mx.float32 else logprobs
        if self.top_k > 0 and self.top_k < lp.shape[-1]:
            kth = mx.sort(lp, axis=-1)[..., -self.top_k : -self.top_k + 1]
            lp = mx.where(lp < kth, mx.array(-float("inf")), lp)
        if 0.0 < self.top_p < 1.0:
            probs = mx.softmax(lp / self.temperature, axis=-1)
            order = mx.argsort(probs, axis=-1)
            sorted_probs = mx.take_along_axis(probs, order, axis=-1)
            cum = mx.cumsum(sorted_probs, axis=-1)
            keep_sorted = cum > (1.0 - self.top_p)
            keep = mx.zeros_like(keep_sorted)
            keep = mx.put_along_axis(keep, order, keep_sorted, axis=-1)
            lp = mx.where(keep, lp, mx.array(-float("inf")))
        return lp

    def _key(self, row: int, position: int):
        import mlx.core as mx

        mixed = (
            (self.seed * 0x9E3779B97F4A7C15)
            ^ ((int(row) + 1) * 0xBF58476D1CE4E5B9)
            ^ ((int(position) + 1) * 0x94D049BB133111EB)
        ) & 0x7FFFFFFFFFFFFFFF
        return mx.random.key(mixed)

    def sample_target(self, logprobs, *, row_ids, positions):
        import mlx.core as mx

        if logprobs.shape[0] != len(row_ids) or len(row_ids) != len(positions):
            raise ValueError("row_ids and positions must match logprobs batch size.")
        lp = self._filtered(logprobs)
        outs = [
            mx.random.categorical(lp[i : i + 1] / self.temperature, key=self._key(r, pos))
            for i, (r, pos) in enumerate(zip(row_ids, positions))
        ]
        return mx.concatenate(outs, axis=0)

    def __call__(self, logprobs):
        import mlx.core as mx

        return mx.random.categorical(self._filtered(logprobs) / self.temperature)


def _argmax(logprobs):
    import mlx.core as mx

    return mx.argmax(logprobs, axis=-1)


def processed_first_token(last_output, sampler, processors, context_tokens) -> int:
    """First token of an assisted wave: processors then a positioned draw
    (or argmax) over the final prefill logits — the same treatment every
    subsequent token gets, so the grammar FSM sees position 0 too."""
    import mlx.core as mx

    logits = last_output.logits[:, -1, :]
    if processors:
        ctx = mx.array([int(t) for t in context_tokens])
        for proc in processors:
            logits = proc(ctx, logits)
    logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
    if sampler is not None:
        tok = sampler.sample_target(logprobs, row_ids=[0], positions=[0])
    else:
        tok = _argmax(logprobs)
    return int(tok.reshape(-1).item())


def processed_walk(lm, target_hidden, draft_tokens, sampler, processors,
                   history, budget: int, base_position: int):
    """Sequential per-position acceptance walk with logits processors.

    Mirrors upstream `_speculative_walk_deferred_greedy` and adds the one
    thing it lacks: each position's target logits pass through the
    request's processor list with the token history ending at the
    previously emitted token — so a grammar FSM consumes tokens exactly
    once, in order, and positions past a rejection are never processed.
    Every emitted token is a draw from the processed target distribution.
    `history` is mutated in place as tokens are emitted.
    """
    import mlx.core as mx

    n_draft = draft_tokens.shape[1]
    draft_list = [int(x) for x in draft_tokens.reshape(-1).tolist()]
    accepted = 0
    new_tokens: List[int] = []

    for pos in range(n_draft + 1):
        logits = lm.speculative_logits_from_hidden(target_hidden[:, pos : pos + 1, :])
        if logits.ndim == 3 and logits.shape[1] == 1:
            logits = logits[:, 0, :]
        if processors:
            ctx = mx.array(history)
            for proc in processors:
                logits = proc(ctx, logits)
        logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
        if sampler is not None:
            tok_arr = sampler.sample_target(
                logprobs, row_ids=[0], positions=[int(base_position) + pos]
            )
        else:
            tok_arr = _argmax(logprobs)
        token = int(tok_arr.reshape(-1).item())

        if pos < n_draft and token == draft_list[pos]:
            accepted += 1
            if len(new_tokens) < budget:
                new_tokens.append(token)
                history.append(token)
            continue

        if len(new_tokens) < budget:
            new_tokens.append(token)
            history.append(token)
        break

    return accepted, new_tokens


def assisted_rounds(model, spec: SpecState, cache, hidden_tokens: List[int],
                    last_output, first_bonus: int, max_tokens: int, *,
                    sampler, processors, history):
    """Sampled/processed MTP round loop — upstream `_mtp_rounds`' exact
    structure (draft → verify → walk → bookkeeping → rollback → shared-kv
    slide) with two substitutions: the acceptance walk is the processed
    sequential walk above, and verify never pre-samples target tokens
    (`sample_target_tokens=False`) so the walk owns every draw. The RNG
    shuffle upstream does for un-positioned samplers is unnecessary here —
    drafting is greedy (deterministic) and target draws are positioned.
    `history` must already include the emitted first bonus.
    """
    import mlx.core as mx
    from mlx_vlm.speculative.common import _record_speculative_round
    from mlx_vlm.speculative.dflash import _dflash_block_total
    from mlx_vlm.speculative.mtp import (
        _buffer_mtp_target_cache,
        _mtp_cache_offset_max,
        _mtp_draft_hidden,
        _mtp_draft_position,
        _mtp_next_block_size,
        _mtp_verify_target,
        _slice_shared_kv_after_reject,
    )

    drafter = spec.drafter
    lm = getattr(model, "language_model", model)
    hidden = last_output.hidden_states[-1]
    shared_kv = getattr(last_output, "shared_kv_states", None) or {}
    _buffer_mtp_target_cache(cache, drafter, spec.block_size)
    prompt_ids = mx.array([[int(t) for t in hidden_tokens]])
    token_dtype = prompt_ids.dtype
    draw = sampler if sampler is not None else _argmax

    block_total = _dflash_block_total(drafter, spec.block_size)
    configured_block_total = int(getattr(drafter.config, "block_size", block_total))
    drafter.reset(model)
    draft_kwargs = (
        {"greedy": True}
        if getattr(drafter, "supports_greedy_draft_argmax", False)
        else {}
    )

    prefill_draft = getattr(drafter, "prefill_from_target_hidden", None)
    if callable(prefill_draft):
        prefill_draft(prompt_ids, hidden, int(first_bonus), draw, token_dtype, **draft_kwargs)

    if hidden.shape[1] > 1:
        hidden = hidden[:, -1:, :]
    hidden = _mtp_draft_hidden(lm, hidden)

    kv_offset = _mtp_cache_offset_max(cache)
    drafter.set_shared_kv(
        shared_kv, kv_offset, position=_mtp_draft_position(kv_offset), kv_valid_len=kv_offset
    )

    b = int(first_bonus)
    emitted = 1
    while emitted < max_tokens:
        bs = _mtp_next_block_size(
            drafter, block_total, configured_block_total, max_tokens - emitted + 1
        )
        if bs <= 1:
            break

        draft_tokens = drafter.draft_block(
            b, hidden, None, bs, draw, token_dtype, **draft_kwargs
        )
        mx.async_eval(draft_tokens)

        verify_input = mx.concatenate(
            [mx.array([[b]], dtype=token_dtype), draft_tokens], axis=1
        )
        verify = _mtp_verify_target(
            lm, verify_input, cache, draw, sample_target_tokens=False
        )
        accepted, new_tokens = processed_walk(
            lm,
            verify.hidden,
            draft_tokens,
            sampler,
            processors,
            history,
            max_tokens - emitted,
            base_position=emitted,
        )
        _record_speculative_round(drafter, accepted, bs - 1)

        budget_hit = False
        for tok in new_tokens:
            yield tok, None
            emitted += 1
            if emitted >= max_tokens:
                budget_hit = True
                break

        accept_verified = getattr(drafter, "accept_verified_tokens", None)
        if callable(accept_verified):
            accept_verified(
                verify.hidden, draft_tokens, accepted, new_tokens, draw, token_dtype, **draft_kwargs
            )

        hidden = _mtp_draft_hidden(lm, verify.hidden[:, accepted : accepted + 1, :])
        b = new_tokens[-1] if new_tokens else b

        rollback = getattr(lm, "rollback_speculative_cache", None)
        if accepted < bs - 1 and callable(rollback):
            rollback(cache, verify.gdn_states, accepted, bs)

        shared_kv = _slice_shared_kv_after_reject(
            verify.shared_kv_states, bs - (accepted + 1)
        )
        kv_offset += accepted + 1
        drafter.set_shared_kv(
            shared_kv, kv_offset, position=_mtp_draft_position(kv_offset), kv_valid_len=kv_offset
        )
        if budget_hit:
            return
        if emitted % 256 == 0:
            mx.clear_cache()

