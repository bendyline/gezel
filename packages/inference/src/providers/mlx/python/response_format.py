"""response_format — decode-time JSON for OpenAI's `response_format` on the
gezel MLX server.

`json_object` asks for any JSON object and `json_schema` for one shape.
llama.cpp enforces both with a grammar. This server used to accept the
field and drop it, so a caller asking for a schema got free text with no sign
that anything was wrong — on the engine gezel defaults to on Apple silicon.
The answer is now constrained by the same llguidance backend the tool-call
grammar uses (`tool_grammar.py`). Unlike `mlx_vlm.structured`, the grammar
lets whitespace through: held to one compact layout, a model that wants to
pretty-print (and every thinking model after `</think>`) was forced off its
path and wrote objects keyed `""` or `":"`. Measured 2026-10-14 on
gemma4-e4b and qwen3.8-27b: 22/32 and 14/16 useful JSON-mode answers
compact, 31/32 and 16/16 with flexible whitespace, no whitespace runaways.

A thinking model reasons first: when the prompt opens inside reasoning
(Qwen's `<think>`, Gemma 4's `<|channel>thought` after every tool response),
the grammar holds off until that block's closer (mlx_vlm's
ThinkingAwareLogitsProcessor), so it shapes the answer and not the private
reasoning. It once waited only for `<think>`: on Gemma the grammar then
held the open thought channel to the answer, the model never wrote
`<channel|>`, and a streaming client, told reasoning was open, got the whole
answer as reasoning and an empty reply.

A request may carry tools as well, as OpenAI allows: the model can call
them, and when it answers, the answer follows the schema. Where the model's
tool-call format has a grammar (`tool_grammar.SUPPORTED_FORMATS`), one grammar
covers both: optional reasoning, then calls or a JSON answer. It replaces the
plain tool grammar for that request. With no format grammar, calls stay free
and the answer is not enforced, as before this module existed. `tool_choice`
"none" asks for the answer alone; "required" or a named function asks for a
call, so the ordinary tool grammar runs.

The model is told the format too (`grounding_note`, placed per family by
`note_placement`), as OpenAI's own models are: a grammar alone only masks, so a model that does not know the schema
picks whatever the mask leaves. Live, 2026-10-14: asked for a country's
capital with a weather tool offered, qwen3.8-27b called the weather tool;
told "none", it wrote the one field it knew about and then filled the
required second one with whitespace until max_tokens. Whitespace runs are
also capped (`_BoundedWhitespace`), because llguidance's flexible whitespace
has no bound and that loop is the classic JSON-mode failure.

A schema llguidance refuses as written is compiled again with `oneOf` held as
`anyOf` and the keywords it does not implement left unenforced
(`_RELAXED_OPTIONS`), as llama.cpp serves them. One that still cannot compile
raises ValueError for the server to return as a 422, which /v1 answers as the
caller's 400: free text would hide the mistake. Only a matcher fault
mid-answer degrades to unconstrained text, as tool grammars do, rather than
killing a turn already under way.
"""

import json
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import think_budget
import tool_grammar


def response_schema(response_format: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The JSON Schema a `response_format` asks for, or None for plain text."""
    if not response_format:
        return None
    kind = response_format.get("type")
    if kind in (None, "text"):
        return None
    if kind == "json_object":
        return {"type": "object"}
    if kind == "json_schema":
        spec = response_format.get("json_schema")
        schema = spec.get("schema") if isinstance(spec, dict) else None
        if not isinstance(schema, dict):
            raise ValueError("response_format json_schema needs a `schema` object")
        return schema
    raise ValueError(f"Unsupported response_format type: {kind!r}")


class ResponseGrammar(NamedTuple):
    """A compiled response grammar and whether it also covers tool calls."""

    text: str
    covers_tool_calls: bool = False


def covers_tool_calls(grammar: Optional[ResponseGrammar]) -> bool:
    """Whether the request's tool grammar must stand down for this one."""
    return bool(grammar is not None and grammar.covers_tool_calls)


def _wants_a_call(tool_choice: Any) -> bool:
    return tool_choice == "required" or isinstance(tool_choice, dict)


def compile_response_grammar(
    tokenizer: Any,
    response_format: Optional[Dict[str, Any]],
    tools: Optional[List[Any]] = None,
    tool_grammar_hint: Optional[Dict[str, Any]] = None,
    tool_choice: Any = None,
    allow_think: bool = True,
) -> Optional[ResponseGrammar]:
    """Compile and validate the llguidance grammar for a response format.

    Called before generation starts so a bad schema fails as a 422 rather
    than mid-stream. Returns None when the request asks for plain text, or
    when tools are offered and nothing here can hold the answer without
    blocking a call.
    """
    schema = response_schema(response_format)
    if schema is None:
        return None
    answer, options = _compile_answer(tokenizer, schema)
    if not tools or tool_choice == "none":
        # With "none" the answer is the whole reply, so the tool grammar
        # stands down too.
        return ResponseGrammar(answer, covers_tool_calls=bool(tools))
    if _wants_a_call(tool_choice):
        print("[response-format] tool_choice asks for a call; the tool grammar alone applies", flush=True)
        return None
    if options:
        schema = {**schema, "x-guidance": {**schema.get("x-guidance", {}), **options}}
    combined = tool_grammar.build_answer_or_calls_grammar(
        tools, tool_grammar_hint or {}, schema, allow_think=allow_think
    )
    if combined is None:
        print(
            "[response-format] tools without a tool-call grammar for this model; "
            "calls stay free and the answer's JSON is not enforced",
            flush=True,
        )
        return None
    from llguidance import LLMatcher

    err = LLMatcher.validate_grammar(combined, tool_grammar._get_llg_tokenizer(tokenizer))
    if err:
        # The schema compiled on its own, so this is the splice, not the
        # caller: keep the calls working rather than refuse the request.
        print(f"[response-format] answer-or-calls grammar invalid; answer not enforced: {err}", flush=True)
        return None
    return ResponseGrammar(combined, covers_tool_calls=True)


# What lets a schema through that llguidance refuses as written. `oneOf` is
# held as `anyOf`: pydantic writes every discriminated union as `oneOf`, and
# llguidance accepts one only when it can prove the branches disjoint.
# Keywords it does not implement (`uniqueItems` from a pydantic `set`, `not`,
# `if`/`then`/`else`) go unenforced, as llama.cpp's converter leaves them.
# Refusing them failed requests llama.cpp serves, and that this engine served
# as free text before it enforced schemas at all.
_RELAXED_OPTIONS = {"coerce_one_of": True, "lenient": True}


def _unenforceable(detail: Any) -> ValueError:
    return ValueError(f"The response format's schema cannot be enforced: {detail}")


def _compile_answer(tokenizer: Any, schema: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """The answer grammar and the compiler options it needed beyond the defaults.

    A schema that compiles as written gets exactly the grammar it always got;
    only one llguidance refuses is compiled again with `_RELAXED_OPTIONS`.
    """
    import llguidance as llg
    from llguidance import LLMatcher

    schema_text = json.dumps(schema)
    llg_tok = tool_grammar._get_llg_tokenizer(tokenizer)
    try:
        if hasattr(llg, "JsonCompiler"):
            grammar = llg.JsonCompiler(whitespace_flexible=True).compile(
                schema_text
            )
        else:
            grammar = llg.grammar_from("json_schema", schema_text)
    except Exception as exc:  # noqa: BLE001 - any compiler rejection is the caller's schema
        return _compile_relaxed(schema_text, llg_tok, exc), dict(_RELAXED_OPTIONS)
    err = LLMatcher.validate_grammar(grammar, llg_tok)
    if err:
        raise _unenforceable(err)
    return grammar, {}


def _compile_relaxed(schema_text: str, llg_tok: Any, refusal: Exception) -> str:
    from llguidance import LLMatcher

    compile_schema = getattr(LLMatcher, "grammar_from_json_schema", None)
    validate = getattr(LLMatcher, "validate_grammar_with_warnings", None)
    if compile_schema is None or validate is None:
        raise _unenforceable(refusal) from refusal
    try:
        grammar = compile_schema(
            schema_text, overrides={"whitespace_flexible": True, **_RELAXED_OPTIONS}
        )
        is_error, messages = validate(grammar, llg_tok)
    except Exception as exc:  # noqa: BLE001 - any compiler rejection is the caller's schema
        raise _unenforceable(exc) from exc
    if is_error:
        # The relaxed pass's error, not the first refusal: it names what is
        # left once every relaxation has been applied.
        raise _unenforceable(messages[0] if messages else refusal)
    print(
        f"[response-format] schema relaxed to compile: {'; '.join(messages) or refusal}",
        flush=True,
    )
    return grammar


def grounding_note(response_format: Optional[Dict[str, Any]]) -> Optional[str]:
    """What the model is told about the format, or None for plain text.

    No word about tools: the template already lists them, and "call a tool if
    you need one" made qwen3.8-27b call one for questions it could answer.
    """
    schema = response_schema(response_format)
    if schema is None:
        return None
    if schema == {"type": "object"}:
        return "Reply with a single JSON object."
    return "Reply with a single JSON value matching this JSON Schema:\n" + json.dumps(
        schema, separators=(",", ":")
    )


def note_placement(tool_grammar_hint: Optional[Dict[str, Any]]) -> str:
    """Where a model family reads the format note best: "system" or "user".

    Measured 2026-10-14 with a weather tool offered and thinking off, on
    questions the model can answer itself. qwen3.8-27b (hermes) answered in
    JSON with the note in the system message, but called the weather tool for
    "What is 17 times 23?" with it in the user's turn. gemma4-e4b was the
    reverse: in the system message it reached for a tool it did not have
    (`google_search`), in the user's turn it answered in JSON. Both called
    the tool for the weather either way. Unknown families get the system
    message, the conventional place.
    """
    return "user" if str((tool_grammar_hint or {}).get("format") or "") == "gemma" else "system"


def _with_note(message: Any, note: str) -> Any:
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return message.model_copy(update={"content": f"{content}\n\n{note}"})
    if isinstance(content, list):
        return message.model_copy(update={"content": [*content, {"type": "text", "text": note}]})
    return message


def ground_messages(messages: List[Any], note: Optional[str], place: str = "system") -> List[Any]:
    """The messages with `note` added where the model family reads it best.

    "system": appended to the first system message, or added as one when
    there is none, never as a second (Qwen's template rejects two). "user":
    appended to the last user turn, the tail of the prompt, where a prefix
    cache can best afford a change. See `note_placement`.
    """
    if not note or not messages:
        return messages
    out = list(messages)
    if place == "user":
        for i in range(len(out) - 1, -1, -1):
            if getattr(out[i], "role", None) == "user":
                out[i] = _with_note(out[i], note)
                return out
        return out
    if getattr(out[0], "role", None) == "system":
        out[0] = _with_note(out[0], note)
        return out
    return [type(out[0])(role="system", content=note), *out]


_WHITESPACE_RUN_LIMIT = 24
_WHITESPACE_TOKENS: Dict[int, Dict[int, int]] = {}


def _whitespace_tokens(tokenizer: Any) -> Dict[int, int]:
    """Token id -> character count, for every token that decodes to whitespace."""
    hf = tool_grammar._resolve_hf_tokenizer(tokenizer)
    cached = _WHITESPACE_TOKENS.get(id(hf))
    if cached is not None:
        return cached
    size = len(hf)
    texts = hf.batch_decode([[i] for i in range(size)])
    table = {i: len(t) for i, t in enumerate(texts) if t and not t.strip()}
    _WHITESPACE_TOKENS[id(hf)] = table
    return table


class _BoundedWhitespace:
    """Forbid whitespace once a run of it reaches `limit` characters.

    Sits inside the thinking wrapper, so it counts only the answer. A model
    that wants to stop while the schema still owes a field pads with
    whitespace forever, since that is all the grammar never blocks; past the
    limit it has to write the field.
    """

    def __init__(self, inner: Any, whitespace: Dict[int, int], limit: int = _WHITESPACE_RUN_LIMIT) -> None:
        import mlx.core as mx

        self._inner = inner
        self._whitespace = whitespace
        self._limit = limit
        self._run = 0
        self._first = True
        self._ids = mx.array(sorted(whitespace), dtype=mx.int32)

    def __call__(self, input_ids: Any, logits: Any) -> Any:
        if self._first:
            self._first = False
        else:
            last = int(input_ids.reshape(-1)[-1].item())
            width = self._whitespace.get(last)
            self._run = self._run + width if width is not None else 0
        logits = self._inner(input_ids, logits)
        if self._run >= self._limit and self._ids.size:
            logits[..., self._ids] = float("-inf")
        return logits


def reasoning_gate(tokenizer: Any, prompt: str) -> Optional[Tuple[str, str]]:
    """The reasoning tags the grammar waits out, or None to apply it at once.

    Set when the rendered prompt leaves generation inside a reasoning block.
    The grammar is released on the closer's token id, so a closer this
    tokenizer splits into pieces cannot gate it: released on its last piece
    (often `>`), it would trip on ordinary reasoning text.
    """
    tags = think_budget.open_reasoning_tags(prompt)
    if tags is None:
        return None
    try:
        ids = tokenizer.encode(tags[1], add_special_tokens=False)
    except Exception:  # noqa: BLE001 - no encode, no gate
        ids = []
    if len(ids) != 1:
        print(
            f"[response-format] the prompt opens reasoning but {tags[1]} is not one token; "
            "the grammar applies from the first token",
            flush=True,
        )
        return None
    return tags


def build_response_format_processor(
    tokenizer: Any, grammar: Optional[ResponseGrammar], prompt: str
) -> Optional[Any]:
    """The logits processor for a compiled response grammar, or None."""
    if grammar is None:
        return None
    from mlx_vlm.structured import LLGuidanceLogitsProcessor, ThinkingAwareLogitsProcessor

    processor: Any = _BoundedWhitespace(
        LLGuidanceLogitsProcessor(grammar.text, tool_grammar._get_llg_tokenizer(tokenizer)),
        _whitespace_tokens(tokenizer),
    )
    tags = reasoning_gate(tokenizer, prompt)
    thinking = "off"
    if tags is not None:
        processor = ThinkingAwareLogitsProcessor(
            processor,
            tokenizer,
            thinking_start_token=tags[0],
            thinking_end_token=tags[1],
            enable_thinking=True,
        )
        thinking = f"deferred until={tags[1]}"
    print(
        f"[response-format] active answer={'json-or-calls' if grammar.covers_tool_calls else 'json'} "
        f"thinking={thinking}",
        flush=True,
    )
    return tool_grammar.SafeToolGrammarProcessor(
        processor, label="response-format", fallback="unconstrained text"
    )
