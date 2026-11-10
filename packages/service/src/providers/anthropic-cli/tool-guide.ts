/**
 * Claude CLI tool guide
 *
 * A short section appended to a Claude CLI session's system prompt that says
 * where the Gezel tools hidden by `excluded-mcp-tools.ts` went: each one this
 * session may use is named beside the Claude Code built-in that stands in for
 * it, and the receipt-bearing package runners are kept in use.
 *
 * Craftbook procedures name Gezel's own tools (`read_file`, `write_file`,
 * `run_nodejs_script`, `fetch_url`, …), and nothing else in the prompt says
 * they are missing on purpose: the `## Tools available this turn` block is not
 * rendered for this provider. On Codex, told nothing, GPT-6.1 Sol read the
 * missing `write_file` as a blocker and paused a bug fix at its first step
 * instead of using its own editor (strategy smoke; see
 * `codex-cli/tool-guide.ts`). The same gap exists here, and is wider because
 * Claude also loses Gezel's readers. That is inferred from the code, not
 * observed on a Claude run. What has been observed here is the search: Opus
 * looked for a hidden runner with ToolSearch and found nothing
 * (codemod-sweep, 2026-09-19; see `excluded-mcp-tools.ts`).
 *
 * Usage: `AnthropicCliSession` appends the guide to the system message it
 * hands the worker, which passes it through `--append-system-prompt-file`.
 *
 * Related files: `excluded-mcp-tools.ts` (what is hidden), `session.ts`
 * (caller), `chat/manager.ts` (`claudeCliContext.disallowedBuiltinTools` and
 * `toolAllowlist`).
 *
 * Gotchas: the guide only ever narrows what a session believes it may do. A
 * hidden tool is mapped only when Gezel granted it to this session
 * (`toolAllowlist`) and its stand-in is reachable: not in `--disallowedTools`,
 * and not an edit or shell tool under `plan`. So a read-only role, a project
 * gezels may not write, or a `plan` session is never told to edit. While a
 * task drafts a change proposal the writers stay unmapped, because their Gezel
 * copies land in the proposal and `Write` would edit the workspace itself.
 */
import type { ClaudePermissionMode } from './provider.js';

/**
 * The Claude Code built-ins that stand in for each tool in
 * `CLAUDE_CLI_EXCLUDED_MCP_TOOLS`, in the order the guide names them.
 */
export const CLAUDE_STAND_INS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['Read'],
  read_files: ['Read'],
  read_image_as_base64: ['Read'],
  list_dir: ['Glob'],
  find_files: ['Glob'],
  stat: ['Glob'],
  grep_files: ['Grep'],
  write_file: ['Write', 'Edit'],
  delete_path: ['Bash'],
  make_dir: ['Bash'],
  rename: ['Bash'],
  diff_files: ['Bash'],
  npm_install: ['Bash'],
  list_packages: ['Bash'],
  run_nodejs_script: ['Bash'],
  run_playwright_script: ['Bash'],
  list_archive: ['Bash'],
  extract_archive: ['Bash'],
  fetch_url: ['WebFetch'],
  web_search: ['WebSearch'],
};

/** Runners whose run records a `commandEvidence` gate reads; a shell run leaves none. */
const RECEIPT_RUNNERS = ['run_package_script', 'run_npx'];

/** Built-ins `plan` mode refuses: it reads and plans, it does not edit or run. */
const REFUSED_IN_PLAN_MODE = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash']);

/** Writers a drafting task re-roots into its change proposal. */
const PROPOSAL_WRITERS = new Set(['write_file', 'delete_path', 'make_dir', 'rename']);

export interface ClaudeToolGuideOptions {
  /** The session's `--permission-mode`. */
  permissionMode: ClaudePermissionMode;
  /** Built-ins passed to `--disallowedTools` for this session's role. */
  disallowedBuiltinTools?: ReadonlyArray<string>;
  /** Gezel tools granted to this session (`SessionOpts.toolAllowlist`); unset grants all. */
  toolAllowlist?: ReadonlySet<string>;
  /** True while the task drafts a change proposal (`GEZEL_DIFFPACK_ID`). */
  drafting?: boolean;
}

const code = (name: string) => `\`${name}\``;

function namesInProse(names: ReadonlyArray<string>): string {
  const quoted = names.map(code);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
    : (quoted[0] ?? '');
}

export function claudeToolGuide(opts: ClaudeToolGuideOptions): string | null {
  const plan = opts.permissionMode === 'plan';
  const disallowed = new Set(opts.disallowedBuiltinTools ?? []);
  const reachable = (builtin: string) =>
    !disallowed.has(builtin) && !(plan && REFUSED_IN_PLAN_MODE.has(builtin));
  const granted = (tool: string) => !opts.toolAllowlist || opts.toolAllowlist.has(tool);

  const toolsByStandIn = new Map<string, string[]>();
  for (const [tool, candidates] of Object.entries(CLAUDE_STAND_INS)) {
    if (!granted(tool)) continue;
    if (opts.drafting && PROPOSAL_WRITERS.has(tool)) continue;
    const standIns = candidates.filter(reachable);
    if (standIns.length === 0) continue;
    const label = standIns.map(code).join(' or ');
    toolsByStandIn.set(label, [...(toolsByStandIn.get(label) ?? []), tool]);
  }
  const runners = plan ? [] : RECEIPT_RUNNERS.filter(granted);
  if (toolsByStandIn.size === 0 && runners.length === 0) return null;

  const sentences: string[] = [];
  if (toolsByStandIn.size > 0) {
    const mapping = [...toolsByStandIn]
      .map(([label, tools]) => `${namesInProse(tools)} → ${label}`)
      .join('; ');
    sentences.push(
      "Gezel's tools reach you as `mcp__gezel__<tool>`, except its file, search, shell and web tools, which are left out because Claude Code has its own.",
      `Where your instructions name one of those, use the built-in instead: ${mapping}.`,
      'Their absence is not a blocker, so do not search for them.',
    );
  } else {
    sentences.push("Gezel's tools reach you as `mcp__gezel__<tool>`.");
  }
  if (runners.length > 0) {
    const shell = reachable('Bash') ? '`Bash`' : 'shell';
    sentences.push(
      `Use ${namesInProse(runners)} where your instructions name them: the step's checks read their run records, which a ${shell} run does not leave.`,
    );
  }
  return ['### Gezel tools in Claude Code', '', sentences.join(' ')].join('\n');
}

/** `instructions` with the tool guide appended, or unchanged when there is nothing to say. */
export function withClaudeToolGuide(instructions: string, opts: ClaudeToolGuideOptions): string {
  const guide = claudeToolGuide(opts);
  return guide ? `${instructions.trimEnd()}\n\n---\n\n${guide}` : instructions;
}
