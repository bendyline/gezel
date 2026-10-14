"""response_format — decode-time JSON for OpenAI's `response_format` on the
gezel MLX server.

`json_object` asks for any JSON object and `json_schema` for one shape.
llama.cpp enforces both with a grammar. This server used to accept the
field and drop it, so a caller asking for a schema got free text with no sign
that anything was wrong — on the engine gezel defaults to on Apple silicon.
The answer is now constrained by the same llguidance backend the tool-call
grammar uses (`tool_grammar.py`), compiled the way `mlx_vlm.structured`
compiles it.

A thinking model reasons first: when the prompt opens inside `<think>`, the
grammar holds off until `</think>` (mlx_vlm's ThinkingAwareLogitsProcessor),
so it shapes the answer and not the private reasoning.

Unlike a tool grammar, a response format never falls back silently at build
time. A schema llguidance cannot compile, or a request that also offers tools
(a JSON grammar would forbid every tool call), raises ValueError for the
server to return as a 422. Only a matcher fault mid-answer degrades to
unconstrained text, as tool grammars do, rather than killing a turn already
under way.
"""

import json
from typing import Any, Dict, List, Optional

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


def compile_response_grammar(
    tokenizer: Any,
    response_format: Optional[Dict[str, Any]],
    tools: Optional[List[Any]] = None,
) -> Optional[str]:
    """Compile and validate the llguidance grammar for a response format.

    Called before generation starts so a bad request fails as a 422 rather
    than mid-stream. Returns None when the request asks for plain text.
    """
    schema = response_schema(response_format)
    if schema is None:
        return None
    if tools:
        raise ValueError(
            "A response format cannot be combined with tools on this engine: "
            "a JSON grammar would rule out every tool call. Send one or the other."
        )
    import llguidance as llg
    from llguidance import LLMatcher

    schema_text = json.dumps(schema)
    try:
        if hasattr(llg, "JsonCompiler"):
            grammar = llg.JsonCompiler(separators=(", ", ": "), whitespace_pattern="").compile(
                schema_text
            )
        else:
            grammar = llg.grammar_from("json_schema", schema_text)
    except Exception as exc:  # noqa: BLE001 - any compiler rejection is the caller's schema
        raise ValueError(f"The response format's schema cannot be enforced: {exc}") from exc
    err = LLMatcher.validate_grammar(grammar, tool_grammar._get_llg_tokenizer(tokenizer))
    if err:
        raise ValueError(f"The response format's schema cannot be enforced: {err}")
    return grammar


def build_response_format_processor(tokenizer: Any, grammar: Optional[str], thinking: bool) -> Optional[Any]:
    """The logits processor for a compiled response grammar, or None."""
    if grammar is None:
        return None
    from mlx_vlm.structured import LLGuidanceLogitsProcessor, ThinkingAwareLogitsProcessor

    processor: Any = LLGuidanceLogitsProcessor(grammar, tool_grammar._get_llg_tokenizer(tokenizer))
    if thinking:
        processor = ThinkingAwareLogitsProcessor(processor, tokenizer, enable_thinking=True)
    print(f"[response-format] active thinking={'deferred' if thinking else 'off'}", flush=True)
    return tool_grammar.SafeToolGrammarProcessor(
        processor, label="response-format", fallback="unconstrained text"
    )
