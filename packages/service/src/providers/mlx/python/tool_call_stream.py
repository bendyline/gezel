"""Incremental tool-call deltas for the gezel MLX server.

Why this exists
---------------
llama-server streams tool calls in a dedicated channel: the client watches
`tool_calls[].function.arguments` grow and can end the turn the moment the
call is usable (`ABORT-FIRED reason=immediate-write-structured`). The MLX
route historically streamed the model's tool markup as ordinary content and
let the gezel side salvage it afterwards. That works, but it has no turn
boundary, so every turn generates to completion — measured 2026-08-17 over
10 tictactoe/tankcombat trials, 41 turns ended with `toolCalls=0` at a median
136s each, 203 minutes in total, against llama-cpp cutting the equivalent
turn at 95s with the write already in hand.

An earlier attempt to approximate the abort on the *text* stream was reverted:
a tic-tac-toe page emits `</html>` well before its inline script is complete,
so "the markup looks finished" is not "the file is finished" and the write was
truncated (5/5 -> 0/3). The boundary has to come from the tool-call grammar,
not from the document.

What this does
--------------
`mlx_vlm` 0.6.6 ships `process_tool_calls`, but it parses the FULL output at
end of turn — correct, yet still no earlier than generating everything. So we
do the incremental part here: watch the token stream for the parser's own
`tool_call_start` / `tool_call_end` markers, and emit OpenAI-shaped
`tool_calls` argument deltas as the bytes arrive. Our llguidance grammar
already constrains output to exactly that shape, so the boundaries are
deterministic rather than best-effort.

Deliberately conservative:
  * Content before the first marker still streams as `delta.content`, so a
    model that never calls a tool is unaffected.
  * A partial marker at the end of a chunk is held back rather than emitted
    as content — otherwise `<tool_` leaks into the visible transcript.
  * When no parser matches the model, this stays disabled and the existing
    salvage path is untouched.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from tool_args_json import ToolArgsJsonEncoder, arguments_config


@dataclass
class ToolCallDelta:
    """One OpenAI-shaped streaming fragment."""

    content: Optional[str] = None
    tool_call_index: Optional[int] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None
    arguments: Optional[str] = None


def _parse_tool_name(buf: str) -> Optional[Tuple[str, str]]:
    """Split `<function=NAME>rest` into `(NAME, rest)`, or None if incomplete.

    Returns None while the opening tag is still arriving so the caller can
    wait rather than announce a call with a partial name.
    """
    marker = "<function="
    start = buf.find(marker)
    if start < 0:
        # Not this shape at all (a parser whose body is bare JSON); once the
        # call closes the caller falls back to content.
        return None if marker.startswith(buf.strip()[: len(marker)]) or not buf.strip() else None
    close = buf.find(">", start + len(marker))
    if close < 0:
        return None
    name = buf[start + len(marker) : close].strip()
    if not name:
        return None
    return name, buf[close + 1 :]


@dataclass
class ToolCallStreamState:
    """Split a raw token stream into content and tool-call argument deltas.

    Feed decoded text as it arrives; each call returns the fragments to emit.
    The instance keeps whatever trailing bytes might be the beginning of a
    marker, so callers must treat the return value as the complete set of
    emissions for that chunk rather than assuming the input passes through.
    """

    start_marker: str
    end_marker: str
    request_id: str
    tools: Optional[Any] = None
    in_tool_call: bool = False
    call_index: int = -1
    announced: bool = False
    pending: str = ""
    _emitted_args: int = 0
    _name_buf: str = ""
    _encoder: Optional[ToolArgsJsonEncoder] = None
    completed: List[str] = field(default_factory=list)

    def _maybe_partial_marker(self, text: str, marker: str) -> int:
        """Length of the trailing run of `text` that could start `marker`."""
        limit = min(len(text), len(marker) - 1)
        for size in range(limit, 0, -1):
            if marker.startswith(text[-size:]):
                return size
        return 0

    def feed(self, chunk: str) -> List[ToolCallDelta]:
        out: List[ToolCallDelta] = []
        self.pending += chunk
        while self.pending:
            if not self.in_tool_call:
                idx = self.pending.find(self.start_marker)
                if idx < 0:
                    hold = self._maybe_partial_marker(self.pending, self.start_marker)
                    emit = self.pending[: len(self.pending) - hold] if hold else self.pending
                    self.pending = self.pending[len(self.pending) - hold :] if hold else ""
                    if emit:
                        out.append(ToolCallDelta(content=emit))
                    return out
                before = self.pending[:idx]
                if before:
                    out.append(ToolCallDelta(content=before))
                self.pending = self.pending[idx + len(self.start_marker) :]
                self.in_tool_call = True
                self.call_index += 1
                self.announced = False
                self._emitted_args = 0
                continue

            idx = self.pending.find(self.end_marker)
            body = self.pending if idx < 0 else self.pending[:idx]
            if idx < 0:
                hold = self._maybe_partial_marker(body, self.end_marker)
                if hold:
                    body = body[: len(body) - hold]
                self.pending = self.pending[len(body) :]
            else:
                self.pending = self.pending[idx + len(self.end_marker) :]

            if not self.announced:
                # Hold the head of the call until the tool NAME is complete.
                # The body opens `<function=NAME>` and OpenAI's shape needs
                # `function.name` populated — emitting an empty name made the
                # provider reject every call ("The model's `` calls failed 5
                # times in a row"), which is a hard turn failure, not a
                # degraded one.
                self._name_buf += body
                name = _parse_tool_name(self._name_buf)
                if name is None:
                    if idx < 0:
                        return out
                    # End marker arrived without a parsable name: hand the
                    # raw text back as content so the salvage layer still
                    # sees it rather than losing the call entirely.
                    out.append(ToolCallDelta(content=self._name_buf))
                    self._name_buf = ""
                    self.in_tool_call = False
                    continue
                head, rest = name
                # Convert the markup body to JSON as it streams: OpenAI's
                # `function.arguments` must be a JSON string, and shipping raw
                # `<parameter=K>V` made the provider reject every call for
                # missing required fields.
                self._encoder = ToolArgsJsonEncoder(
                    param_config=arguments_config(head, self.tools)
                )
                json_text = self._encoder.feed(rest)
                if idx >= 0:
                    json_text += self._encoder.finish()
                delta = ToolCallDelta(
                    tool_call_index=self.call_index,
                    tool_call_id=f"{self.request_id}-tc-{self.call_index}",
                    name=head,
                    arguments=json_text,
                )
                self.announced = True
                self._name_buf = ""
                self._emitted_args += len(json_text)
                out.append(delta)
            elif body or idx >= 0:
                json_text = self._encoder.feed(body) if self._encoder else body
                if idx >= 0 and self._encoder is not None:
                    json_text += self._encoder.finish()
                if json_text:
                    self._emitted_args += len(json_text)
                    out.append(
                        ToolCallDelta(tool_call_index=self.call_index, arguments=json_text)
                    )

            if idx < 0:
                return out
            self.in_tool_call = False
            self._encoder = None
            self.completed.append(str(self.call_index))
        return out

    def flush(self) -> List[ToolCallDelta]:
        """Emit whatever is left once generation stops.

        A truncated turn can end mid-marker; those bytes are real model output
        and belong in whichever channel was open, otherwise the salvage
        fallback downstream sees a hole rather than a partial call.
        """
        if not self.pending and not self.in_tool_call:
            return []
        # An open call MUST be closed even with nothing buffered: the encoder
        # still owes a `"` and `}`, and without them the client parses
        # `arguments` and gets "Unterminated string".
        rest, self.pending = self.pending, ""
        if self.in_tool_call and not self.announced:
            # Truncated before the name completed — give the bytes back as
            # content so the salvage fallback can still recover something.
            return [ToolCallDelta(content=self._name_buf + rest)]
        if self.in_tool_call:
            if self._encoder is not None:
                tail = self._encoder.feed(rest) + self._encoder.finish()
                self._encoder = None
                return [ToolCallDelta(tool_call_index=self.call_index, arguments=tail)]
            return [ToolCallDelta(tool_call_index=self.call_index, arguments=rest)]
        return [ToolCallDelta(content=rest)]


def resolve_tool_markers(processor) -> Optional[Tuple[str, str]]:
    """Find the `(start, end)` tool-call markers for a loaded model, if any.

    Uses mlx_vlm's own inference — it matches markers found in the model's
    chat template against its parser registry — so this stays in step with
    upstream instead of hardcoding a table. Qwen 3.8's template carries
    `<tool_call>\n<function=`, which resolves to the `qwen3_coder` parser and
    the `<tool_call>` / `</tool_call>` pair our llguidance grammar emits.

    Returns None when nothing matches; the caller must then leave streaming
    extraction off and keep the existing text-salvage path.
    """
    try:
        from mlx_vlm.tool_parsers import (  # type: ignore
            _infer_tool_parser_from_processor,
            load_tool_module,
        )
    except Exception:
        return None
    try:
        parser_type = _infer_tool_parser_from_processor(processor)
        if not parser_type:
            return None
        module = load_tool_module(parser_type)
    except Exception:
        return None
    start = getattr(module, "tool_call_start", None)
    end = getattr(module, "tool_call_end", None)
    if isinstance(start, str) and isinstance(end, str) and start and end:
        return start, end
    return None
