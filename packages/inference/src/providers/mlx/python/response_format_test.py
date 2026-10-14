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
    tools = [{"type": "function", "function": {"name": "read_file"}}]
    _raises(
        lambda: rf.compile_response_grammar(None, {"type": "json_object"}, tools),
        "cannot be combined with tools",
    )


def _tokenizer():
    for root in MODEL_DIRS:
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            if os.path.exists(os.path.join(root, name, "tokenizer.json")):
                from transformers import AutoTokenizer

                return AutoTokenizer.from_pretrained(os.path.join(root, name))
    return None


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
    llg_tok = tool_grammar._get_llg_tokenizer(tokenizer)

    def accepts(text):
        matcher = LLMatcher(llg_tok, grammar)
        ids = tokenizer.encode(text, add_special_tokens=False)
        return matcher.try_consume_tokens(ids) == len(ids) and matcher.is_accepting()

    good = [{"quote": "very unique", "severity": "warning", "replacement": None}]
    assert accepts(json.dumps(good, separators=(", ", ": ")))
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
