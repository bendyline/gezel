"""batch_processors — per-sequence logits-processor lists for mlx_lm's
BatchGenerator that stay aligned across waves.

mlx_lm 0.31.3's `GenerationBatch.filter()` trims `logits_processors` only
`if any(self.logits_processors)`. Once every live sequence carries `[]`, the
finished ones' entries survive the filter, and the next wave's sequences are
appended after them at the wrong index: a request's tool grammar, think
budget or response format then ran for its first token only, and in a mixed
wave one sequence's grammar could land on another's output. Caught
2026-10-13: a JSON-schema request right after a plain one came back as free
text. Giving every sequence a non-empty list keeps `any()` true, so the
filter always trims. The pass-through costs nothing measurable (A/B on
gemma4-e4b, 2026-10-14: 64.3 vs 62.7 tok/s median, within noise).
"""

from typing import Any, Callable, List, Sequence


def pass_through_logits(tokens: Any, logits: Any) -> Any:
    """A no-op processor that keeps a sequence's processor list non-empty."""
    return logits


def per_sequence_processors(processors: Sequence[Callable[[Any, Any], Any]]) -> List[Callable[[Any, Any], Any]]:
    """The processor list to hand BatchGenerator for one sequence; never empty."""
    return list(processors) or [pass_through_logits]
