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
 *
 * Craftbook procedures name Gezel's own writers (`write_file`, `rename`, …),
 * which `excluded-mcp-tools.ts` keeps out of Codex. Told nothing, GPT-6.1 Sol
 * read the missing `write_file` as a blocker and paused a bug fix at its
 * first step instead of using its own editor (strategy smoke, 2026-11-10), so
 * a session that may edit is told where that work goes. A later step's
 * procedure can arrive in a user turn, so this does not depend on what the
 * instructions happen to name.
 */

/** Rosters up to this size are listed by name. */
export const CODEX_TOOL_GUIDE_MAX_LISTED = 16;

const GEZEL_PREFIX = 'mcp__gezel__';
const RECEIPT_RUNNERS = ['run_package_script', 'run_npx'];

export interface CodexToolGuideOptions {
  /** False for a read-only (`plan`) session, which must not be told to edit. */
  canEdit?: boolean;
}

export function codexToolGuide(
  registeredToolNames: ReadonlyArray<string>,
  opts: CodexToolGuideOptions = {},
): string | null {
  const gezelTools = registeredToolNames.filter(
    (name) => name.startsWith(GEZEL_PREFIX) && !name.endsWith('*'),
  );
  if (gezelTools.length === 0) return null;
  const roster =
    gezelTools.length <= CODEX_TOOL_GUIDE_MAX_LISTED
      ? ` This turn's: ${gezelTools.map((name) => `\`tools.${name}\``).join(', ')}.`
      : '';
  const lines = [
    '### Calling Gezel tools',
    '',
    `Gezel's tools are named \`mcp__gezel__<tool>\`; inside an \`exec\` script call them as \`await tools.mcp__gezel__<tool>({ ... })\`.${roster} Call them directly with the arguments your instructions show — there is no need to look them up in \`ALL_TOOLS\` first.`,
    '',
    "One script can make several calls in order. When a call's result only feeds the next call, make both in the same script: read an input and then the files it names (print text with `text(...)`, pass images to `image(...)`), or write the deliverable and then call `advance_task_step`. A successful write already confirms what was saved, so do not read it back.",
  ];
  if (opts.canEdit !== false) {
    const runners = RECEIPT_RUNNERS.filter((name) => gezelTools.includes(`${GEZEL_PREFIX}${name}`));
    lines.push(
      '',
      `Gezel's file, shell and web tools (\`write_file\`, \`delete_path\`, \`make_dir\`, \`rename\`, \`run_nodejs_script\`, \`fetch_url\`, \`web_search\`) are left out because Codex has its own. Where your instructions name one, do that work with your built-in file editing, shell or web search. Its absence is not a blocker.${
        runners.length > 0
          ? ` Use ${runners.map((name) => `\`${name}\``).join(' and ')} where your instructions name them: the step's checks read their run records, which a shell run does not leave.`
          : ''
      }`,
    );
  }
  return lines.join('\n');
}

/** `instructions` with the tool guide appended, or unchanged when there is no Gezel tool. */
export function withCodexToolGuide(
  instructions: string,
  registeredToolNames: ReadonlyArray<string>,
  opts: CodexToolGuideOptions = {},
): string {
  const guide = codexToolGuide(registeredToolNames, opts);
  return guide ? `${instructions.trimEnd()}\n\n---\n\n${guide}` : instructions;
}
