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


# Pydantic 2.13's schema for `pet: Cat | Dog = Field(discriminator="kind")`
# with each `kind` defaulted. The discriminator is optional, so llguidance
# cannot prove the branches disjoint and refuses the `oneOf` as written.
PET = {
    "$defs": {
        "Cat": {
            "properties": {
                "kind": {"const": "cat", "default": "cat", "title": "Kind", "type": "string"},
                "meows": {"title": "Meows", "type": "integer"},
            },
            "required": ["meows"],
            "title": "Cat",
            "type": "object",
        },
        "Dog": {
            "properties": {
                "kind": {"const": "dog", "default": "dog", "title": "Kind", "type": "string"},
                "barks": {"title": "Barks", "type": "number"},
            },
            "required": ["barks"],
            "title": "Dog",
            "type": "object",
        },
    },
    "properties": {
        "pet": {
            "discriminator": {"mapping": {"cat": "#/$defs/Cat", "dog": "#/$defs/Dog"}, "propertyName": "kind"},
            "oneOf": [{"$ref": "#/$defs/Cat"}, {"$ref": "#/$defs/Dog"}],
            "title": "Pet",
        }
    },
    "required": ["pet"],
    "title": "Owner",
    "type": "object",
}
# Keywords llguidance does not implement: a pydantic `set[str]`, `not`, and
# `if`/`then`/`else`. Each schema keeps a constraint it does enforce.
UNIMPLEMENTED = {
    "uniqueItems": {
        "type": "object",
        "properties": {"tags": {"type": "array", "items": {"type": "string"}, "uniqueItems": True}},
        "required": ["tags"],
    },
    "not": {
        "type": "object",
        "properties": {"code": {"not": {"type": "string"}}},
        "required": ["code"],
    },
    "if/then": {
        "type": "object",
        "properties": {"country": {"type": "string"}, "zip": {"type": "string"}},
        "required": ["country"],
        "if": {"properties": {"country": {"const": "US"}}},
        "then": {"required": ["zip"]},
        "else": {"properties": {"zip": {"pattern": "^[A-Z]"}}},
    },
}


def _schema_format(schema):
    return {"type": "json_schema", "json_schema": {"schema": schema}}


def _accepts(tokenizer, grammar_text, text):
    from llguidance import LLMatcher
    import tool_grammar

    matcher = LLMatcher(tool_grammar._get_llg_tokenizer(tokenizer), grammar_text)
    ids = tokenizer.encode(text, add_special_tokens=False)
    return matcher.try_consume_tokens(ids) == len(ids) and matcher.is_accepting()


def test_schemas_llguidance_refuses_as_written_still_compile():
    try:
        import llguidance as llg
    except ModuleNotFoundError:
        print("  (skipped: llguidance not installed)")
        return
    tokenizer = _tokenizer()
    if tokenizer is None:
        print("  (skipped: no installed MLX model tokenizer)")
        return
    for name, schema in [("oneOf", PET), *UNIMPLEMENTED.items()]:
        try:
            llg.JsonCompiler(whitespace_flexible=True).compile(json.dumps(schema))
        except ValueError:
            pass
        else:
            raise AssertionError(f"{name}: llguidance now compiles it as written; pick a schema it refuses")
        grammar = rf.compile_response_grammar(tokenizer, _schema_format(schema))
        assert grammar is not None and not grammar.covers_tool_calls, name
    pet = rf.compile_response_grammar(tokenizer, _schema_format(PET)).text
    assert _accepts(tokenizer, pet, '{"pet": {"kind": "cat", "meows": 3}}')
    assert _accepts(tokenizer, pet, '{"pet": {"barks": 1.5}}')
    assert not _accepts(tokenizer, pet, '{"pet": {"kind": "cow", "moos": 1}}')
    assert not _accepts(tokenizer, pet, "A cat.")
    # What llguidance implements is still enforced; only the rest is not.
    tags = rf.compile_response_grammar(tokenizer, _schema_format(UNIMPLEMENTED["uniqueItems"])).text
    assert _accepts(tokenizer, tags, '{"tags": ["a", "a"]}')
    assert not _accepts(tokenizer, tags, '{"tags": "a"}')
    country = rf.compile_response_grammar(tokenizer, _schema_format(UNIMPLEMENTED["if/then"])).text
    assert _accepts(tokenizer, country, '{"country": "US", "zip": "12345"}')
    assert not _accepts(tokenizer, country, '{"zip": "12345"}')
    # With tools the relaxed answer and the calls still form one grammar.
    for family, fmt in (("qwen", "hermes"), ("gemma", "gemma")):
        family_tok = _tokenizer(family)
        if family_tok is None:
            print(f"  (skipped tools: no installed {family} tokenizer)")
            continue
        combined = rf.compile_response_grammar(family_tok, _schema_format(PET), WEATHER, {"format": fmt})
        assert combined is not None and combined.covers_tool_calls, family
        assert _accepts(family_tok, combined.text, '{"pet": {"kind": "dog", "barks": 2}}'), family


def test_a_schema_that_still_cannot_compile_names_what_it_lacks():
    try:
        import llguidance  # noqa: F401
    except ModuleNotFoundError:
        print("  (skipped: llguidance not installed)")
        return
    tokenizer = _tokenizer()
    if tokenizer is None:
        print("  (skipped: no installed MLX model tokenizer)")
        return
    for schema, needle in (
        ({"type": "object", "properties": {"n": {"type": "bogus"}}}, "bogus"),
        ({"type": "string", "pattern": "(("}, "unclosed group"),
        ({"$ref": "https://example.com/pet.json"}, "https://example.com/pet.json"),
        # Refused as written for its `uniqueItems`; what is left after the
        # relaxation is what the caller has to fix.
        ({"type": "array", "items": {"type": "bogus"}, "uniqueItems": True}, "bogus"),
    ):
        try:
            rf.compile_response_grammar(tokenizer, _schema_format(schema))
        except ValueError as exc:
            message = str(exc)
            assert message.startswith("The response format's schema cannot be enforced: "), message
            assert needle in message, message
            # Compiler options an API caller cannot set.
            assert "coerce_one_of" not in message and "lenient" not in message, message
            continue
        raise AssertionError(f"expected a ValueError for {schema}")


def test_valid_schemas_compile_exactly_as_before():
    try:
        import llguidance as llg
    except ModuleNotFoundError:
        print("  (skipped: llguidance not installed)")
        return
    tokenizer = _tokenizer()
    if tokenizer is None:
        print("  (skipped: no installed MLX model tokenizer)")
        return
    for schema in (REVIEW, ANSWER, {"type": "object"}):
        grammar = rf.compile_response_grammar(tokenizer, _schema_format(schema))
        assert grammar.text == llg.JsonCompiler(whitespace_flexible=True).compile(json.dumps(schema))
    import tool_grammar

    combined = rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER, {"format": "hermes"})
    assert combined.text == tool_grammar.build_answer_or_calls_grammar(WEATHER, {"format": "hermes"}, ANSWER)
    assert "coerce_one_of" not in combined.text and "lenient" not in combined.text


class _SplitTokenizer:
    """Encodes `single` as one token and anything else as three."""

    def __init__(self, *single):
        self.single = set(single)

    def encode(self, text, add_special_tokens=False):
        return [7] if text in self.single else [1, 2, 3]


def test_the_grammar_waits_out_only_reasoning_the_prompt_opened():
    gemma = _SplitTokenizer("<channel|>")
    assert rf.reasoning_gate(gemma, "<|turn>model\n<|channel>thought\n") == ("<|channel>", "<channel|>")
    assert rf.reasoning_gate(gemma, "<|turn>model\n") is None
    assert rf.reasoning_gate(gemma, "<|turn>model\n<|channel>thought\n<channel|>") is None
    qwen = _SplitTokenizer("</think>")
    assert rf.reasoning_gate(qwen, "<|im_start|>assistant\n<think>\n") == ("<think>", "</think>")
    assert rf.reasoning_gate(qwen, "<|im_start|>assistant\n<think>\n\n</think>\n\n") is None
    # A closer the tokenizer splits cannot release the grammar on one id, so
    # it applies from the first token, as it did before the gate existed.
    assert rf.reasoning_gate(qwen, "<|turn>model\n<|channel>thought\n") is None


def _render(tokenizer, after_tool):
    messages = [{"role": "user", "content": "Weather in Paris?"}]
    if after_tool:
        messages += [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "get_weather", "arguments": {"city": "Paris"}}}
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "name": "get_weather", "content": "Sunny"},
        ]
    return tokenizer.apply_chat_template(
        messages, tools=WEATHER, tokenize=False, add_generation_prompt=True, enable_thinking=True
    )


def _reasoning_held_cases(family, fmt, closer, call_opener):
    try:
        import mlx.core as mx
        import llguidance  # noqa: F401
        import mlx_vlm.structured  # noqa: F401
        import think_budget
        import tool_grammar
    except ModuleNotFoundError:
        print("  (skipped: mlx, mlx_vlm or llguidance not installed)")
        return
    tokenizer = _tokenizer(family)
    if tokenizer is None:
        print(f"  (skipped: no installed {family} tokenizer)")
        return
    grammar = rf.compile_response_grammar(tokenizer, ANSWER_FORMAT, WEATHER, {"format": fmt})
    vocab = tool_grammar._get_llg_tokenizer(tokenizer).vocab_size

    def one(text):
        ids = tokenizer.encode(text, add_special_tokens=False)
        assert len(ids) == 1, (text, ids)
        return ids[0]

    prose, brace, close, call = one("It"), one("{"), one(closer), one(call_opener)

    # The model's own template ends the prompt inside reasoning on the turn
    # after a tool result: every final answer of an agent loop.
    prompt = _render(tokenizer, after_tool=True)
    assert think_budget.prompt_opens_reasoning(prompt), prompt[-40:]
    proc = rf.build_response_format_processor(tokenizer, grammar, prompt)
    ids = tokenizer.encode(prompt, add_special_tokens=False)

    def step(token=None):
        if token is not None:
            ids.append(token)
        return proc(mx.array(ids), mx.zeros((1, vocab)))

    out = step()
    for token in tokenizer.encode("The forecast says sunny, so", add_special_tokens=False):
        assert out[0, prose].item() == 0.0, "the grammar masked the reasoning"
        out = step(token)
    assert out[0, close].item() == 0.0
    out = step(close)
    # Released by the closer: the answer is the schema's or a call.
    assert out[0, prose].item() == float("-inf"), "the grammar never engaged"
    assert out[0, brace].item() == 0.0 and out[0, call].item() == 0.0
    for token in tokenizer.encode('{"answer": "Sunny"}', add_special_tokens=False):
        assert out[0, token].item() == 0.0, tokenizer.decode([token])
        out = step(token)
    assert not proc.disabled

    # A prompt that opens no reasoning gets the grammar from the first token,
    # as before.
    first = _render(tokenizer, after_tool=False)
    if not think_budget.prompt_opens_reasoning(first):
        fresh = rf.build_response_format_processor(tokenizer, grammar, first)
        out = fresh(mx.array(tokenizer.encode(first, add_special_tokens=False)), mx.zeros((1, vocab)))
        assert out[0, prose].item() == float("-inf") and out[0, brace].item() == 0.0


def test_gemma_answers_after_its_thought_channel_closes():
    _reasoning_held_cases("gemma", "gemma", "<channel|>", "<|tool_call>")


def test_qwen_answers_after_its_think_block_closes():
    _reasoning_held_cases("qwen", "hermes", "</think>", "<tool_call>")


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
