"""Make a model's chat template produce a cache-stable prompt prefix.

The problem
-----------
Prompt-prefix reuse needs the leading tokens to be byte-identical across
turns. Qwen 3.5+ templates emit the reasoning-effort preamble as the FIRST
thing inside the system block, above the tool schemas and above the gezel's
about/project text::

    <|im_start|>system\\n
    Reasoning effort is set to xhigh. ...      <- changes per turn
    # Tools ... <tools> ... </tools>           <- stable per tool roster
    <gezel about / project docs>               <- stable per gezel+project
    <|im_end|>

Gezel varies reasoning per turn on purpose — a constrained "write the file
now" turn suppresses thinking, an ordinary turn does not — so that first
line changes shape between consecutive turns of the same session. Measured
on qwen3.8-27b-q4, a thinking-on and a thinking-off render of the SAME
messages share **3 tokens**. Everything downstream, including a multi-
thousand-token tool block, is re-prefilled every time the mode flips.

Moving the preamble below the stable content fixes it: the same pair then
shares 3,029 of 3,071 tokens (99%).

Why a transform and not a curated template
------------------------------------------
A hand-maintained copy of each model's jinja goes stale silently the next
time the model ships a template revision, and it would have to be written
per model. This applies a narrow, anchored edit to whatever template the
model actually shipped, then VERIFIES the result behaves — and falls back
to the original template on any doubt. A prompt that renders wrong is far
worse than a prompt that caches badly.

Verification checks the property we want rather than the mechanism:
  * two renders that differ only in reasoning mode share a long prefix, and
  * the patched render contains the same content as the original (same
    token multiset), so nothing was dropped or duplicated.
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Callable, Optional, Tuple

# The preamble emission at the top of the tools branch, and the tail where
# the system content is closed. Anchored on exact source so a template that
# has been revised upstream simply fails to match and keeps its original
# behaviour instead of being edited on a guess.
_EARLY_EMIT = """    {%- if reasoning_instructions %}
        {{- reasoning_instructions + '\\n\\n' }}
    {%- endif %}
    {{- "# Tools"""

_EARLY_REPLACEMENT = """    {{- "# Tools"""

_TAIL = """    {%- if messages[0].role == 'system' %}
        {%- set content = render_content(messages[0].content, false, true)|trim %}
        {%- if content %}
            {{- '\\n\\n' + content }}
        {%- endif %}
    {%- endif %}
    {{- '<|im_end|>\\n' }}"""

_TAIL_REPLACEMENT = """    {%- if messages[0].role == 'system' %}
        {%- set content = render_content(messages[0].content, false, true)|trim %}
        {%- if content %}
            {{- '\\n\\n' + content }}
        {%- endif %}
    {%- endif %}
    {%- if reasoning_instructions %}
        {{- '\\n\\n' + reasoning_instructions }}
    {%- endif %}
    {{- '<|im_end|>\\n' }}"""


def relocate_reasoning_preamble(template_src: str) -> Optional[str]:
    """Move the reasoning preamble below the tool + system content.

    Returns the rewritten template, or None when the anchors do not match
    exactly once each — meaning this template is not the shape we know how
    to edit, and the caller must keep the original.
    """
    if not template_src:
        return None
    if template_src.count(_EARLY_EMIT) != 1 or template_src.count(_TAIL) != 1:
        return None
    patched = template_src.replace(_EARLY_EMIT, _EARLY_REPLACEMENT, 1)
    patched = patched.replace(_TAIL, _TAIL_REPLACEMENT, 1)
    return patched if patched != template_src else None


def _lcp(a, b) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def verify_prefix_stability(
    render: Callable[[str, dict], str],
    encode: Callable[[str], Any],
    patched: str,
    original: str,
    min_gain: int = 64,
) -> Tuple[bool, str]:
    """Prove the patched template is both SAFER and no less complete.

    `render(template, kwargs)` must apply `template` to a fixed probe
    conversation; `encode` tokenizes. Returns (ok, reason).
    """
    on = {"enable_thinking": True, "reasoning_effort": "xhigh"}
    off = {"enable_thinking": False, "reasoning_effort": "low"}
    try:
        p_on, p_off = render(patched, on), render(patched, off)
        o_on, o_off = render(original, on), render(original, off)
    except Exception as exc:  # noqa: BLE001 — a template that raises is unusable
        return False, f"patched template failed to render: {exc}"

    # 1. Nothing lost or duplicated: same tokens, only reordered.
    if Counter(encode(p_on)) != Counter(encode(o_on)):
        return False, "patched render changed content, not just order"
    if Counter(encode(p_off)) != Counter(encode(o_off)):
        return False, "patched render changed content (thinking-off), not just order"

    # 2. The actual goal: a reasoning-mode flip must stop nuking the prefix.
    before = _lcp(encode(o_on), encode(o_off))
    after = _lcp(encode(p_on), encode(p_off))
    if after < before + min_gain:
        return False, f"no prefix gain (before={before} after={after})"
    return True, f"prefix across reasoning modes {before} -> {after} tokens"
