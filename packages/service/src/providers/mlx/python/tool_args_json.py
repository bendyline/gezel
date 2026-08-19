"""Incremental qwen-markup -> JSON argument conversion.

The problem
-----------
Qwen's tool body is markup, not JSON::

    <function=write_file><parameter=path>a.html</parameter>
    <parameter=content>&lt;!doctype html&gt;...</parameter></function>

OpenAI's wire shape needs `function.arguments` to be a JSON *string*, so a
client that receives the raw markup rejects every call ("Missing required
fields: `path`, `content`"). mlx_vlm's `qwen3_coder.parse_tool_call` does the
conversion, but only over a COMPLETE call — which is why streaming raw markup
and buffering-then-parsing are both dead ends: the first is invalid, the
second gives no turn boundary and so no early abort.

The approach
------------
Convert as the bytes arrive. The saving grace is that only STRING parameters
are large — `content` is the whole file — and a string can be JSON-escaped
chunk by chunk. Everything else (ints, floats, bools, objects, arrays) is
small and needs the whole value for `_convert_param_value`-style coercion, so
those are buffered per-parameter and emitted when their `</parameter>` lands.

Semantics are copied from mlx_vlm 0.6.6 `tool_parsers/qwen3_coder.py` and must
stay identical; `test_tool_args_json.py` asserts that by differential-testing
every case against the reference parser. In particular:

  * exactly ONE leading and ONE trailing "\\n" is stripped from a value
  * a literal "null" (any case) becomes JSON null
  * a parameter absent from the schema is treated as a string
  * unknown/odd types fall through to `ast.literal_eval`, as upstream does

Chunk boundaries are the hazard throughout: `</parameter>`, `</function>` and
the trailing-newline rule all need lookahead, so the encoder holds back the
minimum bytes that could still turn out to be part of a marker.
"""

from __future__ import annotations

import ast
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

_STRING_TYPES = {"string", "str", "text", "varchar", "char", "enum"}
_BOOL_TYPES = {"boolean", "bool", "binary"}
_OBJ_TYPES = {"object", "array", "arr"}

_PARAM_OPEN = "<parameter="
_PARAM_CLOSE = "</parameter>"
_FUNC_CLOSE = "</function>"


def arguments_config(func_name: str, tools: Optional[Any]) -> Dict[str, Any]:
    """Schema `properties` for a tool, mirroring `_get_arguments_config`."""
    if not tools:
        return {}
    for tool in tools:
        function = tool.get("function") if isinstance(tool, dict) else None
        if not function:
            continue
        if function.get("name") == func_name:
            params = function.get("parameters")
            if not params:
                return {}
            return params.get("properties", {}) or {}
    return {}


def is_string_param(param_name: str, param_config: Dict[str, Any]) -> bool:
    """Can this parameter stream, or must its value be buffered whole?

    Unknown parameters count as strings — upstream returns the raw value when
    the schema has no entry, and raw-string is the streamable case.
    """
    param = param_config.get(param_name)
    if not param:
        return True
    declared = param.get("type")
    if declared is None:
        return True
    return str(declared).strip().lower() in _STRING_TYPES


def convert_param_value(value: str, param_name: str, param_config: Dict[str, Any]) -> Any:
    """Coerce a complete value, mirroring `_convert_param_value`."""
    if value.lower() == "null":
        return None
    param = param_config.get(param_name)
    if not param:
        return value
    param_type = str(param["type"]).strip().lower() if "type" in param else "string"
    if param_type in _STRING_TYPES:
        return value
    if param_type.startswith(("int", "uint", "long", "short", "unsigned")):
        return int(value)
    if param_type.startswith(("num", "float")):
        as_float = float(value)
        as_int = int(as_float)
        return as_float if (as_float - as_int) != 0 else as_int
    if param_type in _BOOL_TYPES:
        return value.lower() == "true"
    if param_type in _OBJ_TYPES or param_type.startswith(("dict", "list")):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return ast.literal_eval(value)
    return ast.literal_eval(value)


def _json_fragment(text: str) -> str:
    """Escape `text` for the inside of a JSON string literal."""
    return json.dumps(text)[1:-1]


def _longest_partial_suffix(text: str, marker: str) -> int:
    """Length of the trailing run of `text` that could begin `marker`."""
    limit = min(len(text), len(marker) - 1)
    for size in range(limit, 0, -1):
        if marker.startswith(text[-size:]):
            return size
    return 0


@dataclass
class ToolArgsJsonEncoder:
    """Turn a stream of qwen tool-body text into a stream of JSON argument text.

    Feed the body that follows `<function=NAME>`; `feed()` returns JSON text
    to append to `function.arguments`. `finish()` closes the object.
    """

    param_config: Dict[str, Any] = field(default_factory=dict)
    _buf: str = ""
    _started: bool = False
    _closed: bool = False
    _in_value: bool = False
    _value_is_string: bool = False
    _value_name: str = ""
    _value_buf: str = ""
    _emitted_value_chars: int = 0
    _pending_newline: bool = False
    _first_param: bool = True
    _leading_stripped: bool = False
    _opened_quote: bool = False

    def _open(self) -> str:
        if self._started:
            return ""
        self._started = True
        return "{"

    def feed(self, text: str) -> str:
        if self._closed:
            return ""
        out: List[str] = []
        self._buf += text
        while self._buf:
            if not self._in_value:
                # Between parameters: wait for the next <parameter= or the
                # closing </function>.
                p = self._buf.find(_PARAM_OPEN)
                f = self._buf.find(_FUNC_CLOSE)
                if p < 0 and f < 0:
                    keep = max(
                        _longest_partial_suffix(self._buf, _PARAM_OPEN),
                        _longest_partial_suffix(self._buf, _FUNC_CLOSE),
                    )
                    self._buf = self._buf[len(self._buf) - keep :] if keep else ""
                    break
                if f >= 0 and (p < 0 or f < p):
                    self._buf = ""
                    out.append(self._open())
                    out.append("}")
                    self._closed = True
                    break
                close = self._buf.find(">", p + len(_PARAM_OPEN))
                if close < 0:
                    self._buf = self._buf[p:]
                    break
                name = self._buf[p + len(_PARAM_OPEN) : close]
                self._buf = self._buf[close + 1 :]
                out.append(self._open())
                if not self._first_param:
                    out.append(",")
                self._first_param = False
                self._value_name = name
                self._value_is_string = is_string_param(name, self.param_config)
                self._in_value = True
                self._value_buf = ""
                self._emitted_value_chars = 0
                self._pending_newline = False
                self._leading_stripped = False
                self._opened_quote = False
                # NOTE: the opening quote is deliberately NOT emitted yet.
                # `_convert_param_value` maps a whole value of "null" to JSON
                # null BEFORE consulting the schema, so even a string-typed
                # parameter can turn out to be null — and by then a quote
                # would already be on the wire. Hold the first few bytes.
                continue

            end = self._buf.find(_PARAM_CLOSE)
            chunk = self._buf if end < 0 else self._buf[:end]
            if end < 0:
                hold = _longest_partial_suffix(chunk, _PARAM_CLOSE)
                if hold:
                    chunk = chunk[: len(chunk) - hold]
                self._buf = self._buf[len(chunk) :]
            else:
                self._buf = self._buf[end + len(_PARAM_CLOSE) :]

            if not self._value_is_string:
                self._value_buf += chunk
                if end < 0:
                    break
                value = self._value_buf
                if value.startswith("\n"):
                    value = value[1:]
                if value.endswith("\n"):
                    value = value[:-1]
                out.append(f"{json.dumps(self._value_name)}:")
                out.append(json.dumps(convert_param_value(value, self._value_name, self.param_config)))
                self._in_value = False
                continue

            # String value. Three lookahead rules interact here:
            #   * strip exactly one leading newline
            #   * strip exactly one trailing newline (so the final newline is
            #     held until we know whether anything follows it)
            #   * a complete value of "null" is JSON null, not a string, so
            #     the opening quote waits until the value is longer than
            #     "null" or the parameter closes
            if not self._leading_stripped:
                if chunk.startswith("\n"):
                    chunk = chunk[1:]
                self._leading_stripped = True
            if end >= 0 and chunk.endswith("\n"):
                chunk = chunk[:-1]
            if not self._opened_quote:
                self._value_buf += chunk
                if end < 0 and len(self._value_buf) <= 4:
                    break
                if end >= 0 and self._value_buf.lower() == "null":
                    out.append(f"{json.dumps(self._value_name)}:null")
                    self._in_value = False
                    continue
                out.append(f"{json.dumps(self._value_name)}:\"")
                self._opened_quote = True
                chunk = self._value_buf
                self._value_buf = ""
            if self._pending_newline and chunk:
                out.append(_json_fragment("\n"))
                self._emitted_value_chars += 1
                self._pending_newline = False
            if end < 0 and chunk.endswith("\n"):
                chunk = chunk[:-1]
                self._pending_newline = True
            if chunk:
                out.append(_json_fragment(chunk))
                self._emitted_value_chars += len(chunk)
            if end < 0:
                break
            # A held newline at close was the trailing one: drop it.
            self._pending_newline = False
            out.append('"')
            self._in_value = False
        return "".join(out)

    def finish(self) -> str:
        """Close whatever is open, so a truncated call still yields JSON."""
        if self._closed:
            return ""
        out: List[str] = [self._open()]
        if self._in_value:
            if self._value_is_string:
                if not self._opened_quote:
                    out.append(f"{json.dumps(self._value_name)}:\"")
                    out.append(_json_fragment(self._value_buf))
                out.append('"')
            else:
                value = self._value_buf
                if value.startswith("\n"):
                    value = value[1:]
                if value.endswith("\n"):
                    value = value[:-1]
                out.append(f"{json.dumps(self._value_name)}:")
                try:
                    out.append(
                        json.dumps(convert_param_value(value, self._value_name, self.param_config))
                    )
                except Exception:
                    out.append(json.dumps(value))
            self._in_value = False
        out.append("}")
        self._closed = True
        return "".join(out)
