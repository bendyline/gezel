/**
 * Display-side defensive scrub of tool-call markup that leaked
 * through the salvage layer. The salvage cascade already strips
 * recognized markup when it successfully promotes a tool call to a
 * structured `tool_calls` event — but every so often a model emits
 * a malformed shape (truncated tags, missing closings, hybrid
 * formats Qwen-Hermes) that the salvager's regex won't match. The
 * call gets dropped on the floor; the markup persists in the
 * stored message; the user sees gross XML in the bubble.
 *
 * This helper is the human-only safety net. It runs only in the
 * render path (not the persistence path), so the model's next-turn
 * transcript still contains the markup it actually emitted —
 * stripping at the service level would hide the model's mistakes
 * from itself, which makes "why did this turn produce no result?"
 * harder for the model to reason about. The transcript is honest;
 * the bubble is clean.
 *
 * The patterns are deliberately conservative — only well-formed
 * pairs of unmistakable tool-call markup are stripped. If the user
 * legitimately writes `<tool_call>example</tool_call>` in prose
 * (e.g. teaching about XML formats), it will get scrubbed too;
 * that's a fair tradeoff vs. seeing literal gross markup in the
 * common case. Truncated openers ("<tool_call>" with no close)
 * are NOT stripped because they're hard to disambiguate from
 * incomplete streaming output.
 */

/**
 * Compiled patterns for closed pairs of unmistakable tool-call
 * markup. Order matters: outer wrappers run first so their inner
 * blocks are removed wholesale (e.g.
 * `<tool_call><function=foo>...</function></tool_call>` should
 * disappear via the `<tool_call>` rule, not leave a bare
 * `<tool_call>` shell after the inner Hermes block is stripped).
 */
const TOOL_CALL_MARKUP_PATTERNS: ReadonlyArray<RegExp> = [
  // Qwen canonical wrapper. Catches well-formed pairs regardless of
  // what's inside (including malformed inner Hermes / shell shapes).
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  // Anthropic-style wrapper.
  /<function_calls>[\s\S]*?<\/function_calls>/gi,
  // Hermes-2-Pro / Functionary block. The `=` in the tag name is the
  // distinguishing feature; we wouldn't otherwise match a generic
  // `<function>` (which is legitimate HTML/JSX).
  /<function=[a-zA-Z_][a-zA-Z0-9_]*\s*>[\s\S]*?<\/function\s*>/gi,
  // Claude-style invoke (already wrapped in <function_calls> in
  // canonical use, but bare invokes have been observed).
  /<invoke\s+name="[a-zA-Z_][a-zA-Z0-9_]*"\s*>[\s\S]*?<\/invoke\s*>/gi,
  // Gemma's `<|tool_call|>...<tool_call|>` (canonical close form).
  /<\|tool_call\|>[\s\S]*?<\/?tool_call\|?>/gi,
  // Half-broken Hermes — orphan `<parameter=NAME>VALUE</parameter>`
  // emitted without the enclosing `<function=NAME>...</function>`
  // wrapper. The salvage layer can't promote these (no function
  // name to anchor on) but the user shouldn't see them either way.
  // The `=NAME>` shape is unmistakable — no legitimate prose writes
  // `<parameter=foo>`.
  /<parameter=[a-zA-Z_][a-zA-Z0-9_]*\s*>[\s\S]*?<\/parameter\s*>/gi,
  // Bare orphan opener: `<parameter=NAME>` with no close. Strip just
  // the tag, keeping any value text that follows (so the user at
  // least sees the fragment of intent the model was trying to express
  // — a string like "ada" or a description). Same shape, no close.
  /<parameter=[a-zA-Z_][a-zA-Z0-9_]*\s*>/gi,
  // Stray `</parameter>` / `</function>` closes left over from
  // partially-stripped or truncated emissions. Safe to drop blindly
  // — these are never legitimate prose.
  /<\/parameter\s*>/gi,
  /<\/function\s*>/gi,
  // gpt-oss channel markers — Gemma 3/4 picks this shape up after the
  // verbose-family `<think>` hint and emits both the canonical
  // `<|channel|>NAME<|message|>...<|end|>` and asymmetric variants —
  // `<|channel>NAME\n...<channel|>`, `<channel|>NAME\n...<channel|>`,
  // and `<channel>NAME\n...</channel>`. The salvage layer captures
  // these as reasoning when it can, but a malformed pair leaking
  // through here renders as a section labeled "thought" in the user's
  // bubble, since the bare-tag strip below removes the wrappers but
  // leaves the channel name + body. Be liberal on both sides.
  /<\|channel\|>[\s\S]*?<\|end\|>/gi,
  /<\|?\/?channel\|?>[\s\S]*?<\|?\/?channel\|?>/gi,
  // Bare-pipe channel leak — `analysis|sentence.|sentence.|...|sentence.|`
  // at the start of a buffer with no surrounding `<|...|>` markers.
  // Wild-caught on Gemma 4 E4B (llama.cpp): the model is supposed to
  // emit `<|channel|>analysis<|message|>...<|end|>` but loses the
  // angle brackets in detokenization, leaving the channel name + the
  // pipe-delimited sentences that were nominally inner `<|message|>`
  // segments. Two emitted variants share this opener:
  //   - `analysis|sent.|sent.|sent.|` — the inner `<|message|>` chunks
  //     decoded as pipe-delimited segments, no close marker.
  //   - `analysis|>BODY|<end|>` — the `|>` is the tail of `<|message|>`
  //     and `<end|>` is what's left of `<|end|>` after losing the
  //     leading pipe. Multi-paragraph bodies are common in this shape.
  //   - `analysis|\nBODY</|end|>` - same private channel block, but
  //     the opener loses the `<|message|>` tail and the close keeps a
  //     slash before the pipe.
  //   - `analysis|\nBODY` - same bare opener with no close marker.
  //   - `analysis|>BODY|` — same bracket-loss opener, but the close
  //     residue never arrives. Hide to end-of-buffer because the
  //     malformed control marker leaves no trustworthy visible-body
  //     boundary.
  //
  // Two passes: the first runs greedily-up-to-`<end>` so multi-paragraph
  // bodies strip cleanly (the lazy `[\s\S]*?` in a single alternation
  // would terminate at `\n\n` before reaching `<end>` if both appear).
  // The second falls back to `\n\n` / end-of-buffer for the variants
  // with no close marker.
  /(?:^|\n)(?:thought|analysis|commentary|final)\|[\s\S]*?\|?<\|?\/?\|?end\|?>/gi,
  /(?:^|\n)(?:thought|analysis|commentary|final)\|\s*\n[\s\S]*$/gi,
  /(?:^|\n)(?:thought|analysis|commentary|final)\|>[\s\S]*?\|?\s*$/gi,
  /(?:^|\n)(?:thought|analysis|commentary|final)\|[\s\S]*?(?:\n\n|$)/gi,
];

/**
 * Trailing-open patterns — match an opener with everything after to
 * end-of-string. Used in streaming mode to hide markup that's still
 * being emitted (the close hasn't arrived yet). Without this, the
 * user watches XML grow token-by-token in the live bubble before it
 * suddenly disappears when the close finally streams in. Hiding the
 * partial markup eagerly is a smoother UX.
 *
 * NOT applied to persisted bubbles — once the turn finishes, an
 * unclosed `<tool_call>` was either truncated by the streaming
 * watchdog or genuinely never closed; either way it's no longer
 * "in flight" and we want to render it so the user can see the
 * problem (and it'll match the persisted on-disk transcript).
 */
const TRAILING_OPEN_PATTERNS: ReadonlyArray<RegExp> = [
  // Mid-stream reasoning before the close arrives — Qwen 3.6 with
  // `enable_thinking=True`. Hide everything up to where `</think>`
  // would land, so the user doesn't watch the reasoning prose grow
  // token-by-token.
  /<think>[\s\S]*$/i,
  /<tool_call>[\s\S]*$/i,
  /<function_calls>[\s\S]*$/i,
  /<function=[a-zA-Z_][a-zA-Z0-9_]*\s*>[\s\S]*$/i,
  /<invoke\s+name="[a-zA-Z_][a-zA-Z0-9_]*"\s*>[\s\S]*$/i,
  /<\|tool_call\|>[\s\S]*$/i,
  // Mid-stream orphan `<parameter=NAME>` without a wrapping function
  // tag — broken Hermes in flight. Hide as soon as we see it; the
  // closed-pair strip above already handles completed cases.
  /<parameter=[a-zA-Z_][a-zA-Z0-9_]*\s*>[\s\S]*$/i,
  // Mid-stream gpt-oss channel reasoning before the close arrives.
  // Hide as soon as we see the opener — the user shouldn't watch
  // chain-of-thought paragraphs grow token-by-token in the live
  // bubble.
  /<\|channel\|?>[\s\S]*$/i,
  /(?:^|\n)(?:thought|analysis|commentary|final)\|>[\s\S]*$/i,
  /(?:^|\n)(?:thought|analysis|commentary|final)\|\s*\n[\s\S]*$/i,
];

export interface StripVisibleToolCallMarkupOpts {
  /**
   * When true, ALSO hide trailing unclosed markup (the model
   * emitted `<tool_call>` and the close hasn't arrived yet). Used
   * for live streaming bubbles to avoid flicker as XML grows
   * token-by-token. Persisted bubbles default to false — at that
   * point the turn is over and an unclosed opener is a bug worth
   * surfacing.
   */
  hideMidStreamOpener?: boolean;
}

/**
 * Run all markup patterns over the input and collapse the resulting
 * gaps. Idempotent — re-running on already-stripped input is a
 * no-op. Returns the input unchanged when no markup is present
 * (the common case).
 */
export function stripVisibleToolCallMarkup(
  text: string,
  opts?: StripVisibleToolCallMarkupOpts,
): string {
  if (!text) return text;
  let out = text;
  // Reasoning blocks ending with `</think>`. Run BEFORE tool-call
  // strips so we can use `</tool_call>` as a boundary anchor — every
  // tool-loop iteration's raw output ends with `</tool_call>` (or
  // is the start of the buffer), and the next iteration starts
  // mid-reasoning. Anchoring at `^` or `</tool_call>` lets us strip
  // each iteration's reasoning without eating the visible content
  // BETWEEN iterations. Once we strip tool-call markup below, the
  // boundary is gone — so this pass has to come first.
  //
  // Wild-caught on Qwen 3.6 with `enable_thinking=True`: the chat
  // template injects `<think>\n` into the prompt suffix, so the
  // model's raw output starts mid-reasoning (no opener visible)
  // and emits `</think>` before the visible reply. Without this,
  // the user watches paragraphs of "The user is asking me to..."
  // reasoning render in the streaming bubble between every tool
  // call — the Atari Combat / Ada loop the user reported as
  // "spinning" even though tools were firing successfully.
  out = out.replace(/(^|<\/tool_call>)[\s\S]*?<\/think>\s*/gi, '$1');
  // Same pattern for the gpt-oss channel close — Gemma 3/4 emits
  // `<|channel>thought\n...<channel|>` between tool-loop iterations.
  out = out.replace(/(^|<\/tool_call>)[\s\S]*?<\/?channel\|?>\s*/gi, '$1');
  for (const pat of TOOL_CALL_MARKUP_PATTERNS) {
    out = out.replace(pat, '');
  }
  // Strip leftover stray <think> / </think> tags after the boundary-
  // anchored pass — defensive against shapes the anchored pass
  // missed (e.g. a `</think>` not preceded by `^` or `</tool_call>`).
  out = out.replace(/<\/?think>/gi, '');
  out = out.replace(/<\|?\/?channel\|?>/gi, '');
  out = out.replace(/<\|?\/?message\|?>/gi, '');
  out = out.replace(/<\|?\/?\|?end\|?>/gi, '');
  if (opts?.hideMidStreamOpener) {
    // Run after closed-pair strip so any properly-paired markup is
    // already gone; what remains is unclosed and we hide from the
    // earliest opener to end-of-string. Iterate so multiple shapes
    // anywhere in the buffer all get caught.
    for (const pat of TRAILING_OPEN_PATTERNS) {
      out = out.replace(pat, '');
    }
  }
  if (out === text) return text;
  // Collapse 3+ blank lines to 2 — stripping mid-paragraph leaves a
  // gap that reads as an accidental section break otherwise.
  out = out.replace(/\n{3,}/g, '\n\n');
  // Trim only when the strip actually fired AND the original wasn't
  // intentionally indented — preserve the overall whitespace shape
  // so leading/trailing prose doesn't shift unexpectedly.
  return out.trim().length === 0 ? '' : out;
}
