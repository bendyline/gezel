/**
 * Pull chain-of-thought blocks out of visible content and return both
 * halves. Several small models emit reasoning wrapped in tags expecting
 * the surrounding harness to hide it; without extraction, the user sees
 * the model's internal monologue rendered as the assistant message.
 *
 * Recognized shapes:
 *   - `<think>...</think>` — Qwen 3 family, DeepSeek-R1 distillates.
 *   - `<reasoning>...</reasoning>` — older R1 variants.
 *   - `[THINK]...[/THINK]` — Mistral Medium 3.5 / Magistral special-token shape.
 *   - `<|channel>NAME\n...<channel|>` and `<|channel|>NAME<|message|>...<|end|>`
 *     — gpt-oss style channel markers. Gemma 3/4 picked this shape up
 *     from training data exposure to gpt-oss outputs once routed
 *     through the verbose-family hint that asked for `<think>` tags.
 *     Asymmetric pipe placement (`<|channel>` open, `<channel|>` close)
 *     is the wild-caught pattern; both symmetric and asymmetric variants
 *     are matched.
 *   - Unclosed leading variants of any of the above — a truncated
 *     reasoning trace shouldn't dump everything as visible text.
 *
 * The captured reasoning is returned alongside the cleaned visible
 * text so the chat manager can stash it on `ChatMessage.reasoning`,
 * where the UI renders it behind a collapsed expander instead of
 * throwing it away.
 */
export function extractReasoning(text: string): { visible: string; reasoning: string } {
  if (!text) return { visible: text, reasoning: '' };
  const captured: string[] = [];
  let out = text;
  // gpt-oss canonical channel block: `<|channel|>NAME<|message|>BODY<|end|>`.
  // Strip the channel-name prefix from the captured body so the user
  // sees just the reasoning prose, not "analysis<|message|>...".
  out = out.replace(/<\|channel\|>([\s\S]*?)<\|end\|>/gi, (_m, inner: string) => {
    const m = inner.match(/^[a-zA-Z_][a-zA-Z0-9_-]*\s*<\|message\|>([\s\S]*)$/);
    captured.push(m ? m[1]! : inner);
    return '';
  });
  // Asymmetric channel block: `<|channel>NAME\nBODY<channel|>` (Gemma).
  // Channel name is on the same line as the opener, body follows
  // after a newline. Wild-caught Gemma 4 26B emissions also drop the
  // leading `<|` on the opener (`<channel>thought\n...<channel|>`),
  // so accept both forms on either side of the pair.
  out = out.replace(
    /<\|?\/?channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?[\s\S]*?<\|?\/?channel\|?>/gi,
    (m) => {
      const body = m
        .replace(/^<\|?\/?channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?\s*\n?/i, '')
        .replace(/<\|?\/?channel\|?>$/i, '');
      captured.push(body);
      return '';
    },
  );
  // Closed `<think>` / `<reasoning>` pairs.
  out = out.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/<reasoning>([\s\S]*?)<\/reasoning>/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Closed `[THINK]...[/THINK]` pairs — Mistral Medium 3.5 / Magistral.
  // These are real tokenizer special tokens, so a literal bracket form
  // in user prose is vanishingly rare; we strip case-insensitively.
  out = out.replace(/\[THINK\]([\s\S]*?)\[\/THINK\]/gi, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Leading reasoning ending with </think> — the Qwen 3.6 with
  // `enable_thinking=True` shape. The chat template injects
  // `<think>\n` into the prompt suffix, so the model's emitted
  // output starts mid-reasoning (no opening tag visible) and emits
  // `</think>` before the visible reply. Anchored to start of input
  // (per-iteration content has at most one such block) — drops
  // everything from start up to and including the first `</think>`.
  // Without this anchor, stray `</think>` markers later in the text
  // would also be matched and eat visible content between them.
  out = out.replace(/^([\s\S]*?)<\/think>\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/^([\s\S]*?)<\/reasoning>\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Same leading-only shape for `[/THINK]` — Mistral chat templates that
  // prefill `[THINK]\n` so the model output starts mid-reasoning.
  out = out.replace(/^([\s\S]*?)\[\/THINK\]\s*/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  // Unclosed leading `<think>...` / `<|channel>...` / `[THINK]...`.
  out = out.replace(/<think>([\s\S]*?)(?:<\/think>|\n\n)/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(/\[THINK\]([\s\S]*?)(?:\[\/THINK\]|\n\n)/i, (_m, inner: string) => {
    captured.push(inner);
    return '';
  });
  out = out.replace(
    /<\|channel\|?>(?:[a-zA-Z_][a-zA-Z0-9_-]*)?\n([\s\S]*?)(?:<\/?channel\|?>|\n\n)/i,
    (_m, inner: string) => {
      captured.push(inner);
      return '';
    },
  );
  // Stray tags that escaped the above patterns.
  out = out.replace(/<\/?think>/gi, '');
  out = out.replace(/<\/?reasoning>/gi, '');
  out = out.replace(/\[\/?THINK\]/gi, '');
  out = out.replace(/<\|?\/?channel\|?>/gi, '');
  out = out.replace(/<\|message\|>/gi, '');
  out = out.replace(/<\|end\|>/gi, '');
  // Chat-template framing tokens — turn / sequence / tool-response
  // delimiters the model sometimes emits as literal special-token text
  // on tight quants. Wild-caught from gemma4-e4b-q4, which streamed
  // `<eos><|tool_response><eos>` as visible content after firing its
  // tool calls (the detokenizer renders special tokens because
  // `decode()` keeps them). These are pure framing, never reasoning or
  // reply prose, so we drop them silently rather than capture.
  //
  // The tool-CALL markers (`<|tool_call>` / `<tool_call|>`) are
  // deliberately excluded: the streaming LeakyToolCallStripper owns
  // those and needs them intact to salvage tool calls upstream of here.
  out = out.replace(
    /<\|?(?:eos|bos|pad|unk|mask|turn|tool_response|start_of_turn|end_of_turn|im_start|im_end)\|?>/gi,
    '',
  );
  const visible = out.replace(/\n{3,}/g, '\n\n').trim();
  const reasoning = captured
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
  return { visible, reasoning };
}

/**
 * Visible-only convenience wrapper around {@link extractReasoning} —
 * returns just the cleaned text and drops the captured reasoning.
 *
 * Use cases:
 *   - Read-time scrubbing of historical assistant messages before
 *     replaying them to a stateless local provider. Two reasons it
 *     matters: (1) self-feedback — Gemma 4 sees its own past
 *     `<|channel>thought ... <channel|>` blocks in the transcript and
 *     either copies the pattern or misreads them as a system error;
 *     (2) backfill — messages persisted before `extractReasoning`
 *     shipped still have raw markup baked into `content`.
 *   - Anywhere the captured reasoning has already been promoted onto
 *     `ChatMessage.reasoning` (or doesn't need to be promoted at all)
 *     and the caller just wants the visible text.
 *
 * Prefer {@link extractReasoning} when you DO want to keep the
 * captured trace.
 */
export function stripReasoningTags(text: string): string {
  return extractReasoning(text).visible;
}
