"""Tests for the reasoning-preamble relocation.

Pure stdlib (a tiny fake jinja is enough to exercise the contract), so this
runs in CI through python-suites.test.ts without an mlx install.

The measured motivation, on qwen3.8-27b-q4: a thinking-on and a thinking-off
render of the same messages shared 3 tokens, because the reasoning preamble
sits above the tool block. After relocation they share 2,921.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import template_stability as tsb  # noqa: E402

FAILURES = []


def check(name, cond):
    if cond:
        print(f"  PASS {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL {name}")


# A faithful excerpt of the qwen3.5+ tools branch: preamble, then tools,
# then the system content, then the close.
REAL_SHAPE = """{%- set reasoning_instructions = '' %}
{%- if tools and tools is iterable and tools is not mapping %}
    {{- '<|im_start|>system\\n' }}
    {%- if reasoning_instructions %}
        {{- reasoning_instructions + '\\n\\n' }}
    {%- endif %}
    {{- "# Tools\\n\\nYou have access to the following functions:\\n\\n<tools>" }}
    {%- if messages[0].role == 'system' %}
        {%- set content = render_content(messages[0].content, false, true)|trim %}
        {%- if content %}
            {{- '\\n\\n' + content }}
        {%- endif %}
    {%- endif %}
    {{- '<|im_end|>\\n' }}
{%- endif %}
"""

patched = tsb.relocate_reasoning_preamble(REAL_SHAPE)
check("applies to the real template shape", patched is not None)
check(
    "preamble no longer emitted before the tool block",
    patched is not None
    and patched.index('"# Tools') < patched.index("'\\n\\n' + reasoning_instructions"),
)
check(
    "preamble now emitted after the system content",
    patched is not None
    and patched.index("'\\n\\n' + content") < patched.index("'\\n\\n' + reasoning_instructions"),
)
check(
    "emitted exactly once (not duplicated)",
    patched is not None and patched.count("reasoning_instructions }") == 1,
)

# Refusal cases: an unrecognised template must be left ALONE. A wrongly
# rendered prompt is far worse than a cold cache.
check("declines an unknown template", tsb.relocate_reasoning_preamble("{{ bogus }}") is None)
check("declines empty input", tsb.relocate_reasoning_preamble("") is None)
check("declines None-ish input", tsb.relocate_reasoning_preamble(None) is None)
check(
    "declines when the anchor appears twice (ambiguous)",
    tsb.relocate_reasoning_preamble(REAL_SHAPE + REAL_SHAPE) is None,
)


# ---- verification gate -------------------------------------------------
# The gate must reject a patch that changes CONTENT and one that fails to
# buy any prefix, because either would ship a worse prompt.
def _mk_render(patched_moves_preamble: bool, drop_word=False):
    """Fake renderer. The ORIGINAL always puts the preamble first (that is
    the defect); the PATCHED template is what varies per scenario."""

    def render(template, kwargs):
        pre = (
            "Reasoning effort is set to xhigh."
            if kwargs.get("enable_thinking", True)
            else ""
        )
        body = "TOOLS " * 200 + "ABOUT " * 50
        if template == "original":
            return f"{pre} {body}"
        if drop_word:
            body = body.replace("ABOUT ", "", 1)
        return f"{body} {pre}" if patched_moves_preamble else f"{pre} {body}"

    return render


def encode(text):
    return text.split()


ok, why = tsb.verify_prefix_stability(
    _mk_render(patched_moves_preamble=True), encode, "patched", "original"
)
check("accepts a patch that genuinely stabilises the prefix", ok)

ok_drop, _ = tsb.verify_prefix_stability(
    _mk_render(patched_moves_preamble=True, drop_word=True), encode, "patched", "original"
)
check("rejects a patch that changes content", not ok_drop)

ok_flat, _ = tsb.verify_prefix_stability(
    _mk_render(patched_moves_preamble=False), encode, "patched", "original"
)
check("rejects a patch that buys no prefix", not ok_flat)


def _raises(template, kwargs):
    raise ValueError("template exploded")


ok_raise, _ = tsb.verify_prefix_stability(_raises, encode, "patched", "original")
check("rejects a patch whose template raises", not ok_raise)

print(f"\n{len(FAILURES)} failure(s)")
sys.exit(1 if FAILURES else 0)
