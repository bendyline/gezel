"""Differential tests: incremental JSON conversion == mlx_vlm's reference parser.

The incremental encoder only earns its keep if it is byte-for-byte equivalent
to `qwen3_coder.parse_tool_call` on complete input. Rather than assert on
hand-written JSON (which would drift from upstream the moment they change a
coercion rule), every case here parses the SAME markup both ways and compares
the resulting objects — and does it at every chunk boundary, because chunking
is where a streaming converter actually breaks.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tool_args_json import ToolArgsJsonEncoder, arguments_config  # noqa: E402


class _ReferenceUnavailable(RuntimeError):
    """mlx_vlm is absent — the differential half of this suite cannot run."""

TOOLS = [
    {
        "function": {
            "name": "write_file",
            "parameters": {
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "mode": {"type": "integer"},
                    "overwrite": {"type": "boolean"},
                    "meta": {"type": "object"},
                    "ratio": {"type": "number"},
                }
            },
        }
    }
]


def reference(body: str, tools=TOOLS):
    """Parse via mlx_vlm, or skip when the venv is not importable."""
    venv = os.path.expanduser("~/.gezel-dev/engines/uv/venvs/mlx/lib")
    for root, dirs, _ in os.walk(venv):
        if "site-packages" in dirs:
            sys.path.insert(0, os.path.join(root, "site-packages"))
            break
    try:
        from mlx_vlm.tool_parsers import qwen3_coder  # type: ignore
    except Exception as exc:  # mlx not installed (CI): skip, do not fail
        raise _ReferenceUnavailable(str(exc)) from exc

    # `process_tool_calls` strips the <tool_call> markers before calling the
    # parser, and the parser anchors on `</function>$` — so pass the bare call.
    return qwen3_coder.parse_tool_call(f"<function={body}", tools)


def incremental(body: str, chunk_size: int, tools=TOOLS):
    """Run the encoder over `body` (after `<function=NAME>`) in fixed chunks."""
    name, rest = body.split(">", 1)
    enc = ToolArgsJsonEncoder(param_config=arguments_config(name, tools))
    out = []
    for i in range(0, len(rest), chunk_size):
        out.append(enc.feed(rest[i : i + chunk_size]))
    out.append(enc.finish())
    return name, json.loads("".join(out))


def assert_matches(body: str):
    ref = reference(body)
    for size in (1, 2, 3, 7, 13, 64, 100_000):
        name, args = incremental(body, size)
        assert name == ref["name"], f"name mismatch at chunk={size}"
        assert args == ref["arguments"], (
            f"chunk={size}\n  ref={ref['arguments']!r}\n  got={args!r}"
        )


def test_single_string_param():
    assert_matches("write_file><parameter=path>a.html</parameter></function>")


def test_two_string_params():
    assert_matches(
        "write_file><parameter=path>a.html</parameter>"
        "<parameter=content>hello world</parameter></function>"
    )


def test_leading_and_trailing_newline_are_stripped():
    # Upstream strips exactly one of each; the streaming version has to hold
    # the last newline back to know whether it is the trailing one.
    assert_matches(
        "write_file><parameter=content>\nline one\nline two\n</parameter></function>"
    )


def test_interior_newlines_survive():
    assert_matches(
        "write_file><parameter=content>\na\n\nb\n</parameter></function>"
    )


def test_html_payload_with_quotes_and_escapes():
    html = '<!doctype html><html><body><script>const s="hi\\n";</script></body></html>'
    assert_matches(f"write_file><parameter=content>{html}</parameter></function>")


def test_integer_param_is_coerced():
    assert_matches("write_file><parameter=mode>420</parameter></function>")


def test_boolean_param_is_coerced():
    assert_matches("write_file><parameter=overwrite>true</parameter></function>")


def test_number_param_whole_becomes_int():
    assert_matches("write_file><parameter=ratio>2.0</parameter></function>")


def test_number_param_fractional_stays_float():
    assert_matches("write_file><parameter=ratio>2.5</parameter></function>")


def test_object_param_is_parsed():
    assert_matches('write_file><parameter=meta>{"a": 1}</parameter></function>')


def test_null_literal_becomes_none():
    assert_matches("write_file><parameter=path>null</parameter></function>")


def test_param_absent_from_schema_is_a_string():
    assert_matches("write_file><parameter=unknown>42</parameter></function>")


def test_mixed_types_in_one_call():
    assert_matches(
        "write_file><parameter=path>a.html</parameter>"
        "<parameter=mode>420</parameter>"
        "<parameter=overwrite>false</parameter>"
        "<parameter=content>\n<html></html>\n</parameter></function>"
    )


def test_value_containing_marker_like_text():
    # A payload that mentions </parameter is the nastiest chunking case.
    assert_matches(
        "write_file><parameter=content>talking about &lt;/parameter&gt; here</parameter></function>"
    )


def test_truncated_call_still_yields_valid_json():
    # No reference to compare against (upstream raises), but the encoder must
    # never emit malformed JSON — the client parses it either way.
    enc = ToolArgsJsonEncoder(param_config=arguments_config("write_file", TOOLS))
    text = enc.feed("<parameter=content>\n<!doctype html><html>")
    text += enc.finish()
    parsed = json.loads(text)
    assert "content" in parsed and parsed["content"].startswith("<!doctype")


def test_empty_call_yields_empty_object():
    enc = ToolArgsJsonEncoder(param_config={})
    assert json.loads(enc.feed("</function>")) == {}


if __name__ == "__main__":
    failed = 0
    skipped = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  PASS {name}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {name}: {exc}")
        except _ReferenceUnavailable as exc:
            skipped += 1
            print(f"  SKIP {name}: {exc}")
        except Exception as exc:  # import/venv problems should be loud, not silent
            failed += 1
            print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"\n{failed} failure(s), {skipped} skipped")
    sys.exit(1 if failed else 0)
