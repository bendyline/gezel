"""Thinking-budget enforcement for MLX generation.

llama-server enforces `tuning.reasoning.thinkingBudget` via its
`--reasoning-budget` flag (forced `</think>` closure). The MLX tuning map
dropped the value (`'reasoning.thinkingBudget': null`), so qwen-family
models on MLX think UNBOUNDED — wild-caught 2026-08-05: qwen3.6-27b spent
44,644 chars (~11K tokens) inside one think block with 70 hesitation
markers ("Wait, ...") against a configured budget of 4,096, and the trial
still failed. Sampling changes (temp 0.6, mild rp) measurably did NOT
reduce the rumination; a hard budget is the lever that works on llama.

Mechanism: a logits processor (same hook as the tool grammar) tracks
whether generation is inside a think block by watching the generated
token ids. Once the block exceeds the budget, every token except
`</think>` is masked, forcing closure exactly like llama-server. Each
think block gets its own budget (interleaved thinking re-opens are
re-budgeted, not exempted).

Safety posture mirrors SafeToolGrammarProcessor: anything unexpected
disables enforcement for the rest of the turn rather than killing it.
"""

from __future__ import annotations

from typing import Any, Optional


class ThinkBudgetProcessor:
    def __init__(
        self,
        open_id: int,
        close_id: int,
        budget: int,
        opens_in_think: bool,
    ) -> None:
        self.open_id = open_id
        self.close_id = close_id
        self.budget = max(1, int(budget))
        self.in_think = opens_in_think
        self.count = 0
        self.disabled = False
        self.forced = False

    def __call__(self, input_ids: Any, logits: Any) -> Any:
        if self.disabled:
            return logits
        try:
            last: Optional[int] = None
            if input_ids is not None and len(input_ids) > 0:
                last = int(input_ids[-1])
            if last is not None:
                if last == self.open_id:
                    self.in_think = True
                    self.count = 0
                elif last == self.close_id:
                    self.in_think = False
                elif self.in_think:
                    self.count += 1
            if self.in_think and self.count >= self.budget:
                import mlx.core as mx

                if not self.forced:
                    self.forced = True
                    print(
                        f"[think-budget] budget {self.budget} reached — forcing </think>",
                        flush=True,
                    )
                masked = mx.full(logits.shape, -1e9, dtype=logits.dtype)
                masked[..., self.close_id] = 0.0
                return masked
            return logits
        except Exception as exc:  # noqa: BLE001 - defensive, mirror grammar posture
            print(
                f"[think-budget] processor error; disabling for the rest of this "
                f"turn: {exc}",
                flush=True,
            )
            self.disabled = True
            return logits


def build_think_budget_processor(
    tokenizer: Any,
    budget: Any,
    opens_in_think: bool,
) -> Optional[ThinkBudgetProcessor]:
    """Resolve `<think>`/`</think>` as single special tokens; None when the
    model has no single-token think tags (gemma's channel format, plain
    instruct models) or the budget is absent/invalid — enforcement simply
    doesn't apply there."""
    try:
        b = int(budget)
    except (TypeError, ValueError):
        return None
    if b <= 0:
        return None
    try:
        open_ids = tokenizer.encode("<think>", add_special_tokens=False)
        close_ids = tokenizer.encode("</think>", add_special_tokens=False)
    except Exception:  # noqa: BLE001
        return None
    if len(open_ids) != 1 or len(close_ids) != 1:
        return None
    print(
        f"[think-budget] armed budget={b} opens_in_think={opens_in_think}",
        flush=True,
    )
    return ThinkBudgetProcessor(
        open_id=int(open_ids[0]),
        close_id=int(close_ids[0]),
        budget=b,
        opens_in_think=opens_in_think,
    )
