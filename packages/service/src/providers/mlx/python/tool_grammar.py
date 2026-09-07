"""tool_grammar — decode-time tool-call grammar for the gezel MLX server.

Why this exists: the MLX engine does no server-side tool parsing, so a
quantized model that mangles the tool-call format (classically: a
*parameter* name emitted as the *function* name) sails straight into the
gezel TS salvage layer, which rejects it as malformed/unknown — and the
model apologizes and retries the same bad call, making no progress.
llama.cpp avoids this because `--jinja` makes it derive a grammar from the
chat template and constrain sampling; we do the same here with llguidance
(already a transitive mlx-vlm dependency, and the same backend
`mlx_vlm.structured` uses for `response_format`).

The Hermes tier constrains the function name, parameter keys, and required-key
presence. The model may emit optional parameters anywhere and (for ordinary
schemas) required parameters in any order, but it cannot close a call before
every required top-level key has appeared. Values stay shallow so this does
not recreate the recursive-schema / ParserTooComplex failures that motivated
the original name-only grammar.

Special-token reality (verified against the installed Qwen 3.6 and 3.8 tokenizers):
`<think>`, `</think>`, `<tool_call>`, `</tool_call>` are each a SINGLE
special token, while `<function=` / `<parameter=` are ordinary multi-token
text. llguidance regex lexemes (`/(.|\n)*/`) match only text bytes and
stop at special-token atoms — so we list the special tokens the model
legitimately emits as grammar terminals (`<token_name>` syntax) and let
free text flow between them. The name right after `<function=` is pinned to
the known-tool enum; the model can also end the turn with no call at all.

Kept as a sibling module (like cache_persist) so it imports only
llguidance — the pure grammar builder is unit-testable without loading
mlx-vlm or a model (string-level); token-level accept/reject is proven by
tool_grammar_modeltest.py against a real tokenizer.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

# Tool-call grammar formats this module can build. Only formats verified at
# the token level against a real tokenizer live here (tool_grammar_modeltest.py).
# `hermes` covers Qwen 3.5/3.6/3.8 + the Hermes nesting
# (`<tool_call>\n<function=NAME>...`).
# `gemma` covers Gemma 4's native special-token call
# (`<|tool_call>call:NAME{key:<|"|>val<|"|>}<tool_call|>`).
# `glm` covers GLM-4.5/4.6 (`<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>`).
SUPPORTED_FORMATS = frozenset({"hermes", "gemma", "glm"})

_LLG_TOKENIZER_CACHE: Dict[int, Any] = {}


def _get_llg_tokenizer(tokenizer: Any) -> Any:
    """Build (and cache) an llguidance tokenizer for a HF tokenizer.

    Walking the vocab to build the llguidance tokenizer costs ~1.5s on a
    150k-token model, so we keep it for the process lifetime — the same
    trick mlx_vlm.structured uses. Keyed by id() since the tokenizer is a
    singleton held by the loaded model.
    """
    cached = _LLG_TOKENIZER_CACHE.get(id(tokenizer))
    if cached is not None:
        return cached
    import llguidance.hf

    llg_tok = llguidance.hf.from_tokenizer(tokenizer)
    _LLG_TOKENIZER_CACHE[id(tokenizer)] = llg_tok
    return llg_tok


class SafeToolGrammarProcessor:
    """Wrap an llguidance logits processor so a matcher fault degrades to
    unconstrained decoding instead of killing the turn.

    llguidance's LLGuidanceLogitsProcessor raises when its matcher hits an
    error state (e.g. ParserTooComplex, or an internal inconsistency). If
    that propagated out of the `stream_generate` loop it would 500 the
    whole turn. Instead we catch it, stop constraining for the remainder
    of this turn, and let the model finish unconstrained — the gezel TS
    salvage layer is still there as the post-hoc safety net.
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.disabled = False

    def __call__(self, input_ids: Any, logits: Any) -> Any:
        if self.disabled:
            return logits
        try:
            return self._inner(input_ids, logits)
        except Exception as exc:  # noqa: BLE001 - defensive: any matcher fault
            print(
                f"[tool-grammar] matcher error; disabling grammar for the rest of "
                f"this turn (falling back to unconstrained + TS salvage): {exc}",
                flush=True,
            )
            self.disabled = True
            return logits


def tool_name_alternation(tool_names: List[str]) -> str:
    """Regex alternation of the known tool names, escaped, longest-first.

    Longest-first so a name that is a prefix of another (`list` vs
    `list_projects`) can't shadow the longer match in the lexer.
    """
    ordered = sorted({n for n in tool_names if n}, key=len, reverse=True)
    return "|".join(re.escape(n) for n in ordered)


# Shared preamble for both Hermes tiers. `<think>`/`</think>`/`<tool_call>`/
# `</tool_call>` are single special tokens (listed as terminals); the
# free-text regex matches only ordinary bytes and stops at them. `start:
# (seg)*` is accepting at any point, so the model may end the turn with no
# call at all.
_HERMES_HEAD = (
    "%llguidance {}\n"
    "start: (seg)*\n"
    "seg: TEXT | <think> | </think> | tool_call\n"
    "TEXT: /(.|\\n)*/\n"
)


def _hermes_name_only(alts: str, json_branch: str = "") -> str:
    """Tier 1 — constrain only the function name (arguments fully free).

    `<tool_call>\\n<function=NAME>\\n…\\n</tool_call>` with NAME pinned to the
    known-tool enum; everything after the name is free.

    Note that tier 1 still pins the `<function=` wrapper, so it does NOT
    on its own let a model reach for the JSON envelope — dropping from
    tier 2 to tier 1 is not a fix for unrepresentable nested arguments.
    That is what the constrained `json_branch` is for.
    """
    if json_branch:
        return (
            _HERMES_HEAD
            + "tool_call: <tool_call> (hermes_call | json_call) </tool_call>\n"
            + "hermes_call: PRE NAME POST\n"
            + f"NAME: /({alts})/\n"
            + "PRE: /\\s*<function=/\n"
            + "POST: /(.|\\n)*/\n"
            + json_branch
        )
    return (
        _HERMES_HEAD
        + "tool_call: <tool_call> PRE NAME POST </tool_call>\n"
        + f"NAME: /({alts})/\n"
        + "PRE: /\\s*<function=/\n"
        + "POST: /(.|\\n)*/\n"
    )


# Gemma 4 emits tool calls as `<|tool_call>call:NAME{key:<|"|>val<|"|>,...}<tool_call|>`.
# `<|tool_call>` (id 48), `<tool_call|>` (49) and the string-value delimiter
# `<|"|>` (52) are each a SINGLE special token (verified against the installed
# Gemma 4 tokenizers in tool_grammar_modeltest.py). The reasoning/turn tokens
# Gemma can also emit in output — `<|think|>`, `<|channel>`/`<channel|>`,
# `<|turn>`/`<turn|>` — plus the tool framing tokens are all listed as terminals
# in `seg`, so the grammar constrains ONLY the call name and never blocks
# legitimate reasoning. Inside a call, free text and the `<|"|>` delimiter flow
# freely, so a string value can carry newlines / braces / quotes.
_GEMMA_HEAD = (
    "%llguidance {}\n"
    "start: (seg)*\n"
    "seg: TEXT | <|tool> | <tool|> | <|tool_response> | <tool_response|>"
    " | <|think|> | <|channel> | <channel|> | <|turn> | <turn|> | tool_call\n"
    "TEXT: /(.|\\n)*/\n"
)


def _gemma_name_only(alts: str) -> str:
    """Tier 1 for Gemma — constrain the function name; arguments fully free.

    `<|tool_call>call:NAME{...}<tool_call|>` with NAME pinned to the known-tool
    enum. The body is free text interleaved with the `<|"|>` string-delimiter
    token, so argument *content* is never constrained — the existing TS salvage
    layer keeps handling argument repair. Makes the hallucinated-function-name
    failure unrepresentable with zero recursion / ParserTooComplex risk.
    """
    return (
        _GEMMA_HEAD
        + "tool_call: <|tool_call> PRE NAME body <tool_call|>\n"
        + f"NAME: /({alts})/\n"
        + "PRE: /call:/\n"
        + 'body: (TEXT | <|"|>)*\n'
    )


# GLM-4.5/4.6 emit `<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>`.
# Verified against the installed laguna-s-118b tokenizer_config.json:
# `<tool_call>` (25) and `</tool_call>` (26) are single special tokens, while
# `<arg_key>` / `<arg_value>` are ORDINARY byte sequences (not in
# added_tokens) — the same split Hermes has between its `<tool_call>` envelope
# and `<function=` inner markup. So the name-only grammar is Hermes-shaped:
# pin NAME right after the `<tool_call>` special token (GLM writes the bare
# function name with no `<function=` wrapper), then free text up to the
# `</tool_call>` special token. `<think>`/`</think>` (18/19) are listed so
# reasoning is never blocked.
_GLM_HEAD = (
    "%llguidance {}\n"
    "start: (seg)*\n"
    "seg: TEXT | <think> | </think> | tool_call\n"
    "TEXT: /(.|\\n)*/\n"
)


def _glm_name_only(alts: str) -> str:
    """Tier 1 for GLM — constrain the function name; arguments fully free.

    `<tool_call>NAME<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>`
    with NAME pinned to the known-tool enum. The `<arg_key>`/`<arg_value>`
    body is ordinary bytes (free text), so argument content is never
    constrained — the TS salvage layer keeps handling argument parsing. Makes
    the hallucinated-function-name failure unrepresentable with zero recursion
    / ParserTooComplex risk. Leading whitespace before NAME is tolerated (the
    template emits none, but a model may add a newline).
    """
    return (
        _GLM_HEAD
        + "tool_call: <tool_call> NAME POST </tool_call>\n"
        + f"NAME: /\\s*({alts})/\n"
        + "POST: /(.|\\n)*/\n"
    )


def _schema_is_structural(schema: Any, depth: int = 0) -> bool:
    """True if this property schema wants an object or array value.

    Conservative on purpose: an unresolvable `$ref` counts as structural.
    Guessing "structural" only widens the grammar (see
    `_has_structural_params`); guessing "scalar" would keep the model
    trapped in a shape that cannot express the value.
    """
    if not isinstance(schema, dict) or depth > 4:
        return False
    if "$ref" in schema:
        return True
    t = schema.get("type")
    if isinstance(t, str) and t in ("object", "array"):
        return True
    if isinstance(t, list) and any(x in ("object", "array") for x in t):
        return True
    if "properties" in schema or "items" in schema:
        return True
    for key in ("anyOf", "oneOf", "allOf"):
        branches = schema.get(key)
        if isinstance(branches, list) and any(
            _schema_is_structural(b, depth + 1) for b in branches
        ):
            return True
    return False


def _has_structural_params(tools: List[Dict[str, Any]]) -> bool:
    """True if any wired tool declares a top-level object/array parameter.

    The Hermes `<parameter=KEY>value</parameter>` shape is a flat KEY→text
    map: it has no way to carry a nested object or array. When every tool
    takes flat scalars that costs nothing, and tier-2 key pinning is pure
    win. The moment one tool wants `{...}` or `[...]` — DocBlocks'
    `convert_document.source` / `targets`, `save_artifact.destination` —
    the grammar is pinning the model into a shape that CANNOT express a
    valid call, and no amount of retrying gets it out. Wild-caught: 19
    consecutive failed attempts on one craftbook step, the model emitting
    correct JSON every time and the markup flattening it to a string every
    time.

    When this returns True the Hermes grammar additionally admits a raw
    JSON body inside the `<tool_call>` envelope, so the model has a
    representable way to make the call. The JSON branch is schema-constrained
    too, so function names, top-level keys, and required fields stay pinned.
    """
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        params = fn.get("parameters") if isinstance(fn, dict) else None
        props = params.get("properties") if isinstance(params, dict) else None
        if not isinstance(props, dict):
            continue
        if any(_schema_is_structural(v) for v in props.values()):
            return True
    return False


def _required_param_keys_from_tool(tool: Dict[str, Any], keys: List[str]) -> List[str]:
    """Declared top-level required keys that the markup grammar can emit.

    A malformed schema can mention a required key absent from `properties`.
    Ignoring that impossible key is the safe direction: requiring it would
    make every call to the tool unrepresentable at decode time.
    """
    fn = tool.get("function") if isinstance(tool, dict) else None
    params = fn.get("parameters") if isinstance(fn, dict) else None
    required = params.get("required") if isinstance(params, dict) else None
    if not isinstance(required, list):
        return []
    available = set(keys)
    out: List[str] = []
    for value in required:
        if isinstance(value, str) and value in available and value not in out:
            out.append(value)
    return out


def _shallow_json_property(schema: Any) -> Dict[str, Any]:
    """Keep cheap value constraints for the raw-JSON escape branch.

    Full MCP schemas contain deep unions that can trip llguidance's parser
    complexity ceiling. The service remains the authoritative validator; at
    decode time we enforce the function name, top-level keys, and required
    list, plus inexpensive type/enum/const hints where available.
    """
    if not isinstance(schema, dict):
        return {}
    out: Dict[str, Any] = {}
    declared = schema.get("type")
    if isinstance(declared, str) or (
        isinstance(declared, list) and all(isinstance(x, str) for x in declared)
    ):
        out["type"] = declared
    if "const" in schema:
        out["const"] = schema["const"]
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        out["enum"] = enum
    return out


def _hermes_json_branch(tools: List[Dict[str, Any]]) -> str:
    """Constrained raw-JSON calls for tools needing nested values.

    Hermes' `<parameter=K>text</parameter>` representation flattens objects
    and arrays into strings. Qwen also knows the canonical JSON envelope, so
    structural tools get that escape hatch. It used to be a free regex, which
    silently bypassed every function-name, key-name, and required-field
    guarantee. llguidance supports inline JSON Schema; use a deliberately
    shallow per-tool union so the escape stays representable without becoming
    unconstrained.
    """
    variants: List[Dict[str, Any]] = []
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        name = fn.get("name") if isinstance(fn, dict) else None
        params = fn.get("parameters") if isinstance(fn, dict) else None
        props = params.get("properties") if isinstance(params, dict) else None
        if not (isinstance(name, str) and name and isinstance(props, dict)):
            continue
        if not any(_schema_is_structural(value) for value in props.values()):
            continue
        keys = [key for key in props if isinstance(key, str) and key]
        arguments: Dict[str, Any] = {
            "type": "object",
            "properties": {
                key: _shallow_json_property(props[key]) for key in keys
            },
            "additionalProperties": False,
        }
        required = _required_param_keys_from_tool(tool, keys)
        if required:
            arguments["required"] = required
        variants.append(
            {
                "type": "object",
                "properties": {
                    "name": {"const": name},
                    "arguments": arguments,
                },
                "required": ["name", "arguments"],
                "additionalProperties": False,
            }
        )
    if not variants:
        return ""
    schema: Dict[str, Any] = variants[0] if len(variants) == 1 else {"anyOf": variants}
    encoded = json.dumps(schema, separators=(",", ":"))
    return (
        "json_call: JSON_WS json_body JSON_WS\n"
        "JSON_WS: /\\s*/\n"
        f"json_body: %json {encoded}\n"
    )


def _param_keys_from_tool(tool: Dict[str, Any]) -> Optional[List[str]]:
    """Top-level parameter names for a tool, or None when the schema
    declares none we can constrain — caller then allows free keys so a
    loose/undeclared-schema tool is never broken.
    """
    fn = tool.get("function") if isinstance(tool, dict) else None
    params = fn.get("parameters") if isinstance(fn, dict) else None
    props = params.get("properties") if isinstance(params, dict) else None
    if isinstance(props, dict) and props:
        keys = [k for k in props.keys() if isinstance(k, str) and k]
        return keys or None
    return None


_MAX_ANY_ORDER_REQUIRED_PARAMS = 4


def _hermes_required_param_rules(
    idx: int, keys: List[str], required: List[str]
) -> List[str]:
    """Grammar rules that make every required markup parameter unavoidable.

    For up to four required keys, a small state machine tracks which keys have
    appeared and accepts them in any order. State growth is 2**N, so wider
    schemas use their declared `required` order instead; decode-time steering
    then guides the model through that canonical order without risking a
    roster-sized ParserTooComplex failure.

    Optional keys, and required keys already seen, may occur between required
    transitions. The final state accepts any declared key, preserving the old
    grammar's tolerance for duplicate parameters.
    """
    all_keys = tool_name_alternation(keys)
    rules = [f"k_{idx}: /({all_keys})/"]
    if not required:
        rules.insert(0, f'params_{idx}: ( POPEN k_{idx} ">" pval )*')
        return rules

    if len(required) > _MAX_ANY_ORDER_REQUIRED_PARAMS:
        optional = [key for key in keys if key not in set(required)]
        pieces: List[str] = []
        seen: List[str] = []
        for pos, key in enumerate(required):
            neutral = optional + seen
            if neutral:
                neutral_name = f"gap_{idx}_{pos}"
                rules.append(
                    f"{neutral_name}: /({tool_name_alternation(neutral)})/"
                )
                pieces.append(f'( POPEN {neutral_name} ">" pval )*')
            pieces.append(f"POPEN {json.dumps(key + '>')} pval")
            seen.append(key)
        pieces.append(f'( POPEN k_{idx} ">" pval )*')
        rules.insert(0, f"params_{idx}: {' '.join(pieces)}")
        return rules

    required_index = {key: pos for pos, key in enumerate(required)}
    full_mask = (1 << len(required)) - 1
    rules.insert(0, f"params_{idx}: params_{idx}_s_0")
    for mask in range(full_mask + 1):
        state = f"params_{idx}_s_{mask}"
        if mask == full_mask:
            rules.append(f'{state}: ( POPEN k_{idx} ">" pval )*')
            continue

        neutral = [
            key
            for key in keys
            if key not in required_index or mask & (1 << required_index[key])
        ]
        prefix = ""
        if neutral:
            neutral_name = f"seen_{idx}_{mask}"
            rules.append(
                f"{neutral_name}: /({tool_name_alternation(neutral)})/"
            )
            prefix = f'( POPEN {neutral_name} ">" pval )* '

        transitions = []
        for pos, key in enumerate(required):
            if mask & (1 << pos):
                continue
            next_state = f"params_{idx}_s_{mask | (1 << pos)}"
            transitions.append(
                f"POPEN {json.dumps(key + '>')} pval {next_state}"
            )
        rules.append(f"{state}: {prefix}({' | '.join(transitions)})")
    return rules


def _hermes_name_and_params(tools: List[Dict[str, Any]]) -> Optional[str]:
    """Tier 2 — constrain the function name AND each `<parameter=KEY>` key to
    that tool's declared parameter names (values stay free).

    Branches per tool so the valid key set follows the chosen function. A
    tool with no declarable schema falls back to free keys (name still
    constrained), so loose-schema tools are never broken. Values are a lazy
    lexeme bounded by the text token `</parameter>`. Top-level keys only —
    no value-schema recursion, so no ParserTooComplex exposure.
    """
    branches: List[str] = []
    rules: List[str] = []
    seen: set = set()
    idx = 0
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        name = fn.get("name") if isinstance(fn, dict) else None
        if not (isinstance(name, str) and name) or name in seen:
            continue
        seen.add(name)
        params = fn.get("parameters") if isinstance(fn, dict) else None
        props = params.get("properties") if isinstance(params, dict) else None
        # A structural value cannot survive Hermes' flat parameter markup:
        # the parser necessarily turns it into a string. These tools are
        # represented exclusively by the constrained JSON branch below so the
        # grammar cannot steer the model into a call the validator must reject.
        if isinstance(props, dict) and any(
            _schema_is_structural(value) for value in props.values()
        ):
            continue
        branches.append(f"fn_{idx}")
        head = json.dumps(name + ">")  # lark string literal, safely escaped
        rules.append(f"fn_{idx}: {head} params_{idx} CLOSE")
        keys = _param_keys_from_tool(tool)
        if keys:
            required = _required_param_keys_from_tool(tool, keys)
            rules.extend(_hermes_required_param_rules(idx, keys, required))
        else:
            rules.append(f'params_{idx}: ( POPEN FREEKEY ">" pval )*')
        idx += 1
    json_branch = _hermes_json_branch(tools)
    if not branches and not json_branch:
        return None
    if branches and json_branch:
        alt = " | ".join(branches)
        head = (
            "tool_call: <tool_call> (hermes_call | json_call) </tool_call>\n"
            + f"hermes_call: FNOPEN ({alt})\n"
            + json_branch
        )
    elif branches:
        alt = " | ".join(branches)
        head = f"tool_call: <tool_call> FNOPEN ({alt}) </tool_call>\n"
    else:
        head = "tool_call: <tool_call> json_call </tool_call>\n" + json_branch
    return (
        _HERMES_HEAD
        + head
        + "FNOPEN: /\\s*<function=/\n"
        + "POPEN: /\\s*<parameter=/\n"
        + "PVALT: /(.|\\n)*/\n"
        + "CLOSE: /\\s*<\\/function>\\s*/\n"
        + "FREEKEY: /[a-zA-Z_][a-zA-Z0-9_-]*/\n"
        + 'pval[lazy]: PVALT "</parameter>"\n'
        + "\n".join(rules)
        + "\n"
    )


def _tool_names_from_request(tools: Optional[List[Dict[str, Any]]]) -> List[str]:
    names: List[str] = []
    for t in tools or []:
        fn = t.get("function") if isinstance(t, dict) else None
        name = fn.get("name") if isinstance(fn, dict) else None
        if isinstance(name, str) and name:
            names.append(name)
    return names


def build_grammar_string(
    tools: Optional[List[Dict[str, Any]]], hint: Dict[str, Any]
) -> Optional[str]:
    """Build the serialized llguidance grammar string for a request, or
    None if unsupported / not applicable. Pure (no tokenizer) so it's
    unit-testable: validate it with `LLMatcher.validate_grammar`.

    `hint.mode` selects the tier: `name-and-params` (default — tier 2,
    constrains the function name, each parameter key, and required-key
    presence) or `name-only` (tier 1, function name only).
    """
    fmt = str((hint or {}).get("format") or "").strip()
    if fmt not in SUPPORTED_FORMATS:
        return None
    tool_list = [t for t in (tools or []) if isinstance(t, dict)]
    if not tool_list:
        return None
    mode = str((hint or {}).get("mode") or "name-and-params").strip()
    if fmt == "hermes":
        if mode == "name-only":
            alts = tool_name_alternation(_tool_names_from_request(tool_list))
            if not alts:
                return None
            return _hermes_name_only(alts, json_branch=_hermes_json_branch(tool_list))
        return _hermes_name_and_params(tool_list)
    if fmt == "gemma":
        # Gemma is name-only (tier 1) regardless of requested mode: pinning the
        # name already makes the hallucinated-name failure unrepresentable,
        # which is the load-bearing constraint. Tier-2 key-pinning for Gemma's
        # bare-key `{key:<|"|>val<|"|>}` shape is a fast-follow.
        alts = tool_name_alternation(_tool_names_from_request(tool_list))
        return _gemma_name_only(alts) if alts else None
    if fmt == "glm":
        # GLM is name-only (tier 1) regardless of requested mode: pinning the
        # function name makes the hallucinated-name failure unrepresentable,
        # which is the load-bearing constraint. The `<arg_key>` body is free
        # bytes, so tier-2 key-pinning would need the same `<parameter=`-style
        # handling Hermes has — a fast-follow.
        alts = tool_name_alternation(_tool_names_from_request(tool_list))
        return _glm_name_only(alts) if alts else None
    return None


def build_tool_grammar_processor(
    tokenizer: Any,
    tools: Optional[List[Dict[str, Any]]],
    hint: Dict[str, Any],
) -> Optional[Any]:
    """Build a schema-constraining logits processor for the request's
    tool-call format, or None if unsupported / not applicable.

    `hint` is the gezel `tool_grammar` request field, e.g.
    `{"format": "hermes", "mode": "name-and-params"}`. Tool schemas are
    read from the OpenAI `tools` array. Any failure returns None — the turn then
    runs unconstrained + TS salvage, so this never breaks a turn.
    """
    fmt = str((hint or {}).get("format") or "").strip()
    if fmt and fmt not in SUPPORTED_FORMATS:
        print(
            f"[tool-grammar] no grammar template for format={fmt!r}; skipping",
            flush=True,
        )
        return None

    try:
        from llguidance import LLMatcher
        from mlx_vlm.structured import LLGuidanceLogitsProcessor
    except Exception as exc:  # noqa: BLE001 - optional dep missing
        print(
            f"[tool-grammar] llguidance unavailable; skipping grammar: {exc}",
            flush=True,
        )
        return None

    try:
        grammar = build_grammar_string(tools, hint)
    except Exception as exc:  # noqa: BLE001 - build must not break the turn
        print(
            f"[tool-grammar] failed to build grammar for format={fmt!r}: {exc}",
            flush=True,
        )
        return None
    if grammar is None:
        return None

    try:
        # Validate WITH the tokenizer so unresolved special-token terminals
        # (a model variant that doesn't ship `<tool_call>` etc.) fail here
        # and fall back to unconstrained decode rather than erroring mid-turn.
        llg_tok = _get_llg_tokenizer(tokenizer)
        err = LLMatcher.validate_grammar(grammar, llg_tok)
        if err:
            print(
                f"[tool-grammar] grammar invalid for format={fmt!r} on this "
                f"tokenizer: {err}",
                flush=True,
            )
            return None
        proc = LLGuidanceLogitsProcessor(grammar, llg_tok)
    except Exception as exc:  # noqa: BLE001 - build failure must not break the turn
        print(
            f"[tool-grammar] failed to build processor for format={fmt!r}: {exc}",
            flush=True,
        )
        return None

    mode = str((hint or {}).get("mode") or "name-and-params").strip()
    # `json-escape=on` means at least one wired tool declares an
    # object/array parameter, so the grammar also admits a raw JSON body
    # inside `<tool_call>`. Without it the model would be pinned into the
    # flat `<parameter=KEY>` shape, which cannot express such an argument.
    json_escape = fmt == "hermes" and _has_structural_params(
        [t for t in (tools or []) if isinstance(t, dict)]
    )
    required_fields = 0
    required_tools = 0
    for tool in [t for t in (tools or []) if isinstance(t, dict)]:
        keys = _param_keys_from_tool(tool) or []
        count = len(_required_param_keys_from_tool(tool, keys))
        required_fields += count
        required_tools += int(count > 0)
    print(
        f"[tool-grammar] active format={fmt} mode={mode} "
        f"tools={len(_tool_names_from_request(tools))} "
        f"declared-required-tools={required_tools} "
        f"declared-required-fields={required_fields} "
        f"json-escape={'on' if json_escape else 'off'}",
        flush=True,
    )
    return SafeToolGrammarProcessor(proc)
