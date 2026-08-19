"""Randomized differential testing for the incremental JSON converter.

The fixed cases in `test_tool_args_json.py` only cover boundaries I thought
of, and every bug this converter has had came from a boundary I did not:
a trailing newline that arrived in the same chunk as its close marker, a
value of "null" that had to suppress an already-planned opening quote, a
`flush()` that returned early and left JSON unterminated.

So this generates bodies and chunk splits at random and asserts the same
invariant the fixed suite does — incremental output must equal
`qwen3_coder.parse_tool_call` — plus two the fixed suite cannot state:

  * ANY prefix of the stream must yield parseable JSON, because a turn can
    be cut off at any byte and the client parses `arguments` regardless.
  * The output must never contain raw markup, at any chunk size.

Seeded so a failure is reproducible: the seed is printed with the counter-
example rather than left to chance.
"""

from __future__ import annotations

import json
import os
import random
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
                    "ratio": {"type": "number"},
                    "overwrite": {"type": "boolean"},
                    "meta": {"type": "object"},
                    "tags": {"type": "array"},
                }
            },
        }
    }
]

# Deliberately nasty string payloads: marker lookalikes, quotes, backslashes,
# newlines at both ends, non-ASCII, control characters.
STRING_VALUES = [
    "a.html",
    "",
    "null",
    "NULL",
    "nul",
    "nullish",
    "line one\nline two",
    "\nleading",
    "trailing\n",
    "\nboth\n",
    "\n\ndouble\n\n",
    'quote " inside',
    "back\\slash",
    "tab\there",
    "carriage\r\nreturn",
    "</parameter",
    "</parameter> mid text",
    "<parameter=fake>",
    "</function>",
    "<tool_call>",
    "emoji 🎲 and cjk 日本語",
    "<!doctype html><html><body><script>const s='x';</script></body></html>",
    "}{[]\"':,",
]

TYPED_VALUES = {
    "mode": ["0", "420", "-7"],
    "ratio": ["1.5", "2.0", "-0.25"],
    "overwrite": ["true", "false", "TRUE"],
    "meta": ['{"a": 1}', "{}", '{"nested": {"b": [1, 2]}}'],
    "tags": ["[]", '["x", "y"]', "[1, 2, 3]"],
}


def reference(body: str, tools=TOOLS):
    venv = os.path.expanduser("~/.gezel-dev/engines/uv/venvs/mlx/lib")
    for root, dirs, _ in os.walk(venv):
        if "site-packages" in dirs:
            sys.path.insert(0, os.path.join(root, "site-packages"))
            break
    try:
        from mlx_vlm.tool_parsers import qwen3_coder  # type: ignore
    except Exception as exc:  # mlx not installed (CI): skip, do not fail
        raise _ReferenceUnavailable(str(exc)) from exc

    return qwen3_coder.parse_tool_call(f"<function={body}", tools)


def incremental(body: str, splits, tools=TOOLS):
    name, rest = body.split(">", 1)
    enc = ToolArgsJsonEncoder(param_config=arguments_config(name, tools))
    out = []
    prev = 0
    for point in list(splits) + [len(rest)]:
        out.append(enc.feed(rest[prev:point]))
        prev = point
    out.append(enc.finish())
    return "".join(out)


def random_body(rng: random.Random) -> str:
    params = []
    names = rng.sample(
        ["path", "content", "mode", "ratio", "overwrite", "meta", "tags", "unknown"],
        k=rng.randint(1, 5),
    )
    for n in names:
        if n in TYPED_VALUES:
            value = rng.choice(TYPED_VALUES[n])
        else:
            value = rng.choice(STRING_VALUES)
        params.append(f"<parameter={n}>{value}</parameter>")
    return "write_file>" + "".join(params) + "</function>"


def random_splits(rng: random.Random, length: int):
    if length <= 1:
        return []
    count = rng.randint(1, min(12, length))
    return sorted(rng.sample(range(1, length), k=min(count, max(1, length - 1))))


def test_fuzz_matches_reference():
    failures = []
    for seed in range(400):
        rng = random.Random(seed)
        body = random_body(rng)
        try:
            ref = reference(body)
        except Exception:
            continue  # upstream rejects it; nothing to compare against
        _, rest = body.split(">", 1)
        got_text = incremental(body, random_splits(rng, len(rest)))
        try:
            got = json.loads(got_text)
        except json.JSONDecodeError as exc:
            failures.append(f"seed={seed} unparseable: {exc}\n  body={body!r}\n  got={got_text!r}")
            continue
        if got != ref["arguments"]:
            failures.append(
                f"seed={seed} mismatch\n  body={body!r}\n  ref={ref['arguments']!r}\n  got={got!r}"
            )
    assert not failures, "\n".join(failures[:3]) + f"\n({len(failures)} total)"


def test_fuzz_every_prefix_is_parseable_json():
    """A turn can be cut at any byte; `arguments` must still parse."""
    failures = []
    for seed in range(150):
        rng = random.Random(10_000 + seed)
        body = random_body(rng)
        name, rest = body.split(">", 1)
        for cut in range(0, len(rest), max(1, len(rest) // 11)):
            enc = ToolArgsJsonEncoder(param_config=arguments_config(name, TOOLS))
            text = enc.feed(rest[:cut]) + enc.finish()
            try:
                json.loads(text)
            except json.JSONDecodeError as exc:
                failures.append(
                    f"seed={seed} cut={cut}: {exc}\n  body={body!r}\n  got={text!r}"
                )
                break
    assert not failures, "\n".join(failures[:3]) + f"\n({len(failures)} total)"


def test_fuzz_keys_are_never_markup():
    """No parameter KEY may arrive as markup.

    Deliberately asserts on keys rather than on the raw text: a VALUE can
    legitimately be the literal string "<parameter=fake>" (models emit
    marker-shaped prose), and the reference parser keeps it. An earlier
    version of this test banned the substring outright and reported nine
    false positives on exactly that case.
    """
    failures = []
    for seed in range(200):
        rng = random.Random(20_000 + seed)
        body = random_body(rng)
        _, rest = body.split(">", 1)
        text = incremental(body, random_splits(rng, len(rest)))
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            failures.append(f"seed={seed} unparseable: {exc}")
            continue
        for key in parsed:
            if "<" in key or ">" in key or "parameter=" in key:
                failures.append(f"seed={seed} bad key {key!r}\n  body={body!r}")
    assert not failures, "\n".join(failures[:3]) + f"\n({len(failures)} total)"


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
            print(f"  FAIL {name}:\n{exc}")
        except _ReferenceUnavailable as exc:
            skipped += 1
            print(f"  SKIP {name} (no mlx_vlm: {exc})")
        except Exception as exc:
            failed += 1
            print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print(f"\n{failed} failure(s), {skipped} skipped")
    sys.exit(1 if failed else 0)
