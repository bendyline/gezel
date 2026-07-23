/**
 * Promote bare channel-name leaks (Gemma 4 26B and gpt-oss family
 * tic) to italic mode indicators. The model emits the bare channel
 * name on its own line — sometimes 50+ times in a row — when its
 * `<|channel|>` markup gets garbled at decode time. Without
 * promotion these `thought\n` / `analysis\n` / `commentary\n` /
 * `final\n` lines bleed into the visible bubble exactly as the
 * model emitted them.
 *
 * Shared between:
 *   - `packages/service` `reasoning.strip-channel-tags` behavior —
 *     runs at message-commit time on the final assistant text.
 *   - `packages/ui` StreamingBubble — runs at stream-render time so
 *     the user sees `_Thinking…_` even mid-stream, never the raw
 *     `thought\n` leak.
 *
 * Mode mappings:
 *   `thought`     → `_Thinking…_`
 *   `analysis`    → `_Analyzing…_`
 *   `commentary`  → `_Reflecting…_`
 *   `final`       → dropped (it just signals "the real reply starts
 *                   here"; the user doesn't need a status line for
 *                   "model is now replying")
 *
 * Consecutive identical leaks collapse to ONE indicator so 50
 * `thought\n` lines produce one `_Thinking…_`. A non-leak line
 * resets the run state so a later `thought` after real content
 * emits a fresh indicator.
 */

const KNOWN_CHANNEL_NAMES = ['thought', 'analysis', 'commentary', 'final'] as const;
type KnownChannelName = (typeof KNOWN_CHANNEL_NAMES)[number];

const MODE_INDICATORS: Record<KnownChannelName, string | null> = {
  thought: '_Thinking…_',
  analysis: '_Analyzing…_',
  commentary: '_Reflecting…_',
  final: null,
};

/**
 * Inline-leak split: when a channel name appears at the start of a line
 * directly followed by an uppercase letter (e.g. `analysisI've reviewed
 * the task…`), insert a newline so the line-based promotion below
 * picks it up. Wild-caught from Gemma 4 26B emitting
 * `analysis<|message|>...` without a separator after `<|message|>`
 * gets stripped.
 *
 * Strict gating prevents false positives on real words:
 *   - `^` (with `m` flag) — only at line starts, never mid-sentence.
 *   - `(?=[A-Z])` — the next char must be an uppercase letter.
 *     `thoughtful` (lowercase `f`) doesn't match. `THOUGHT_X` doesn't
 *     match either (`_` isn't `[A-Z]`). Real English words starting
 *     with `thought` / `analysis` / `commentary` / `final` are
 *     vanishingly rare to find immediately followed by a capital
 *     letter without whitespace.
 */
function splitInlineChannelLeaks(text: string): string {
  // No `i` flag: in JS regex, `i` makes `[A-Z]` match lowercase letters
  // too — `thoughtful` would split into `thought\nful`, which is wrong.
  // Gemma / gpt-oss always emit lowercase channel names anyway, so the
  // strict-lowercase match on the channel name is safe AND the `[A-Z]`
  // lookahead correctly stays uppercase-only.
  return text.replace(/^(thought|analysis|commentary|final)(?=[A-Z])/gm, '$1\n');
}

export function promoteBareChannelNames(text: string): string {
  if (!text) return text;
  const split = splitInlineChannelLeaks(text);
  const lines = split.split('\n');
  const out: string[] = [];
  let lastIndicator: string | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim().toLowerCase();
    const match = (KNOWN_CHANNEL_NAMES as readonly string[]).includes(trimmed)
      ? (trimmed as KnownChannelName)
      : null;
    if (match) {
      const indicator = MODE_INDICATORS[match];
      if (indicator === null) {
        lastIndicator = null;
        continue;
      }
      if (indicator !== lastIndicator) {
        out.push(indicator);
        lastIndicator = indicator;
      }
      continue;
    }
    if (raw.trim().length > 0) lastIndicator = null;
    out.push(raw);
  }
  return out.join('\n');
}
