"""Token-level proof for tool_grammar against REAL tokenizers.

This is the test that actually matters: a grammar can be well-formed
(`validate_grammar` == '') yet still be unable to accept the real token
stream — e.g. if it forbids the special tokens the model emits
(`<tool_call>`/`<think>` for Qwen, `<|tool_call>`/`<|"|>`/`<|channel>` for
Gemma). String-level tests can't catch that; this one does.

Needs an installed Qwen and/or Gemma MLX model (for its tokenizer only — no
weights are loaded). Auto-discovers them under the dev/app homes; runs the
cases for whichever families are present and skips (exit 0) if neither is.

    "$HOME/.gezel-dev/engines/uv/venvs/mlx/bin/python3" tool_grammar_modeltest.py
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import tool_grammar as tg  # noqa: E402

CANDIDATE_HOMES = [
    os.path.expanduser("~/.gezel-dev/engines/mlx/models"),
    "/Library/Application Support/Gezel/engines/mlx/models",
    os.path.expanduser("~/Library/Application Support/Gezel/engines/mlx/models"),
]

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "create_project",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "description": {"type": "string"}},
            },
        },
    },
    {
        "type": "function",
        "function": {"name": "list_projects", "parameters": {"type": "object", "properties": {}}},
    },
]


def _find_model_dir(prefix: str):
    for home in CANDIDATE_HOMES:
        if not os.path.isdir(home):
            continue
        # Prefer the smallest installed match (faster tokenizer load).
        for d in sorted(x for x in os.listdir(home) if x.startswith(prefix)):
            cand = os.path.join(home, d)
            if os.path.exists(os.path.join(cand, "tokenizer_config.json")) or os.path.exists(
                os.path.join(cand, "tokenizer.json")
            ):
                return cand
    return None


def _load(model_dir):
    from transformers import AutoTokenizer
    import llguidance.hf

    tok = AutoTokenizer.from_pretrained(model_dir)
    llg = llguidance.hf.from_tokenizer(tok)
    return tok, llg


def _accepts_fn(tok, llg, grammar):
    from llguidance import LLMatcher

    def accepts(text) -> bool:
        toks = tok.encode(text, add_special_tokens=False)
        return LLMatcher(llg, grammar).validate_tokens(toks) == len(toks)

    return accepts


def _report(label, cases):
    failed = 0
    for desc, got, want in cases:
        ok = got == want
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'} [{label}] {desc} (accepted={got}, expected={want})")
    return failed, len(cases)


def test_hermes(model_dir):
    from llguidance import LLMatcher

    tok, llg = _load(model_dir)
    grammar = tg.build_grammar_string(TOOLS, {"format": "hermes"})  # tier 2 default
    assert grammar is not None
    assert LLMatcher.validate_grammar(grammar, llg) == "", "hermes grammar invalid on tokenizer"
    accepts = _accepts_fn(tok, llg, grammar)
    think = "<think>\nI'll create it.\n</think>\n"
    TC = lambda body: think + "<tool_call>\n" + body + "\n</tool_call>"
    valid = TC("<function=create_project>\n<parameter=name>\nX\n</parameter>\n</function>")
    fake = TC("<function=totally_fake>\n</function>")
    param_as_fn = TC("<function=description>\n</function>")
    bad_key = TC("<function=create_project>\n<parameter=bogus_key>\nX\n</parameter>\n</function>")
    return _report(
        "hermes",
        [
            ("valid call + valid param key accepted", accepts(valid), True),
            ("hallucinated function name rejected", accepts(fake), False),
            ("param-as-function (description) rejected", accepts(param_as_fn), False),
            ("tier2: bogus param key rejected", accepts(bad_key), False),
            ("thinking, no call accepted", accepts(think + "The answer is 42."), True),
            ("plain text, no call accepted", accepts("Just a normal answer."), True),
        ],
    )


STRUCTURAL_TOOLS = TOOLS + [
    {
        "type": "function",
        "function": {
            "name": "convert_document",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {"type": "object", "properties": {"path": {"type": "string"}}},
                    "targets": {"type": "array", "items": {"type": "object"}},
                },
            },
        },
    },
]


def test_hermes_json_escape(model_dir):
    """A tool with object/array parameters must be CALLABLE.

    The `<parameter=KEY>text</parameter>` shape is a flat KEY→text map, so
    a nested `source`/`targets` value cannot be expressed in it at all —
    the model emits correct JSON, the markup flattens it to a string, the
    validator rejects `got string, expected object`, and the model retries
    the identical call forever. Observed in the wild for 19 consecutive
    attempts. The grammar must therefore also admit the JSON envelope,
    while keeping name/key pinning on the markup branch.
    """
    import json

    from llguidance import LLMatcher

    tok, llg = _load(model_dir)
    grammar = tg.build_grammar_string(STRUCTURAL_TOOLS, {"format": "hermes"})
    assert grammar is not None
    assert LLMatcher.validate_grammar(grammar, llg) == "", "escape grammar invalid on tokenizer"
    accepts = _accepts_fn(tok, llg, grammar)
    think = "<think>\nplanning\n</think>\n"
    TC = lambda body: think + "<tool_call>\n" + body + "\n</tool_call>"
    nested = json.dumps(
        {
            "name": "convert_document",
            "arguments": {
                "source": {"kind": "file", "rootId": "root-1", "path": "deck.md"},
                "targets": [{"format": "pptx", "fidelity": "editable-native"}],
            },
        }
    )
    flat_call = TC("<function=create_project>\n<parameter=name>\nX\n</parameter>\n</function>")
    bad_key = TC("<function=create_project>\n<parameter=bogus>\nX\n</parameter>\n</function>")
    return _report(
        "hermes-json-escape",
        [
            ("JSON envelope carrying nested args accepted", accepts(TC(nested)), True),
            ("markup branch still accepted", accepts(flat_call), True),
            ("markup branch still pins names", accepts(TC("<function=nope>\n</function>")), False),
            ("markup branch still pins param keys", accepts(bad_key), False),
            ("plain text, no call accepted", accepts("Just a normal answer."), True),
        ],
    )


def test_gemma(model_dir):
    from llguidance import LLMatcher

    tok, llg = _load(model_dir)
    grammar = tg.build_grammar_string(TOOLS, {"format": "gemma"})  # tier 1 (name-only)
    assert grammar is not None
    assert LLMatcher.validate_grammar(grammar, llg) == "", "gemma grammar invalid on tokenizer"
    accepts = _accepts_fn(tok, llg, grammar)
    valid = '<|tool_call>call:create_project{name:<|"|>My App<|"|>,description:<|"|>x<|"|>}<tool_call|>'
    reasoning = "<|channel>analysis\nI will create it.<channel|>" + valid
    think = '<|think|>hmm<|tool_call>call:list_projects{}<tool_call|>'
    fake = '<|tool_call>call:totally_fake{}<tool_call|>'
    # String value carrying a newline, a brace, and a quote — must still parse,
    # since `<|"|>...<|"|>` content is free text (this is why we don't pin args).
    multiline = '<|tool_call>call:create_project{description:<|"|>line1\nline2 with } and "q"<|"|>}<tool_call|>'
    return _report(
        "gemma",
        [
            ("valid call accepted", accepts(valid), True),
            ("reasoning(channel)+call accepted", accepts(reasoning), True),
            ("think+call accepted", accepts(think), True),
            ("hallucinated function name rejected", accepts(fake), False),
            ("multiline/special-char string value accepted", accepts(multiline), True),
            (
                "channel reasoning, no call accepted",
                accepts("<|channel>analysis\njust thinking<channel|>"),
                True,
            ),
            ("plain text, no call accepted", accepts("Just a normal answer."), True),
        ],
    )


def _find_model_dirs(prefix: str):
    """Every installed match, one per distinct tokenizer CONTENT.

    Testing only the first alphabetical match leaves every other
    tokenizer untested: `sorted()` always picked gemma4-12b, so nobody
    knew whether the E-models shared its vocab or not until a wild
    grammar-vs-vocab suspicion forced a manual check (they do — their
    tokenizer.json is byte-identical to mainline's). Dedupe by content
    hash so identical tokenizers run once, and any future model that
    ships a genuinely different vocab is guaranteed its own pass.
    """
    import hashlib

    seen = set()
    out = []
    for home in CANDIDATE_HOMES:
        if not os.path.isdir(home):
            continue
        for d in sorted(x for x in os.listdir(home) if x.startswith(prefix)):
            cand = os.path.join(home, d)
            tok_file = next(
                (
                    p
                    for p in (
                        os.path.join(cand, "tokenizer.json"),
                        os.path.join(cand, "tokenizer_config.json"),
                    )
                    if os.path.exists(p)
                ),
                None,
            )
            if tok_file is None:
                continue
            h = hashlib.md5()
            with open(tok_file, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            key = h.hexdigest()
            if key in seen:
                continue
            seen.add(key)
            out.append(cand)
    return out


def main():
    qwens = _find_model_dirs("qwen")
    gemmas = _find_model_dirs("gemma")
    if not qwens and not gemmas:
        print("SKIP: no installed Qwen or Gemma MLX model found (tokenizer needed)")
        sys.exit(0)

    failed = total = 0
    for qwen in qwens:
        print(f"== hermes / tokenizer: {qwen} ==")
        f, t = test_hermes(qwen)
        failed += f
        total += t
        f, t = test_hermes_json_escape(qwen)
        failed += f
        total += t
    if not qwens:
        print("SKIP hermes: no installed Qwen MLX model")
    for gemma in gemmas:
        print(f"== gemma / tokenizer: {gemma} ==")
        f, t = test_gemma(gemma)
        failed += f
        total += t
    if not gemmas:
        print("SKIP gemma: no installed Gemma MLX model")

    print(f"\n{total - failed}/{total} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
