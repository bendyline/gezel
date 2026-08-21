"""Unit tests for cache_seed (run with any python3 — no mlx needed).

No pytest harness is wired for the MLX python sidecar, so this is a
self-contained assert runner: it exits non-zero on failure.

    python3 cache_seed_test.py

Layer objects are duck-typed fakes implementing the same
`is_trimmable()` / `trim(n)` / `offset` protocol as mlx_lm's and
mlx_vlm's cache classes, so the seed planner's every branch is provable
without model weights.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cache_seed as cs  # noqa: E402


class FakeState:
    def __init__(self, token_ids, cache):
        self.token_ids = token_ids
        self.cache = cache


class FullLayer:
    """KVCache-shaped: always trimmable, offset = logical length."""

    def __init__(self, offset):
        self.offset = offset
        self.trim_calls = []

    def is_trimmable(self):
        return True

    def trim(self, n):
        n = min(self.offset, n)
        self.trim_calls.append(n)
        self.offset -= n
        return n


class WindowLayer(FullLayer):
    """RotatingKVCache-shaped: trimmable only before the window wraps."""

    def __init__(self, offset, max_size):
        super().__init__(offset)
        self.max_size = max_size

    def is_trimmable(self):
        return self.offset < self.max_size


class StateLayer:
    """Mamba-shaped: no offset, never trimmable."""

    def is_trimmable(self):
        return False


class ShortTrimLayer(FullLayer):
    """A lying layer that trims less than asked — must abort the plan."""

    def trim(self, n):
        return super().trim(min(n, 1))


def check(name, cond):
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok: {name}")


# ---- longest_common_prefix ----

check("lcp identical", cs.longest_common_prefix([1, 2, 3], [1, 2, 3]) == 3)
check("lcp divergent", cs.longest_common_prefix([1, 2, 3], [1, 9, 3]) == 1)
check("lcp empty", cs.longest_common_prefix([], [1]) == 0)
check("lcp prefix", cs.longest_common_prefix([1, 2], [1, 2, 3, 4]) == 2)

# ---- stable_snapshot_boundary ----

check(
    "stable warm boundary backs off from synthetic-user divergence",
    cs.stable_snapshot_boundary(
        [1, 2, 3, 4, 5, 6, 7],
        [1, 2, 3, 4, 5, 9, 9],
        2,
    )
    == 3,
)
check(
    "stable warm boundary clamps at zero",
    cs.stable_snapshot_boundary([1, 2], [1, 9], 16) == 0,
)

# ---- plan_snapshot_segments ----

snapshot_plan = cs.plan_snapshot_segments(list(range(100)), 0, 100, None, 16)
check(
    "normal snapshot plan cuts once at end minus margin",
    snapshot_plan.target == 84
    and list(map(len, snapshot_plan.segments)) == [84, 16],
)
snapshot_plan = cs.plan_snapshot_segments(list(range(50)), 50, 100, None, 16)
check(
    "snapshot plan subtracts reused absolute prefix",
    snapshot_plan.target == 84
    and list(map(len, snapshot_plan.segments)) == [34, 16],
)
snapshot_plan = cs.plan_snapshot_segments(list(range(100)), 0, 100, 60, 16)
check(
    "warm snapshot plan honors custom stable target",
    snapshot_plan.target == 60
    and list(map(len, snapshot_plan.segments)) == [60, 40],
)
snapshot_plan = cs.plan_snapshot_segments(list(range(10)), 90, 100, 84, 16)
check(
    "already-reused target needs no new segment edge",
    snapshot_plan.target == 84 and len(snapshot_plan.segments) == 1,
)
snapshot_plan = cs.plan_snapshot_segments(list(range(100)), 0, 100, 0, 16)
check(
    "explicit zero disables snapshot instead of choosing default",
    snapshot_plan.target is None and len(snapshot_plan.segments) == 1,
)

# ---- snapshot_matches_prompt ----

check(
    "snapshot accepts exact per-sequence tokens",
    cs.snapshot_matches_prompt([FullLayer(3)], [1, 2, 3], [1, 2, 3, 4], 3),
)
check(
    "snapshot rejects right-padding leakage",
    not cs.snapshot_matches_prompt(
        [FullLayer(4)], [1, 2, 3, 0], [1, 2, 3, 4], 3
    ),
)
check(
    "snapshot rejects offset drift",
    not cs.snapshot_matches_prompt([FullLayer(2)], [1, 2, 3], [1, 2, 3, 4], 3),
)
check(
    "snapshot accepts offset-less state cache when tokens align",
    cs.snapshot_matches_prompt([StateLayer()], [1, 2, 3], [1, 2, 3, 4], 3),
)

# ---- seed_from_state: fresh paths ----

plan = cs.seed_from_state(None, [1, 2, 3])
check("no state → fresh", plan.mode == "fresh" and plan.caches is None and plan.segment == [1, 2, 3])

plan = cs.seed_from_state(FakeState(None, None), [1, 2, 3])
check("empty state → fresh", plan.mode == "fresh")

plan = cs.seed_from_state(FakeState([9, 9], [FullLayer(2)]), [1, 2, 3])
check("no overlap → fresh", plan.mode == "fresh-no-overlap" and plan.reused == 0)

# ---- extension (cached is exact prefix of prompt) ----

layers = [FullLayer(4), WindowLayer(4, 512)]
state = FakeState([1, 2, 3, 4], layers)
plan = cs.seed_from_state(state, [1, 2, 3, 4, 5, 6])
check("extension mode", plan.mode == "extension")
check("extension segment", plan.segment == [5, 6])
check("extension reused", plan.reused == 4)
check("extension all_tokens", plan.all_tokens == [1, 2, 3, 4])
check("extension no trim", layers[0].trim_calls == [] and layers[1].trim_calls == [])
check("extension keeps token_ids", state.token_ids == [1, 2, 3, 4])

# A wrapped window layer is fine on the extension path (no trim needed).
plan = cs.seed_from_state(
    FakeState([1, 2, 3, 4], [FullLayer(4), WindowLayer(4, 2)]), [1, 2, 3, 4, 5]
)
check("extension tolerates wrapped window", plan.mode == "extension" and plan.segment == [5])

# Offset drift on the extension path must refuse reuse.
plan = cs.seed_from_state(FakeState([1, 2, 3, 4], [FullLayer(3)]), [1, 2, 3, 4, 5])
check("extension offset drift → fresh", plan.mode == "fresh-inconsistent" and plan.caches is None)

# Offset-less layers (Mamba-style) pass the consistency check on extension.
plan = cs.seed_from_state(FakeState([1, 2], [StateLayer()]), [1, 2, 3])
check("extension with offset-less layer", plan.mode == "extension" and plan.segment == [3])

# ---- divergence with trimmable layers → trim to LCP ----

layers = [FullLayer(6), WindowLayer(6, 512)]
state = FakeState([1, 2, 3, 4, 9, 9], layers)
plan = cs.seed_from_state(state, [1, 2, 3, 4, 5, 6, 7])
check("trimmed mode", plan.mode == "trimmed")
check("trimmed segment", plan.segment == [5, 6, 7])
check("trimmed reused", plan.reused == 4)
check("trimmed all_tokens", plan.all_tokens == [1, 2, 3, 4])
check("trimmed layer offsets", layers[0].offset == 4 and layers[1].offset == 4)
check("trimmed trim calls", layers[0].trim_calls == [2] and layers[1].trim_calls == [2])
check("trimmed truncates token_ids", state.token_ids == [1, 2, 3, 4])

# ---- divergence with a wrapped window layer → fresh, untouched ----

layers = [FullLayer(6), WindowLayer(6, 4)]
state = FakeState([1, 2, 3, 4, 9, 9], layers)
plan = cs.seed_from_state(state, [1, 2, 3, 4, 5, 6, 7])
check("untrimmable mode", plan.mode == "fresh-untrimmable")
check("untrimmable full prefill", plan.segment == [1, 2, 3, 4, 5, 6, 7] and plan.caches is None)
check("untrimmable no mutation", layers[0].trim_calls == [] and state.token_ids == [1, 2, 3, 4, 9, 9])

# ---- identical prompt (regenerate): cap reuse at len(full) - 1 ----

layers = [FullLayer(4)]
state = FakeState([1, 2, 3, 4], layers)
plan = cs.seed_from_state(state, [1, 2, 3, 4])
check("regenerate mode", plan.mode == "trimmed")
check("regenerate segment", plan.segment == [4])
check("regenerate reused", plan.reused == 3)
check("regenerate layer offset", layers[0].offset == 3)

plan = cs.seed_from_state(FakeState([1, 2, 3, 4], [WindowLayer(4, 2)]), [1, 2, 3, 4])
check("regenerate untrimmable → fresh", plan.mode == "fresh-untrimmable")

# ---- a lying trim aborts before poisoning the reuse ----

layers = [ShortTrimLayer(6)]
state = FakeState([1, 2, 3, 4, 9, 9], layers)
plan = cs.seed_from_state(state, [1, 2, 3, 4, 5])
check("short trim → fresh", plan.mode == "fresh-untrimmable" and plan.caches is None)

# ---- trim_layers offset pre-check refuses before mutating anything ----

a, b = FullLayer(6), FullLayer(3)
check("trim_layers offset mismatch", cs.trim_layers([a, b], 4) is False)
check("trim_layers no partial mutation", a.trim_calls == [] and b.trim_calls == [])
check("trim_layers zero is a no-op", cs.trim_layers([a], 0) is True and a.trim_calls == [])

# ---- probe_needs_prompt_snapshot ----


class ModelWith:
    def __init__(self, layers):
        self._layers = layers

    def make_cache(self):
        return self._layers


class ModelRaising:
    def make_cache(self):
        raise RuntimeError("boom")


check("probe windowed → True", cs.probe_needs_prompt_snapshot(ModelWith([FullLayer(0), WindowLayer(0, 512)])))
check("probe full-attention → False", not cs.probe_needs_prompt_snapshot(ModelWith([FullLayer(0), FullLayer(0)])))
check("probe state-layer → True", cs.probe_needs_prompt_snapshot(ModelWith([FullLayer(0), StateLayer()])))
check("probe empty → False", not cs.probe_needs_prompt_snapshot(ModelWith([])))
check("probe no make_cache → False", not cs.probe_needs_prompt_snapshot(object()))
check("probe raising → False", not cs.probe_needs_prompt_snapshot(ModelRaising()))

# ---- serial_reset_needed ----

wrapped = [FullLayer(6), WindowLayer(6, 4)]
check(
    "serial divergent untrimmable → reset",
    cs.serial_reset_needed([1, 2, 3, 4, 9, 9], wrapped, [[1, 2, 3, 4, 5, 6, 7]]),
)
check(
    "serial extension → keep",
    not cs.serial_reset_needed([1, 2, 3], wrapped, [[1, 2, 3, 4]]),
)
check(
    "serial trimmable divergence → keep (upstream trims coherently)",
    not cs.serial_reset_needed([1, 2, 9], [FullLayer(3)], [[1, 2, 3, 4]]),
)
check(
    "serial bos variant rescues the match",
    not cs.serial_reset_needed([0, 1, 2, 3], wrapped, [[1, 2, 3, 4], [0, 1, 2, 3, 4]]),
)
check(
    "serial empty state → keep",
    not cs.serial_reset_needed([], wrapped, [[1, 2, 3]]),
)
check(
    "serial no variants → reset (cannot verify)",
    cs.serial_reset_needed([1, 2, 3], wrapped, []),
)

# --- seed diagnostics -------------------------------------------------
# A full re-prefill is the single most expensive cache outcome, and the
# ONLY numbers that say why are the divergence point and how much was
# held. They were computed and discarded until 2026-08-19, which is why
# 59 untrimmable turns across a 15-trial arm could not be attributed to
# either prompt churn or an over-far snapshot boundary.


class _Untrimmable:
    """Stands in for ArraysCache: qwen3.8 builds one per linear-attention
    layer (48 of its 64), and a recurrent state cannot be rewound.

    `offset` must match the cached token count or seed_from_state reports
    `fresh-inconsistent` before it ever reaches the trim decision.
    """

    def __init__(self, offset=4):
        self.offset = offset

    def is_trimmable(self):
        return False


class _State:
    def __init__(self, tokens, layers):
        self.token_ids = list(tokens)
        self.cache = list(layers)


_plan = cs.seed_from_state(_State([1, 2, 3, 4], [_Untrimmable()]), [1, 2, 9, 9, 9])
check("untrimmable divergence reports mode", _plan.mode == "fresh-untrimmable")
check("untrimmable divergence reports lcp", _plan.lcp == 2)
check("untrimmable divergence reports cached length", _plan.cached_len == 4)
check("untrimmable divergence still reuses nothing", _plan.reused == 0)

# --- snapshot boundary vs an untrimmable tail ------------------------
# Relocating the reasoning preamble took the divergence point from token 3
# to 6,830 of a 6,857-token cache (99.6% match) and still reused NOTHING,
# because an untrimmable cache needs lcp == n exactly. Saving at the last
# invariant position is what converts that 99.6% into an extension.

_stable = cs.stable_snapshot_boundary([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 9, 9], margin=0)
check("boundary is the divergence point of the two renders", _stable == 4)
check(
    "margin backs the boundary off",
    cs.stable_snapshot_boundary([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 9, 9], margin=2) == 2,
)
check(
    "no shared prefix disables capture (0, not negative)",
    cs.stable_snapshot_boundary([7, 8], [1, 2], margin=2) == 0,
)

# A state saved AT the stable boundary extends cleanly next turn; a state
# saved past it does not, and on an untrimmable stack that costs everything.
_at = cs.seed_from_state(_State([1, 2, 3, 4], [_Untrimmable()]), [1, 2, 3, 4, 9, 9])
check("state saved at the boundary extends", _at.mode == "extension")
check("state saved at the boundary reuses all of it", _at.reused == 4)

_past = cs.seed_from_state(
    _State([1, 2, 3, 4, 5], [_Untrimmable(offset=5)]), [1, 2, 3, 4, 9, 9]
)
check("state saved one token past the boundary reuses NOTHING", _past.reused == 0)
check("...and reports why", _past.mode == "fresh-untrimmable")

print("all cache_seed tests passed")
