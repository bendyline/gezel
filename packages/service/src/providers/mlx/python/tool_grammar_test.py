"""String-level tests for tool_grammar (run with the MLX venv python).

No pytest harness is wired for the MLX python sidecar, so this is a
self-contained assert runner: it exits non-zero on failure.

    "$HOME/.gezel-dev/engines/uv/venvs/mlx/bin/python3" tool_grammar_test.py

Model-independent by design. Its contract/shape assertions run on bare
Python; when llguidance is installed it also compiles every generated grammar.
The token-level proof that the grammar actually accepts a valid call and
REJECTS hallucinated names / param keys / missing required params lives in
tool_grammar_modeltest.py, which needs an installed model's tokenizer.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tool_grammar as tg  # noqa: E402

try:
    from llguidance import LLMatcher  # type: ignore
except ModuleNotFoundError:
    LLMatcher = None


def _assert_valid(grammar):
    if LLMatcher is not None:
        assert LLMatcher.validate_grammar(grammar) == ""


def _tool(name, props, required=()):
    parameters = {"type": "object", "properties": props}
    if required:
        parameters["required"] = list(required)
    return {
        "type": "function",
        "function": {
            "name": name,
            "parameters": parameters,
        },
    }


# create_project + write_file declare params; list_projects declares none.
# All flat scalars — no tool here wants an object/array argument.
TOOLS = [
    _tool(
        "create_project",
        {"name": {"type": "string"}, "description": {"type": "string"}},
        required=("name",),
    ),
    _tool("list_projects", {}),
    _tool(
        "write_file",
        {"path": {"type": "string"}, "content": {"type": "string"}},
        required=("path", "content"),
    ),
    _tool(
        "wikipedia_read",
        {
            "title": {"type": "string"},
            "language": {"type": "string"},
            "maxChars": {"type": "integer"},
        },
        required=("title",),
    ),
    _tool(
        "wikipedia_search",
        {
            "query": {"type": "string"},
            "limit": {"type": "integer"},
            "language": {"type": "string"},
        },
        required=("query",),
    ),
]

# DocBlocks-shaped: `source` is an object and `targets` is an array, neither
# of which the flat `<parameter=KEY>text</parameter>` shape can carry.
STRUCTURAL_TOOLS = TOOLS + [
    _tool(
        "convert_document",
        {
            "source": {
                "type": "object",
                "properties": {"kind": {"type": "string"}, "path": {"type": "string"}},
            },
            "targets": {"type": "array", "items": {"type": "object"}},
            "autoTemplates": {"type": "boolean"},
        },
        required=("source", "targets"),
    ),
]


def test_name_alternation_longest_first_and_escaped():
    assert tg.tool_name_alternation(["list", "list_projects"]) == "list_projects|list"
    assert tg.tool_name_alternation(["a.b"]) == r"a\.b"
    assert tg.tool_name_alternation(["", "x"]) == "x"


def test_tier2_is_default_and_well_formed():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes"})  # no mode → tier 2
    assert g is not None
    _assert_valid(g)
    for marker in ["<think>", "</think>", "<tool_call>", "</tool_call>", "<function="]:
        assert marker in g, marker


def test_tier2_constrains_function_names_and_param_keys():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes", "mode": "name-and-params"})
    # Function names appear (as branch literals).
    assert "create_project" in g and "write_file" in g and "list_projects" in g
    # Declared param keys appear (as constrained key enums).
    for key in ["name", "description", "path", "content"]:
        assert key in g, key
    # A hallucinated key / function never appears.
    assert "hallucinated_param" not in g
    assert "delete_everything" not in g


def test_tier2_encodes_required_param_presence():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes", "mode": "name-and-params"})
    # One-required-field tools get a state that cannot reach the accepting
    # all-keys loop until the required literal has appeared.
    assert 'POPEN "name>" pval params_0_s_1' in g
    assert 'POPEN "title>" pval params_3_s_1' in g
    assert 'POPEN "query>" pval params_4_s_1' in g
    # Multiple required fields get subset states so either declared order is
    # accepted without allowing the function to close early.
    assert 'POPEN "path>" pval params_2_s_1' in g
    assert 'POPEN "content>" pval params_2_s_2' in g
    assert "params_2_s_3: ( POPEN k_2" in g


def test_wide_required_schema_uses_bounded_canonical_order():
    wide = _tool(
        "wide",
        {f"field{i}": {"type": "string"} for i in range(6)},
        required=tuple(f"field{i}" for i in range(6)),
    )
    g = tg.build_grammar_string([wide], {"format": "hermes"})
    assert g is not None
    _assert_valid(g)
    # No 2**6 state explosion: the fallback pins the schema's canonical order.
    assert "params_0_s_" not in g
    for i in range(6):
        assert f'POPEN "field{i}>" pval' in g


def test_large_mixed_roster_stays_compilable():
    """A real Researcher turn can advertise 100+ tools.

    Keep a roster-sized guard here so required-field state tracking or the
    structural JSON union cannot quietly cross llguidance's grammar-complexity
    ceiling while passing tiny unit fixtures.
    """
    roster = [
        _tool(
            f"flat_tool_{i}",
            {
                "subject": {"type": "string"},
                "limit": {"type": "integer"},
                "language": {"type": "string"},
            },
            required=("subject",),
        )
        for i in range(72)
    ]
    roster.extend(
        _tool(
            f"structural_tool_{i}",
            {
                "source": {"type": "object"},
                "targets": {"type": "array"},
                "mode": {"type": "string", "enum": ["safe", "fast"]},
            },
            required=("source", "targets"),
        )
        for i in range(32)
    )
    g = tg.build_grammar_string(roster, {"format": "hermes"})
    assert g is not None
    _assert_valid(g)
    assert len(g) < 250_000


def test_name_only_mode_is_simpler_tier1():
    g = tg.build_grammar_string(TOOLS, {"format": "hermes", "mode": "name-only"})
    assert g is not None
    _assert_valid(g)
    # Tier 1 pins the name via a single NAME enum and does NOT branch
    # per-tool or constrain <parameter=> keys.
    assert "NAME:" in g and "fn_0" not in g
    assert "create_project" in g and "write_file" in g


def test_structural_params_detection():
    assert tg._has_structural_params(TOOLS) is False
    assert tg._has_structural_params(STRUCTURAL_TOOLS) is True
    # A `$ref` we can't resolve counts as structural: widening the grammar
    # is harmless, keeping the model pinned in an unrepresentable shape
    # is not.
    assert tg._has_structural_params([_tool("x", {"a": {"$ref": "#/$defs/Y"}})]) is True
    # anyOf branches are inspected, not just the top-level `type`.
    assert (
        tg._has_structural_params(
            [_tool("x", {"a": {"anyOf": [{"type": "string"}, {"type": "array"}]}})]
        )
        is True
    )


def test_json_escape_only_when_a_tool_wants_structure():
    """The `<parameter=KEY>text</parameter>` shape is a flat KEY→text map and
    cannot carry a nested object/array. When a wired tool declares one, the
    grammar must also admit a raw JSON body inside `<tool_call>` — otherwise
    the model is pinned into a shape in which no valid call exists and it
    retries forever (wild-caught: 19 attempts on one craftbook step).
    """
    for mode in ("name-and-params", "name-only"):
        flat = tg.build_grammar_string(TOOLS, {"format": "hermes", "mode": mode})
        structural = tg.build_grammar_string(
            STRUCTURAL_TOOLS, {"format": "hermes", "mode": mode}
        )
        _assert_valid(flat)
        _assert_valid(structural)
        # Flat rosters keep the tight grammar — no escape hatch, no cost.
        assert "json_call" not in flat, mode
        assert "json_call" in structural, mode
        raw = tg._hermes_json_branch(STRUCTURAL_TOOLS)
        assert '"const":"convert_document"' in raw, mode
        assert '"required":["source","targets"]' in raw, mode
        assert '"const":"totally_fake"' not in raw, mode
        # The Hermes branch survives alongside it, so function names stay
        # pinned when the model does use the markup shape. Structural tools
        # themselves are JSON-only: their values cannot survive flat markup.
        assert "<function=" in structural, mode
        assert "create_project" in structural, mode
        assert "totally_fake" not in structural, mode
        if mode == "name-and-params":
            assert '"convert_document>" params_' not in structural, mode


def test_gemma_name_only_well_formed():
    # Gemma is always name-only (tier 1), regardless of requested mode.
    g = tg.build_grammar_string(TOOLS, {"format": "gemma"})
    assert g is not None
    _assert_valid(g)
    # Single NAME enum, no per-tool fn_ branches (tier 1).
    assert "NAME:" in g and "fn_0" not in g
    # Gemma call framing + the string-value delimiter terminal are present.
    for marker in ["<|tool_call>", "<tool_call|>", '<|"|>', "call:"]:
        assert marker in g, marker
    # Function names are pinned; reasoning/channel tokens are allowed in seg so
    # the grammar never blocks Gemma's thinking.
    assert "create_project" in g and "write_file" in g
    assert "<|channel>" in g and "<|think|>" in g
    # Requested mode is ignored for gemma — name-and-params still yields tier 1.
    assert tg.build_grammar_string(TOOLS, {"format": "gemma", "mode": "name-and-params"}) == g


def test_glm_name_only_well_formed():
    # GLM is always name-only (tier 1), regardless of requested mode.
    g = tg.build_grammar_string(TOOLS, {"format": "glm"})
    assert g is not None
    _assert_valid(g)
    # Single NAME enum, no per-tool fn_ branches (tier 1).
    assert "NAME:" in g and "fn_0" not in g
    # GLM call framing: `<tool_call>`/`</tool_call>` special-token envelope,
    # bare NAME right after the opener (no `<function=` wrapper).
    assert "<tool_call>" in g and "</tool_call>" in g
    assert "<function=" not in g
    # Function names are pinned; reasoning tokens are allowed in seg so the
    # grammar never blocks GLM's <think> reasoning.
    assert "create_project" in g and "write_file" in g
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
