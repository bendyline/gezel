import { FileReviewReplySchema } from '@bendyline/gezel';
import type { FileReviewIssue, FileReviewReply } from '@bendyline/gezel';
import {
  type ContentWindow,
  completionBudgetChars,
  runLargeContentCompletion,
} from '../chat/large-content.js';
import { type EnrichDeps, readEnrichableText } from './enrich.js';
import type { FileRecord, IndexStore } from './index-store.js';
import type { ResolvedRubric } from './rubrics.js';

/**
 * The boekwachter review pass: type-specific cliffs notes, a structured issue
 * list, and a 1-10 health score judged against the file kind's rubric. Runs
 * strictly AFTER the enrichment tier drains — the summary/embedding pipeline
 * feeds search coverage (the benchmarked metric) and must never wait behind
 * reviews.
 *
 * Content sizing is owned by the large-content layer, not a caller-side cap:
 * a file that fits the resolved target's budget is reviewed WHOLE in one call
 * (cloud/Night Shift targets take almost everything whole), and a larger file
 * is reviewed in line-aligned windows whose numbered lines carry ABSOLUTE
 * file line numbers, merged into one stored review. Partial coverage (the
 * window cost bound) is recorded in the notes, never silent — the old
 * first-6,000-chars slice made mid-file issues structurally invisible.
 *
 * Failure semantics differ from the summary pass on purpose:
 *   - every reply empty (engine down / timeout) → no gate write, retried freely
 *   - non-empty but unparseable/invalid replies → capped attempt (retried up to
 *     MAX_REVIEW_ATTEMPTS per rubric, budget resets when the rubric changes)
 *   - any window parsed                         → row upserted, attempts reset
 */

export const MAX_REVIEW_ATTEMPTS = 3;
/** Prompt scaffold (rubric + contract + rules) allowance inside the budget. */
const REVIEW_SCAFFOLD_CHARS = 2500;
const MIN_WINDOW_CHARS = 2000;
const REVIEW_WINDOW_OVERLAP_LINES = 12;
const DEFAULT_REVIEW_MAX_WINDOWS = 4;
const NOTES_MD_CAP = 4000;
const HEALTH_REASON_CAP = 200;
const ISSUE_MESSAGE_CAP = 300;
const ISSUE_CATEGORY_CAP = 40;
const MAX_ISSUES = 10;
const MERMAID_MAX_LINES = 40;

const ISSUE_SEVERITIES = new Set(['info', 'minor', 'major']);

const KIND_RULES: Record<string, string> = {
  code: [
    '- notes_md: what this file does and its key flows — 1 sentence for a tiny file, up to 3 short paragraphs for a complex one. Plain markdown, no headings.',
    '- Look for: likely bugs, code smells, unhandled errors, syntax mistakes a linter would miss, misleading names, dead code. Categories like: bug, smell, error-handling, naming, dead-code, complexity.',
  ].join('\n'),
  text: [
    '- notes_md: a textual summary of what this document covers — 1 sentence to 2 short paragraphs. No diagrams.',
    '- Look for: grammar and spelling errors, unclear or ambiguous sentences, disorganized flow, stale or contradictory statements. Categories like: grammar, clarity, structure, accuracy. This is plain text — do not flag missing markdown formatting.',
  ].join('\n'),
  markdown: [
    '- notes_md: a textual summary of what this document covers and its structure — 1 sentence to 2 short paragraphs. No diagrams.',
    '- Look for: grammar and spelling errors, unclear or ambiguous sentences, broken structure (dangling headings, malformed lists or tables), stale or contradictory statements. Categories like: grammar, clarity, structure, accuracy.',
  ].join('\n'),
  doc: [
    '- notes_md: a textual summary of what this document covers and its structure — 1 sentence to 2 short paragraphs. No diagrams.',
    '- Look for: grammar and spelling errors, unclear or ambiguous sentences, broken structure, stale or contradictory statements. Categories like: grammar, clarity, structure, accuracy.',
    '- This text was converted from a document file; ignore conversion artifacts (odd spacing, missing images) unless they destroy meaning. Line numbers refer to the converted text.',
  ].join('\n'),
  config: [
    '- notes_md: 1-3 sentences on what this configuration controls.',
    '- Look for: values that contradict each other, obvious typos in keys, suspicious or unsafe settings, credentials or secrets committed in plain text (report as severity "major", category "secret" — do not repeat the secret value in the message). Categories like: consistency, typo, secret, unsafe-default.',
  ].join('\n'),
};

const GENERIC_RULES = [
  '- notes_md: a short summary of what this file contains and is for — 1 sentence to 2 short paragraphs. No diagrams.',
  '- Look for: real problems a careful reader would flag (errors, contradictions, unclear passages). Categories like: clarity, accuracy, structure.',
].join('\n');

const DIAGRAM_RULE =
  '- Optionally end notes_md with ONE small mermaid diagram of the main flow, in a ```mermaid fenced block, "flowchart TD", 12 nodes max, node labels in ["double quotes"]. Skip the diagram unless the flow between functions is genuinely non-trivial.';

/**
 * Build the review prompt: rubric, strict JSON contract, shared rules,
 * kind-specific rules, then the line-numbered body (numbering is what keeps
 * `issues[].line` non-hallucinated on small models). When a window of a
 * larger file is passed, the numbering carries the window's ABSOLUTE file
 * line numbers and the header says which part this is. Returns the numbered
 * range so callers can drop line refs the model never saw.
 */
export function buildReviewPrompt(
  file: FileRecord,
  content: string,
  rubric: ResolvedRubric,
  opts: {
    inviteDiagram?: boolean;
    window?: Pick<ContentWindow, 'index' | 'count' | 'lineStart' | 'lineEnd' | 'totalLines'>;
  } = {},
): { prompt: string; lineStart: number; shownLines: number } {
  const lineStart = opts.window?.lineStart ?? 1;
  const lines = content.split('\n');
  const numbered = lines.map((l, i) => `${lineStart + i}: ${l}`).join('\n');
  const kindRules = KIND_RULES[file.kind ?? ''] ?? GENERIC_RULES;
  const diagram = opts.inviteDiagram && file.kind === 'code' ? `\n${DIAGRAM_RULE}` : '';
  const w = opts.window;
  const partHeader =
    w && w.count > 1
      ? `\nThis is part ${w.index + 1} of ${w.count} — lines ${w.lineStart}-${w.lineEnd} of a ${w.totalLines}-line file. Review ONLY the lines shown; judge health for this part alone.`
      : '';
  const prompt = [
    `You are reviewing one file for a code-intelligence index. Score it against this rubric:${partHeader}`,
    '',
    rubric.text,
    '',
    'Reply with ONLY a JSON object — no prose before or after it — matching exactly:',
    '{',
    '  "notes_md": "<markdown cliffs notes>",',
    '  "issues": [{"severity": "info" | "minor" | "major", "category": "<one or two words>", "message": "<specific, under 200 chars>", "line": <line number, omit if unknown>}],',
    '  "health": <integer 1-10>,',
    '  "health_reason": "<one line, under 140 chars>"',
    '}',
    '',
    'Rules:',
    '- issues: at most 10, most important first. Real problems only — not style a formatter would fix. Use "major" only for probable incorrect behavior. Use [] when clean.',
    '- health: judge against the rubric. Most ordinary working files score 5-6; reserve 9-10 for genuinely exemplary files and 1-2 for broken ones.',
    '- "line" refers to the numbered lines below.',
    `${kindRules}${diagram}`,
    '',
    `File: ${file.path}`,
    numbered,
  ].join('\n');
  return { prompt, lineStart, shownLines: lines.length };
}

/**
 * Tolerant parse of the review reply: candidate extraction (fenced block →
 * raw → outermost-brace slice, the keurmeester parseVerdict strategy), then
 * small-model normalization, then strict Zod validation. Null on total
 * failure — the caller records a capped attempt.
 */
export function parseFileReviewReply(raw: string): FileReviewReply | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(raw.trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = FileReviewReplySchema.safeParse(normalizeReply(parsed));
    if (result.success) return result.data;
  }
  return null;
}

/** Coerce the common small-model deviations before the strict parse. */
function normalizeReply(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  const health = typeof o.health === 'string' ? Number(o.health) : o.health;
  if (typeof health === 'number' && Number.isFinite(health)) {
    o.health = Math.min(10, Math.max(1, Math.round(health)));
  }
  if (typeof o.notes_md === 'string') o.notes_md = o.notes_md.trim().slice(0, NOTES_MD_CAP);
  if (typeof o.health_reason === 'string') {
    o.health_reason = o.health_reason.trim().slice(0, HEALTH_REASON_CAP);
  }
  o.issues = normalizeIssues(o.issues);
  return o;
}

function normalizeIssues(v: unknown): FileReviewIssue[] {
  if (!Array.isArray(v)) return [];
  const out: FileReviewIssue[] = [];
  for (const entry of v) {
    if (out.length >= MAX_ISSUES) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const message =
      typeof e.message === 'string' ? e.message.trim().slice(0, ISSUE_MESSAGE_CAP) : '';
    if (!message) continue;
    const severity =
      typeof e.severity === 'string' && ISSUE_SEVERITIES.has(e.severity)
        ? (e.severity as FileReviewIssue['severity'])
        : 'info';
    const category =
      typeof e.category === 'string' && e.category.trim()
        ? e.category.trim().slice(0, ISSUE_CATEGORY_CAP)
        : 'general';
    const issue: FileReviewIssue = { severity, category, message };
    const line = typeof e.line === 'string' ? Number(e.line) : e.line;
    if (typeof line === 'number' && Number.isFinite(line) && line >= 1) {
      issue.line = Math.round(line);
    }
    out.push(issue);
  }
  return out;
}

/**
 * Keep a fenced mermaid block only when it plausibly renders: known diagram
 * keyword, bounded size, balanced brackets, no script smuggling. This is a
 * structural heuristic (no mermaid dependency exists in the repo); it kills
 * the common small-model failure shapes — prose inside the fence, unclosed
 * brackets, giant dumps. Non-code kinds strip every block (never invited).
 */
export function sanitizeMermaid(md: string, allowMermaid: boolean): string {
  const out = md.replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (block, body: string) => {
    if (!allowMermaid) return '';
    return isPlausibleMermaid(body) ? block : '';
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function isPlausibleMermaid(body: string): boolean {
  const lines = body.split('\n');
  if (lines.length > MERMAID_MAX_LINES) return false;
  const first = lines.find((l) => l.trim())?.trim() ?? '';
  if (!/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram)/.test(first)) return false;
  if (/<script/i.test(body)) return false;
  for (const [open, close] of [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ] as const) {
    const opens = body.split(open).length - 1;
    const closes = body.split(close).length - 1;
    if (opens !== closes) return false;
  }
  return true;
}

export interface ReviewOutcome {
  reviewed: boolean;
  /** True when a retry attempt was consumed (non-empty, unparseable reply). */
  attempted: boolean;
  /** True when the model returned nothing at all (engine down / timeout). */
  emptyReply: boolean;
  /**
   * True when this content genuinely cannot be reviewed (blocked/failed doc
   * conversion, empty file, vanished source) and was terminally skipped.
   * Costs no LLM call; counts toward neither batch progress nor the
   * empty-reply breaker.
   */
  unavailable?: boolean;
}

function reviewMaxWindows(): number {
  const env = Number(process.env.GEZEL_REVIEW_MAX_WINDOWS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return DEFAULT_REVIEW_MAX_WINDOWS;
}

/** Review one file against its kind's rubric; see module doc for semantics. */
export async function reviewFile(
  store: IndexStore,
  workspaceDir: string,
  artifactsDir: string,
  file: FileRecord,
  rubric: ResolvedRubric,
  deps: EnrichDeps,
): Promise<ReviewOutcome> {
  const skipped: ReviewOutcome = { reviewed: false, attempted: false, emptyReply: false };
  if (!file.hash || !deps.review) return skipped;
  const content = await readEnrichableText(workspaceDir, artifactsDir, file);
  if (!content?.trim()) {
    store.markReviewUnavailable(file.hash, file.path, rubric.hash, MAX_REVIEW_ATTEMPTS);
    return { ...skipped, unavailable: true };
  }

  const inviteDiagram =
    file.kind === 'code' && ((file.loc ?? 0) >= 60 || store.symbolsForFile(file.path).length >= 5);
  const complete = deps.review;
  const run = await runLargeContentCompletion(
    (prompt) => complete(prompt),
    content,
    (window) =>
      buildReviewPrompt(file, window.text, rubric, {
        inviteDiagram,
        ...(window.count > 1 ? { window } : {}),
      }).prompt,
    {
      budgetChars: Math.max(
        MIN_WINDOW_CHARS,
        completionBudgetChars(deps.provenance?.provider) - REVIEW_SCAFFOLD_CHARS,
      ),
      maxWindows: reviewMaxWindows(),
      overlapLines: REVIEW_WINDOW_OVERLAP_LINES,
    },
  );
  if (run.refused) {
    store.markReviewUnavailable(file.hash, file.path, rubric.hash, MAX_REVIEW_ATTEMPTS);
    return { ...skipped, unavailable: true };
  }
  if (run.replies.every((r) => !r.raw.trim())) {
    // Engine down or timed out — burn no retry budget; the file stays listed.
    return { reviewed: false, attempted: false, emptyReply: true };
  }

  const parsed: Array<{ window: ContentWindow; reply: FileReviewReply }> = [];
  for (const { window, raw } of run.replies) {
    if (!raw.trim()) continue;
    const reply = parseFileReviewReply(raw);
    if (reply) parsed.push({ window, reply });
  }
  if (parsed.length === 0) {
    store.recordReviewAttempt(file.hash, file.path, rubric.hash);
    return { reviewed: false, attempted: true, emptyReply: false };
  }

  store.upsertFileReview({
    contentHash: file.hash,
    filePath: file.path,
    rubricHash: rubric.hash,
    ...mergeWindowReplies(parsed, run, file.kind === 'code'),
    model: deps.model ?? 'unknown',
    ...(deps.provenance ? { provenance: deps.provenance } : {}),
  });
  return { reviewed: true, attempted: true, emptyReply: false };
}

/**
 * Fold per-window replies into one stored review: issues keep their absolute
 * anchors (clamped to the lines their window actually showed, then deduped
 * across overlaps), health is the WORST window (a file with one broken part
 * is a file with a problem), and the notes come from the first window plus an
 * honest coverage marker whenever the file was reviewed in parts.
 */
function mergeWindowReplies(
  parsed: Array<{ window: ContentWindow; reply: FileReviewReply }>,
  run: { totalWindows: number; truncated: boolean },
  allowMermaid: boolean,
): { notesMd: string; issues: FileReviewIssue[]; health: number; healthReason: string } {
  const issues: FileReviewIssue[] = [];
  const seen = new Set<string>();
  for (const { window, reply } of parsed) {
    for (const issue of reply.issues) {
      const inWindow =
        issue.line === undefined ||
        (issue.line >= window.lineStart &&
          issue.line < window.lineStart + window.text.split('\n').length);
      const kept = inWindow ? issue : stripLine(issue);
      const key = `${kept.line ?? ''}:${kept.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (issues.length < MAX_ISSUES) issues.push(kept);
    }
  }
  let worst = parsed[0]!;
  for (const p of parsed) {
    if (p.reply.health < worst.reply.health) worst = p;
  }
  let notesMd = sanitizeMermaid(parsed[0]!.reply.notes_md, allowMermaid);
  if (run.totalWindows > 1) {
    const marker = run.truncated
      ? `_(reviewed in ${parsed.length} of ${run.totalWindows} parts — the remainder was not reviewed)_`
      : `_(reviewed in ${run.totalWindows} parts)_`;
    notesMd = `${notesMd}\n\n${marker}`.slice(0, NOTES_MD_CAP);
  }
  return {
    notesMd,
    issues,
    health: worst.reply.health,
    healthReason: worst.reply.health_reason,
  };
}

function stripLine(issue: FileReviewIssue): FileReviewIssue {
  const { line: _dropped, ...rest } = issue;
  return rest;
}
