"""Tests for response_format.

A self-contained assert runner that exits non-zero on failure. The service
suite runs it on a bare python3 (python-suites.test.ts); run it with the MLX
venv python to include the token-level proof:

    "$HOME/.gezel/engines/uv/venvs/mlx/bin/python3" response_format_test.py

The contract checks run on bare Python. When llguidance and an installed MLX
model's tokenizer are available (no weights are loaded), it also proves at
the token level that the compiled grammar accepts a reply in the requested
shape and rejects one that breaks it.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import response_format as rf  # noqa: E402

MODEL_DIRS = [
    os.path.expanduser("~/.gezel/engines/mlx/models"),
    os.path.expanduser("~/.gezel-dev/engines/mlx/models"),
    "/Library/Application Support/Gezel/engines/mlx/models",
]

REVIEW = {
    "type": "array",
    "maxItems": 2,
    "items": {
        "type": "object",
        "properties": {
            "quote": {"type": "string"},
            "severity": {"type": "string", "enum": ["info", "warning"]},
            "replacement": {"type": ["string", "null"]},
        },
        "required": ["quote", "severity", "replacement"],
        "additionalProperties": False,
    },
}


def _raises(fn, needle):
    try:
        fn()
    except ValueError as exc:
        assert needle in str(exc), str(exc)
        return
    raise AssertionError(f"expected ValueError mentioning {needle!r}")


def test_plain_text_needs_no_grammar():
    assert rf.response_schema(None) is None
    assert rf.response_schema({}) is None
    assert rf.response_schema({"type": "text"}) is None
    assert rf.compile_response_grammar(None, {"type": "text"}) is None


def test_json_object_and_json_schema_shapes():
    assert rf.response_schema({"type": "json_object"}) == {"type": "object"}
    assert rf.response_schema({"type": "json_schema", "json_schema": {"schema": REVIEW}}) == REVIEW


def test_malformed_requests_are_errors_not_free_text():
    _raises(lambda: rf.response_schema({"type": "json_schema", "json_schema": {}}), "schema")
    _raises(lambda: rf.response_schema({"type": "xml"}), "Unsupported")


def _tokenizer(family=""):
    for root in MODEL_DIRS:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            if family not in name:
                continue
            if os.path.exists(os.path.join(root, name, "tokenizer.json")):
                from transformers import AutoTokenizer

                return AutoTokenizer.from_pretrained(os.path.join(root, name))
    return None


WEATHER = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]
ANSWER = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}
ANSWER_FORMAT = {"type": "json_schema", "json_schema": {"schema": ANSWER}}


def test_tools_without_a_call_grammar_keep_calls_free():
    # No format grammar for this model: the calls must still work, so the
    # answer goes unenforced rather than the request being refused.
    try:
        import llguidance  # noqa: F401
    except ModuleNotFoundError:
        print("  (skipped: llguidance not installed)")
        return
    tokenizer = _tokenizer()
    if tokenizer is None:
        print("  (skipped: no installed MLX model tokenizer)")
        return
    assert rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER) is None
    assert rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER, {"format": "unknown"}) is None
    # tool_choice "required" asks for a call: the tool grammar alone applies.
    assert (
        rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER, {"format": "hermes"}, "required")
        is None
    )
    # "none" asks for the answer alone, and the tool grammar stands down.
    only = rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER, {"format": "hermes"}, "none")
    assert only is not None and only.covers_tool_calls
    # A schema it cannot enforce is still the caller's 422, tools or not.
    _raises(
        lambda: rf.compile_response_grammar(
            tokenizer,
            {"type": "json_schema", "json_schema": {"schema": {"type": "bogus"}}},
            WEATHER,
            {"format": "hermes"},
        ),
        "cannot be enforced",
    )


class _Msg:
    """Stands in for the server's pydantic ChatMessageReq."""

    def __init__(self, role, content):
        self.role, self.content = role, content

    def model_copy(self, update):
        return _Msg(update.get("role", self.role), update.get("content", self.content))


def test_the_model_is_told_the_format_where_its_family_reads_it():
    assert rf.grounding_note(None) is None
    assert rf.grounding_note({"type": "json_object"}) == "Reply with a single JSON object."
    note = rf.grounding_note(ANSWER_FORMAT)
    assert note.startswith("Reply with a single JSON value") and '"required":["answer"]' in note
    # No word about tools: it primed qwen3.8-27b to call one it did not need.
    assert "tool" not in note
    assert rf.note_placement({"format": "hermes"}) == "system"
    assert rf.note_placement({"format": "gemma"}) == "user"
    assert rf.note_placement(None) == "system"

    msgs = [_Msg("user", "hi")]
    out = rf.ground_messages(msgs, "N", "system")
    assert [(m.role, m.content) for m in out] == [("system", "N"), ("user", "hi")]
    out = rf.ground_messages([_Msg("system", "S"), _Msg("user", "hi")], "N", "system")
    assert [(m.role, m.content) for m in out] == [("system", "S\n\nN"), ("user", "hi")]
    out = rf.ground_messages([_Msg("user", "a"), _Msg("assistant", "b"), _Msg("user", "c")], "N", "user")
    assert [m.content for m in out] == ["a", "b", "c\n\nN"]
    parts = rf.ground_messages([_Msg("user", [{"type": "text", "text": "c"}])], "N", "user")
    assert parts[0].content[-1] == {"type": "text", "text": "N"}
    assert rf.ground_messages(msgs, None, "user") is msgs


def test_whitespace_runs_are_capped():
    try:
        import mlx.core as mx
    except ModuleNotFoundError:
        print("  (skipped: mlx not installed)")
        return

    class Inner:
        def __call__(self, ids, logits):
            return logits

    p = rf._BoundedWhitespace(Inner(), {5: 2, 6: 10}, limit=12)
    p(mx.array([1]), mx.zeros((1, 10)))
    p(mx.array([1, 6]), mx.zeros((1, 10)))
    capped = p(mx.array([1, 6, 5]), mx.zeros((1, 10)))
    assert capped[0, 5].item() == float("-inf") and capped[0, 6].item() == float("-inf")
    assert capped[0, 0].item() == 0.0
    reset = p(mx.array([1, 6, 5, 3]), mx.zeros((1, 10)))
    assert reset[0, 5].item() == 0.0


def _answer_or_calls_cases(family, fmt, call, think):
    try:
        from llguidance import LLMatcher
        import tool_grammar
    except ModuleNotFoundError:
        print("  (skipped: llguidance not installed)")
        return
    tokenizer = _tokenizer(family)
    if tokenizer is None:
        print(f"  (skipped: no installed {family} tokenizer)")
        return
    grammar = rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER, {"format": fmt})
    assert grammar is not None and grammar.covers_tool_calls
    llg_tok = tool_grammar._get_llg_tokenizer(tokenizer)

    def accepts(text):
        matcher = LLMatcher(llg_tok, grammar.text)
        ids = tokenizer.encode(text, add_special_tokens=False)
        return matcher.try_consume_tokens(ids) == len(ids) and matcher.is_accepting()

    assert accepts('{"answer": "Sunny"}')
    assert accepts('{\n  "answer": "Sunny"\n}')
    assert accepts(think + '{"answer": "Sunny"}')
    assert accepts(call)
    assert accepts(call + "\n" + call)
    assert accepts(think + call)
    assert not accepts("It is sunny in Paris.")
    assert not accepts('{"weather": "Sunny"}')
    assert not accepts(call.replace("get_weather", "get_stock"))
    assert not accepts("Let me check. " + call)


def test_tools_and_a_response_format_combine_on_qwen():
    _answer_or_calls_cases(
        "qwen",
        "hermes",
        "<tool_call>\n<function=get_weather>\n<parameter=city>\nParis\n</parameter>\n</function>\n</tool_call>",
        "<think>\nThe user wants weather.\n</think>\n\n",
    )


def test_tools_and_a_response_format_combine_on_gemma():
    _answer_or_calls_cases(
        "gemma",
        "gemma",
        '<|tool_call>call:get_weather{city:<|"|>Paris<|"|>}<tool_call|>',
        "<|channel>thought\nThe user wants weather.<channel|>",
    )


def test_grammar_accepts_the_shape_and_rejects_violations():
    try:
        from llguidance import LLMatcher
        import tool_grammar
    except ModuleNotFoundError:
        print("  (skipped: llguidance not installed)")
        return
    tokenizer = _tokenizer()
    if tokenizer is None:
        print("  (skipped: no installed MLX model tokenizer)")
        return
    grammar = rf.compile_response_grammar(
        tokenizer, {"type": "json_schema", "json_schema": {"schema": REVIEW}}
    )
    assert not grammar.covers_tool_calls
    llg_tok = tool_grammar._get_llg_tokenizer(tokenizer)

    def accepts(text):
        matcher = LLMatcher(llg_tok, grammar.text)
        ids = tokenizer.encode(text, add_special_tokens=False)
        return matcher.try_consume_tokens(ids) == len(ids) and matcher.is_accepting()

    good = [{"quote": "very unique", "severity": "warning", "replacement": None}]
    assert accepts(json.dumps(good, separators=(", ", ": ")))
    # The layout a model picks is its own: pretty-printed and compact both pass.
    assert accepts(json.dumps(good, indent=2))
    assert accepts(json.dumps(good, separators=(",", ":")))
    assert not accepts('Sure! Here is the review: [')
    assert not accepts(json.dumps([{"quote": "x", "severity": "critical", "replacement": None}]))
    assert not accepts(json.dumps([{"quote": "x", "severity": "info"}]))
    assert not accepts(json.dumps([good[0]] * 3))
    _raises(
        lambda: rf.compile_response_grammar(
            tokenizer, {"type": "json_schema", "json_schema": {"schema": {"type": "bogus"}}}
        ),
        "cannot be enforced",
    )


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
