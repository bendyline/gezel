/**
 * Codex tool guide
 *
 * A short section appended to a Codex session's instructions that names the
 * session's Gezel tools the way Codex calls them and invites it to chain
 * dependent calls in one script. Without it, nearly every task-step turn
 * spent its first model call on `ALL_TOOLS.filter(...)` just to learn the
 * names, and then made one call per tool: a media review took six model
 * calls where three do (567 of 587 turns opened with the lookup, none chained
 * a write with `advance_task_step`; 2026-10-27).
 *
 * Codex's code mode exposes MCP tools inside its `exec` tool as
 * `tools.mcp__<server>__<tool>(args)`; outside code mode the same names are
 * ordinary function tools, so the guide reads correctly either way.
 *
 * Usage: `CodexSession` passes the session's registered tool names
 * (`getRegisteredToolNames()`) and appends the result to `instructions` when
 * it writes the per-session `config.toml`.
 *
 * Related files: `session.ts` (caller), `runtime-files.ts` (config.toml),
 * `excluded-mcp-tools.ts` (what never reaches Codex).
 *
 * Gotchas: a large roster (an ordinary chat session) is described by the
 * naming rule alone; listing a hundred tools would cost more prompt than the
 * lookup it saves. Wildcard markers for extra MCP servers are skipped.
 */

/** Rosters up to this size are listed by name. */
export const CODEX_TOOL_GUIDE_MAX_LISTED = 16;

const GEZEL_PREFIX = 'mcp__gezel__';

export function codexToolGuide(registeredToolNames: ReadonlyArray<string>): string | null {
  const gezelTools = registeredToolNames.filter(
    (name) => name.startsWith(GEZEL_PREFIX) && !name.endsWith('*'),
  );
  if (gezelTools.length === 0) return null;
  const roster =
    gezelTools.length <= CODEX_TOOL_GUIDE_MAX_LISTED
      ? ` This turn's: ${gezelTools.map((name) => `\`tools.${name}\``).join(', ')}.`
      : '';
  return [
    '### Calling Gezel tools',
    '',
    `Gezel's tools are named \`mcp__gezel__<tool>\`; inside an \`exec\` script call them as \`await tools.mcp__gezel__<tool>({ ... })\`.${roster} Call them directly with the arguments your instructions show — there is no need to look them up in \`ALL_TOOLS\` first.`,
    '',
    "One script can make several calls in order. When a call's result only feeds the next call, make both in the same script: read an input and then the files it names (print text with `text(...)`, pass images to `image(...)`), or write the deliverable and then call `advance_task_step`. A successful write already confirms what was saved, so do not read it back.",
  ].join('\n');
}

/** `instructions` with the tool guide appended, or unchanged when there is no Gezel tool. */
export function withCodexToolGuide(
  instructions: string,
  registeredToolNames: ReadonlyArray<string>,
): string {
  const guide = codexToolGuide(registeredToolNames);
  return guide ? `${instructions.trimEnd()}\n\n---\n\n${guide}` : instructions;
}
