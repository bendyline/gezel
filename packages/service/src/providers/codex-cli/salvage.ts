/**
 * Salvage pass for Codex CLI assistant text.
 *
 * Background: gpt-5.5 (and occasionally its 5.4 / 5.3 siblings) sometimes
 * stuffs an internal tool-call draft into the `agent_message` stream
 * instead of the `reasoning` stream. The leak looks like:
 *
 *   "<mcp__gezel__ask_specialist  cringe? wait tool call name must commentary."
 *
 * — an unfinished `<server__tool …>` token, a self-deprecating word
 * (`cringe?`, `ugh`, `wait`), and a half-formed reminder to itself about
 * format. Then it gives up on the draft, drops a blank line, and writes
 * the real reply below. The parser at invoker.ts only forwards
 * `agent_message` items as user-visible content (reasoning items stay
 * buffered) — so by the time we see the text, it's too late to filter
 * at the channel level. We strip it here, in post.
 *
 * The salvager is deliberately conservative: it only trims when the
 * VERY FIRST line of the text starts with a `<server__tool` token AND
 * the line never closes with `>` AND there's a real reply paragraph
 * below it. Anything outside that exact shape is left alone — losing
 * a sentence the user actually wanted is worse than leaking a single
 * stray draft.
 *
 * Streamed deltas are NOT salvaged — the user briefly sees the leak in
 * real time. The persisted message (and what's shown when the bubble
 * re-renders) is clean. Holding back streaming until we'd decided
 * whether to strip would jitter the streaming UX more than the leak
 * itself hurts.
 */

/**
 * Returns `true` for a line that LOOKS like an MCP tool-call draft:
 * starts with `<`, then a lowercase identifier with at least one
 * `__` separator (the namespace convention codex stamps MCP tools
 * with — `mcp__<server>__<tool>` or sometimes just `<server>__<tool>`).
 *
 * Doesn't match closed XML tags (those end with `>`), real markdown
 * code blocks (those start with `\``), or JSX-like tag prefixes that
 * have a kebab/camelCase identifier (a tool-call draft is snake_case
 * with explicit `__` separators).
 */
function looksLikeToolCallDraft(line: string): boolean {
  const trimmed = line.trimStart();
  // Must start with `<` followed by a lowercase identifier with `__`.
  // `[a-z_][a-z0-9_]*` is the identifier shape; require at least one
  // `__<word>` to distinguish from a stray `<input>` JSX tag the user
  // might have typed.
  const m = /^<([a-z_][a-z0-9_]*(?:__[a-z0-9_]+)+)/.exec(trimmed);
  if (!m) return false;
  // If the line CLOSES the tag cleanly (`>` somewhere after the name
  // with no whitespace garbage in between), assume the model meant
  // real XML and bail out — leave it alone.
  const afterIdent = trimmed.slice(m[0].length);
  if (/^[^<\n]*>/.test(afterIdent.trimStart())) return false;
  return true;
}

/**
 * Drop the leading tool-call-draft paragraph from a Codex agent_message
 * if present. A "paragraph" here is everything up to the first blank
 * line. We require at least one non-empty paragraph to follow —
 * otherwise the draft is all we got and stripping would erase the
 * whole reply.
 *
 * Returns the input unchanged when no leak is detected.
 */
export function salvageAgentMessage(text: string): string {
  if (text.length === 0) return text;

  // Split on the first blank-line boundary. Anything after is the
  // candidate "real reply"; the head is the candidate draft.
  const blankBreak = text.search(/\n\s*\n/);
  if (blankBreak < 0) {
    // No paragraph separator — single block. Don't strip, even if it
    // looks like a draft: the user would lose the entire reply.
    return text;
  }
  const head = text.slice(0, blankBreak);
  const tail = text.slice(blankBreak).replace(/^\n\s*\n/, '');
  if (tail.trim().length === 0) return text;

  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  if (!looksLikeToolCallDraft(firstLine)) return text;

  // Whole leading paragraph is a draft — drop it. Preserve the tail
  // as-is so any markdown leading whitespace stays intact.
  return tail;
}
