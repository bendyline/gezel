/**
 * The MCP prompts `gezel-mcp --harness` serves: the "skill" a person runs in
 * their coding app to work through the night shift's BW issues. Served by
 * Gezel, so nothing is written into the folder or the app's settings, and the
 * text updates with Gezel. See docs/issue-triage.md.
 */

import { ISSUE_VERDICT_DEFINITIONS } from '../issue-triage/verdicts.js';
import type { IssueHandoffResponse } from '../schemas/api/issue-triage.js';
import { ISSUE_VERDICT_KINDS } from '../schemas/file-review.js';
import type { HarnessClientId } from '../schemas/harness-tools.js';

export const HARNESS_PROMPT_NAMES = ['triage_issues', 'fix_issues'] as const;
export type HarnessPromptName = (typeof HARNESS_PROMPT_NAMES)[number];

export const HARNESS_PROMPTS: Record<
  HarnessPromptName,
  { title: string; description: string; defaultCount: number }
> = {
  triage_issues: {
    title: "Check Gezel's issues",
    description:
      "Work through suspected problems Gezel's overnight reviewer found in this folder: say which are real, without changing code.",
    defaultCount: 10,
  },
  fix_issues: {
    title: "Fix Gezel's issues",
    description:
      "Work through suspected problems Gezel's overnight reviewer found in this folder, fix the real ones that are small, and report back.",
    defaultCount: 5,
  },
};

/**
 * How the person runs a prompt in each app, where we know: Claude Code and
 * VS Code show a server's prompts as slash commands. Null means "no prompt
 * command we can name"; the person uses the handoff document instead.
 */
export function harnessPromptInvocation(
  client: HarnessClientId,
  name: HarnessPromptName,
): string | null {
  switch (client) {
    case 'claude-code':
      return `/mcp__gezel__${name}`;
    case 'vscode':
      return `/mcp.gezel.${name}`;
    default:
      return null;
  }
}

/** A prompt's `count` argument (MCP prompt arguments are strings), clamped. */
export function harnessPromptCount(name: HarnessPromptName, raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return HARNESS_PROMPTS[name].defaultCount;
  return Math.min(parsed, 50);
}

/** One batch as plain text: files with absolute paths, then each lead under its file. */
export function renderIssueBatch(
  queue: IssueHandoffResponse,
  absolutePath: (relative: string) => string,
): string {
  if (queue.count === 0) {
    return queue.indexed
      ? 'Gezel has no open issues for this folder that need checking.'
      : "Gezel hasn't indexed this folder yet, so it has no issues to hand over.";
  }
  const lines = [
    `${queue.count} issue${queue.count === 1 ? '' : 's'} in ${queue.files.length} file${queue.files.length === 1 ? '' : 's'}${queue.remaining > 0 ? ` (${queue.remaining} more waiting)` : ''}:`,
  ];
  for (const file of queue.files) {
    lines.push('', absolutePath(file.path));
    for (const issue of file.issues) {
      const where = issue.line
        ? issue.stale
          ? `was line ${issue.line}; the file changed since the review`
          : `line ${issue.line}`
        : issue.stale
          ? 'the file changed since the review'
          : 'no line';
      lines.push(
        `- ${issue.ref} · ${issue.severity} · ${issue.category} · ${where}: ${issue.message}`,
      );
      if (issue.verdict) {
        lines.push(
          `  Earlier verdict: ${issue.verdict}${issue.verdictNote ? ` (${issue.verdictNote})` : ''}`,
        );
      }
    }
  }
  return lines.join('\n');
}

const VERDICT_LINES = ISSUE_VERDICT_KINDS.map((k) => `   - ${k}: ${ISSUE_VERDICT_DEFINITIONS[k]}`);

/**
 * The prompt when there is nothing to hand over. The full procedure with an
 * empty batch sent Claude Code looking anyway: two more listings and a status
 * check, 7 turns and $1.25 to say "nothing to triage" (2026-10-23).
 */
export function renderEmptyIssuePrompt(batchText: string): string {
  return `${batchText} Tell the person that in one sentence and stop: there is nothing to check.`;
}

/** The whole prompt, with the batch Gezel handed over embedded at the end. */
export function renderHarnessIssuePrompt(name: HarnessPromptName, batchText: string): string {
  const fixing = name === 'fix_issues';
  return [
    "Gezel's overnight reviewer, a smaller model running on this computer, flagged the suspected problems below in this folder. Many will be wrong; your job is to find out which are real.",
    '',
    'Work through them one file at a time:',
    '1. Open the file and read the code around each line. If a lead says the file changed since the review, find where that code is now.',
    '2. Decide what each one is:',
    ...VERDICT_LINES,
    '   A lead that is true but too small to matter is a nit, not not_a_bug: not_a_bug means the lead is wrong.',
    fixing
      ? '3. Fix what is real and small with your own edit tools, and run the tests that cover it; report those as fixed. Leave anything larger as confirmed, and say in the note what the fix would take.'
      : "3. Don't change any code: this pass only decides what is real.",
    '4. Call `report_issue_verdicts` after every file or two (at most 25 per call), each with a one-line note naming your evidence: a file:line, a test, or the caller that handles it. Use unsure only when the code cannot settle it, and say what would.',
    '5. Only report issues you actually checked. When the batch is done, tell the person briefly how many of each verdict you gave and anything that needs their decision. Call `list_issues` for another batch only if they ask.',
    '',
    batchText,
  ].join('\n');
}
