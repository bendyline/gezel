"""String-level tests for tool_grammar (run with the MLX venv python).

No pytest harness is wired for the MLX python sidecar, so this is a
self-contained assert runner: it exits non-zero on failure.

    "$HOME/.gezel-dev/engines/uv/venvs/mlx/bin/python3" tool_grammar_test.py

Model-independent by design (only needs llguidance, a transitive mlx-vlm
dep). The token-level proof that the grammar actually accepts a valid call
and REJECTS hallucinated names / param keys lives in
tool_grammar_modeltest.py, which needs an installed model's tokenizer.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tool_grammar as tg  # noqa: E402
from llguidance import LLMatcher  # noqa: E402


def _tool(name, props):
    return {
        "type": "function",
        "function": {
            "name": name,
            "parameters": {"type": "object", "properties": props},
        },
    }


# create_project + writeFile declare params; list_projects declares none.
TOOLS = [
    _tool("create_project", {"name": {"type": "string"}, "description": {"type": "string"}}),
    _tool("list_projects", {}),
    _tool("writeFile", {"path": {"type": "string"}, "content": {"type": "string"}}),
]


def test_name_alternation_longest_first_and_escaped():
    assert tg.tool_name_alternation(["list", "list_projects"]) == "list_projects|list"
    assert tg.tool_name_alternation(["a.b"]) == r"a\.b"
    assert tg.tool_name_alternation(["", "x"]) == "x"


def test_tier2_is_default_and_well_formed():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes"})  # no mode → tier 2
    assert g is not None
    assert LLMatcher.validate_grammar(g) == ""
    for marker in ["<think>", "</think>", "<tool_call>", "</tool_call>", "<function="]:
        assert marker in g, marker


def test_tier2_constrains_function_names_and_param_keys():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes", "mode": "name-and-params"})
    # Function names appear (as branch literals).
    assert "create_project" in g and "writeFile" in g and "list_projects" in g
    # Declared param keys appear (as constrained key enums).
    for key in ["name", "description", "path", "content"]:
        assert key in g, key
    # A hallucinated key / function never appears.
    assert "hallucinated_param" not in g
    assert "delete_everything" not in g


def test_name_only_mode_is_simpler_tier1():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes", "mode": "name-only"})
    assert g is not None
    assert LLMatcher.validate_grammar(g) == ""
    # Tier 1 pins the name via a single NAME enum and does NOT branch
    # per-tool or constrain <parameter=> keys.
    assert "NAME:" in g and "fn_0" not in g
    assert "create_project" in g and "writeFile" in g


def test_gemma_name_only_well_formed():
    # Gemma is always name-only (tier 1), regardless of requested mode.
    g = tg.build_grammar_string(TOOLS, {"format": "gemma"})
    assert g is not None
    assert LLMatcher.validate_grammar(g) == ""
    # Single NAME enum, no per-tool fn_ branches (tier 1).
    assert "NAME:" in g and "fn_0" not in g
    # Gemma call framing + the string-value delimiter terminal are present.
    for marker in ["<|tool_call>", "<tool_call|>", '<|"|>', "call:"]:
        assert marker in g, marker
    # Function names are pinned; reasoning/channel tokens are allowed in seg so
    # the grammar never blocks Gemma's thinking.
    assert "create_project" in g and "writeFile" in g
    assert "<|channel>" in g and "<|think|>" in g
    # Requested mode is ignored for gemma — name-and-params still yields tier 1.
    assert tg.build_grammar_string(TOOLS, {"format": "gemma", "mode": "name-and-params"}) == g


def test_glm_name_only_well_formed():
    # GLM is always name-only (tier 1), regardless of requested mode.
    g = tg.build_grammar_string(TOOLS, {"format": "glm"})
    assert g is not None
    assert LLMatcher.validate_grammar(g) == ""
    # Single NAME enum, no per-tool fn_ branches (tier 1).
    assert "NAME:" in g and "fn_0" not in g
    # GLM call framing: `<tool_call>`/`</tool_call>` special-token envelope,
    # bare NAME right after the opener (no `<function=` wrapper).
    assert "<tool_call>" in g and "</tool_call>" in g
    assert "<function=" not in g
    # Function names are pinned; reasoning tokens are allowed in seg so the
    # grammar never blocks GLM's <think> reasoning.
    assert "create_project" in g and "writeFile" in g
    assert "<think>" in g
    # Requested mode is ignored for glm — name-and-params still yields tier 1.
    assert tg.build_grammar_string(TOOLS, {"format": "glm", "mode": "name-and-params"}) == g


def test_unsupported_or_empty_inputs_degrade_to_none():
    for fmt in ["json-envelope", "qwen-xml", "mistral-v3", "made-up"]:
        assert tg.build_grammar_string(TOOLS, {"format": fmt}) is None, fmt
    assert tg.build_grammar_string([], {"format": "hermes"}) is None
    assert tg.build_grammar_string([], {"format": "gemma"}) is None
    assert tg.build_grammar_string([], {"format": "glm"}) is None
    assert tg.build_grammar_string(TOOLS, {}) is None
    assert tg.build_grammar_string(None, {"format": "hermes"}) is None


def test_safe_processor_disables_on_error_instead_of_raising():
    class Boom:
        def __call__(self, input_ids, logits):
            raise ValueError("ParserTooComplex")

    sentinel = object()
    proc = tg.SafeToolGrammarProcessor(Boom())
    assert proc(None, sentinel) is sentinel
    assert proc.disabled is True
    assert proc(None, sentinel) is sentinel


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
