/**
 * The handoff document: the night shift's BW issues as one markdown file any
 * coding app can work through, with a response block under each issue for
 * the app (or the person) to fill in, and the parser Gezel reads it back
 * with. The outside-app tools are the better path where an app has them;
 * this is for apps without them, and for reading. See docs/issue-triage.md.
 */

import type { IssueHandoffResponse, IssueVerdictInput } from '../schemas/api/issue-triage.js';
import {
  ISSUE_VERDICT_KINDS,
  type IssueVerdictKind,
  type IssueVerdictReason,
} from '../schemas/file-review.js';
import { ISSUE_VERDICT_DEFINITIONS } from './verdicts.js';

export const ISSUE_HANDOFF_MARKER = 'gezel:issue-handoff';
const RESPONSE_OPEN = /<!--\s*gezel:response\s+(BW-[1-9]\d*)\s*-->/g;
const RESPONSE_CLOSE = /<!--\s*\/gezel:response\s*-->/;

export interface IssueHandoffDocumentOptions {
  projectId: string;
  projectName: string;
  generatedAt: string;
  absolutePath: (relative: string) => string;
}

/** The document for one batch. */
export function renderIssueHandoff(
  queue: IssueHandoffResponse,
  opts: IssueHandoffDocumentOptions,
): string {
  const lines = [
    `<!-- ${ISSUE_HANDOFF_MARKER} project=${opts.projectId} generated=${opts.generatedAt} -->`,
    `# Issues for review: ${opts.projectName}`,
    '',
    "Gezel's overnight reviewer, a smaller model, flagged these suspected problems. Many will be wrong. For each one, read the code at the line given, decide what it is, and fill in the response block under it. Leave a block empty to skip that issue.",
    '',
    'Verdicts:',
    ...ISSUE_VERDICT_KINDS.map((k) => `- \`${k}\`: ${ISSUE_VERDICT_DEFINITIONS[k]}`),
    '',
    'For `not_a_bug`, put `incorrect`, `handled_elsewhere` or `intended` on the Reason line. For `duplicate`, put the other code (BW-n) on the Reason line. In Notes, say what you checked: a file:line, a test, or the caller that handles it.',
    '',
    'When you are done, import this file in Gezel: Reports → Issues for review → Import answers.',
  ];
  if (queue.count === 0) {
    lines.push('', 'There are no open issues to review right now.');
    return `${lines.join('\n')}\n`;
  }
  for (const file of queue.files) {
    lines.push('', `## ${file.path}`);
    for (const issue of file.issues) {
      const where = issue.line
        ? `${opts.absolutePath(file.path)}:${issue.line}`
        : opts.absolutePath(file.path);
      lines.push(
        '',
        `### ${issue.ref} · ${issue.severity} · ${issue.category}`,
        '',
        `\`${where}\`${issue.stale ? ' (the file changed since the review; find where this code is now)' : ''}`,
        '',
        issue.message,
      );
      if (issue.verdict) {
        lines.push(
          '',
          `Earlier verdict: ${issue.verdict}${issue.verdictNote ? `: ${issue.verdictNote}` : ''}`,
        );
      }
      lines.push(
        '',
        `<!-- gezel:response ${issue.ref} -->`,
        'Verdict:',
        'Reason:',
        'Notes:',
        '<!-- /gezel:response -->',
      );
    }
  }
  if (queue.remaining > 0) {
    lines.push(
      '',
      `${queue.remaining} more issues are waiting; Gezel hands them over in the next batch.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface ParsedIssueHandoff {
  /** The project the document was made for, from its marker. */
  projectId?: string;
  verdicts: IssueVerdictInput[];
  /** Issues whose response was left empty or named no verdict Gezel knows. */
  skipped: string[];
}

/**
 * Read the answers back. Finds each response block by its marker comment,
 * and when an app's edits dropped the comments, falls back to the issue's
 * heading followed by a `Verdict:` line. Tolerant of the words an app uses
 * ("not a bug", "won't fix", "false positive"), of bold and backticks, and of
 * Windows line endings.
 */
export function parseIssueHandoffResponses(markdown: string): ParsedIssueHandoff {
  const text = markdown.replace(/\r\n?/g, '\n');
  const projectId = new RegExp(`${ISSUE_HANDOFF_MARKER}\\s+project=(\\S+)`).exec(text)?.[1];
  const blocks = new Map<string, string>();

  for (const match of text.matchAll(RESPONSE_OPEN)) {
    const ref = match[1] as string;
    const start = (match.index ?? 0) + match[0].length;
    const rest = text.slice(start);
    const close = RESPONSE_CLOSE.exec(rest);
    const nextOpen = rest.search(/<!--\s*gezel:response\s/);
    const end = close ? close.index : nextOpen >= 0 ? nextOpen : rest.length;
    if (!blocks.has(ref)) blocks.set(ref, rest.slice(0, end));
  }

  // An app that rewrote the file may have dropped the comments: take the
  // section under each `BW-n` heading instead.
  const headings = [...text.matchAll(/^#{1,6}[^\n]*?\b(BW-[1-9]\d*)\b[^\n]*$/gm)];
  headings.forEach((heading, i) => {
    const ref = heading[1] as string;
    if (blocks.has(ref)) return;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[i + 1]?.index ?? text.length;
    const section = text.slice(start, end);
    if (/^\s*[*_`]*verdict[*_`]*\s*:/im.test(section)) blocks.set(ref, section);
  });

  const verdicts: IssueVerdictInput[] = [];
  const skipped: string[] = [];
  for (const [ref, block] of blocks) {
    const verdict = parseVerdictBlock(ref, block);
    if (verdict) verdicts.push(verdict);
    else skipped.push(ref);
  }
  return { ...(projectId ? { projectId } : {}), verdicts, skipped };
}

function field(block: string, name: string): string {
  const match = new RegExp(`^\\s*[*_\`]*${name}[*_\`]*\\s*:[*_\`]*[ \\t]*(.*)$`, 'im').exec(block);
  return clean(match?.[1] ?? '');
}

function clean(value: string): string {
  return value.replace(/[*_`]/g, '').trim();
}

function parseVerdictBlock(ref: string, block: string): IssueVerdictInput | null {
  const kind = verdictKind(field(block, 'verdict'));
  if (!kind) return null;
  const reasonText = field(block, 'reason');
  const notesMatch = /^\s*[*_`]*notes?[*_`]*\s*:[*_`]*[ \t]*([\s\S]*)$/im.exec(block);
  const note = clean(notesMatch?.[1] ?? '')
    .replace(/<!--[\s\S]*$/, '')
    .trim()
    .slice(0, 2000);
  const duplicateOf = /\bBW-[1-9]\d*\b/.exec(reasonText)?.[0];
  if (kind === 'duplicate' && (!duplicateOf || duplicateOf === ref)) return null;
  // "by design" on the verdict line itself is a reason too.
  const reason =
    kind === 'not_a_bug' ? verdictReason(reasonText || field(block, 'verdict')) : undefined;
  return {
    ref,
    kind,
    ...(reason ? { reason } : {}),
    ...(note ? { note } : {}),
    ...(kind === 'duplicate' && duplicateOf ? { duplicateOf } : {}),
  };
}

const SYNONYMS: ReadonlyArray<[RegExp, IssueVerdictKind]> = [
  [
    /^(not[\s_-]*a[\s_-]*bug|false[\s_-]*positive|invalid|incorrect|wrong|by[\s_-]*design)\b/,
    'not_a_bug',
  ],
  [/^(won'?t[\s_-]*fix|wont_fix)\b/, 'wont_fix'],
  [/^(nit|nitpick|trivial|not[\s_-]*worth[\s_-]*fixing)\b/, 'nit'],
  [/^(fixed|resolved|done)\b/, 'fixed'],
  [/^(confirmed|real|valid|true[\s_-]*positive)\b/, 'confirmed'],
  [/^(duplicate|dup|dupe)\b/, 'duplicate'],
  [/^(unsure|unknown|not[\s_-]*sure|can'?t[\s_-]*tell)\b/, 'unsure'],
];

/** The verdict a filled-in line names, or null for an empty or template line. */
export function verdictKind(raw: string): IssueVerdictKind | null {
  const value = raw.toLowerCase().trim();
  // The template's own "(fixed | not_a_bug | …)" or nothing at all.
  if (!value || value.includes('|')) return null;
  for (const [pattern, kind] of SYNONYMS) if (pattern.test(value)) return kind;
  return null;
}

function verdictReason(raw: string): IssueVerdictReason | undefined {
  const value = raw.toLowerCase();
  if (/handled|elsewhere|caller|guarded/.test(value)) return 'handled_elsewhere';
  if (/intend|purpose|design|deliberate/.test(value)) return 'intended';
  if (/incorrect|wrong|not true|false/.test(value)) return 'incorrect';
  return undefined;
}
