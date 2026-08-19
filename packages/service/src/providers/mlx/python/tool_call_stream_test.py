"""Unit tests for the incremental tool-call delta splitter."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tool_call_stream import ToolCallStreamState  # noqa: E402


TOOLS = [
    {
        "function": {
            "name": "write_file",
            "parameters": {"properties": {"path": {"type": "string"}}},
        }
    }
]


def state() -> ToolCallStreamState:
    return ToolCallStreamState(
        start_marker="<tool_call>",
        end_marker="</tool_call>",
        request_id="req1",
        tools=TOOLS,
    )


def collect(st: ToolCallStreamState, chunks):
    out = []
    for c in chunks:
        out.extend(st.feed(c))
    out.extend(st.flush())
    return out


def test_plain_content_passes_through():
    st = state()
    got = collect(st, ["Hello ", "world"])
    assert [d.content for d in got] == ["Hello ", "world"]
    assert all(d.arguments is None for d in got)


def test_single_tool_call_becomes_argument_deltas():
    st = state()
    got = collect(
        st,
        ["<tool_call>", "<function=write_file>", "<parameter=path>a.html", "</function>", "</tool_call>"],
    )
    assert [d.content for d in got if d.content] == []
    assert got[0].tool_call_id == "req1-tc-0"
    # The name MUST be populated: an empty function.name made the provider
    # reject every call ("The model's `` calls failed 5 times in a row").
    assert got[0].name == "write_file"
    assert sum(1 for d in got if d.tool_call_id) == 1
    assert all(d.tool_call_index == 0 for d in got)
    assert "a.html" in "".join(d.arguments or "" for d in got)


def test_name_split_across_chunks_is_still_recovered():
    import json as _json

    st = state()
    got = collect(
        st,
        ["<tool_call>", "<func", "tion=write_", "file>", "<parameter=path>a.html",
         "</parameter></function>", "</tool_call>"],
    )
    assert [d.name for d in got if d.name] == ["write_file"]
    assert _json.loads("".join(d.arguments or "" for d in got)) == {"path": "a.html"}


def test_call_with_no_parsable_name_falls_back_to_content():
    # Never announce a nameless call; hand the text back so the salvage
    # layer can still work with it.
    st = state()
    got = collect(st, ["<tool_call>", "just prose", "</tool_call>"])
    assert [d.name for d in got if d.name] == []
    assert "just prose" in "".join(d.content or "" for d in got)


def test_content_before_and_after_a_call_stays_content():
    st = state()
    got = collect(
        st, ["thinking...", "<tool_call>", "<function=x>{}", "</tool_call>", " done"]
    )
    assert "thinking..." in "".join(d.content or "" for d in got)
    assert " done" in "".join(d.content or "" for d in got)
    assert [d.name for d in got if d.name] == ["x"]


def test_marker_split_across_chunks_is_not_leaked_as_content():
    # The regression this class exists to avoid: a naive splitter emits
    # "<tool_" into the visible transcript when the marker straddles a chunk.
    st = state()
    got = collect(st, ["before", "<tool", "_call>", "<function=a>1", "</tool_call>"])
    assert "before" in "".join(d.content or "" for d in got)
    assert [d.name for d in got if d.name] == ["a"]


def test_end_marker_split_across_chunks():
    st = state()
    got = collect(st, ["<tool_call>", "<function=a>1", "</tool", "_call>", "tail"])
    assert [d.name for d in got if d.name] == ["a"]
    assert "tail" in "".join(d.content or "" for d in got)


def test_two_sequential_calls_get_distinct_indices():
    st = state()
    got = collect(
        st, ["<tool_call>", "<function=a>1", "</tool_call>", "<tool_call>", "<function=b>2", "</tool_call>"]
    )
    ids = [d.tool_call_id for d in got if d.tool_call_id]
    assert ids == ["req1-tc-0", "req1-tc-1"]
    assert {d.tool_call_index for d in got if d.tool_call_index is not None} == {0, 1}


def test_truncated_call_flushes_partial_arguments():
    # A turn cut off mid-body must still hand its bytes downstream as VALID
    # JSON — the salvage fallback needs the partial call, not a hole, and the
    # client parses `arguments` either way.
    import json as _json

    st = state()
    got = collect(
        st, ["<tool_call>", "<function=write_file>", "<parameter=path>index.ht"]
    )
    assert _json.loads("".join(d.arguments or "" for d in got)) == {"path": "index.ht"}
    assert st.in_tool_call is True


def test_trailing_partial_start_marker_flushes_as_content():
    st = state()
    got = collect(st, ["all done <tool"])
    assert "".join(d.content or "" for d in got) == "all done <tool"


def test_incremental_feed_matches_single_shot():
    whole = 'pre<tool_call><function=k>v</tool_call>post'
    a = collect(state(), [whole])
    b = collect(state(), list(whole))
    key = lambda ds: ("".join(d.content or "" for d in ds), "".join(d.arguments or "" for d in ds))
    assert key(a) == key(b)


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  PASS {name}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL {name}: {exc}")
    print(f"\n{failed} failure(s)")
    sys.exit(1 if failed else 0)


def test_arguments_are_json_not_raw_markup():
    """The bug that made every call fail validation: raw `<parameter=` markup
    reached the provider as `function.arguments`, which must be JSON."""
    import json as _json

    st = state()
    got = collect(
        st,
        [
            "<tool_call><function=write_file>",
            "<parameter=path>a.html</parameter>",
            "</function></tool_call>",
        ],
    )
    args = "".join(d.arguments or "" for d in got)
    assert "<parameter=" not in args, f"raw markup leaked: {args!r}"
    assert _json.loads(args) == {"path": "a.html"}


def test_truncated_call_still_yields_parseable_json():
    import json as _json

    st = state()
    got = collect(st, ["<tool_call><function=write_file><parameter=path>a.ht"])
    args = "".join(d.arguments or "" for d in got)
    assert _json.loads(args) == {"path": "a.ht"}
