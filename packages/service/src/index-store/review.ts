import { FileReviewReplySchema } from '@bendyline/gezel';
import type { FileReviewIssue, FileReviewReply } from '@bendyline/gezel';
import { type EnrichDeps, readEnrichableText } from './enrich.js';
import type { FileRecord, IndexStore } from './index-store.js';
import type { ResolvedRubric } from './rubrics.js';

/**
 * The boekwachter review pass (one file per LLM call): type-specific cliffs
 * notes, a structured issue list, and a 1-10 health score judged against the
 * file kind's rubric. Runs strictly AFTER the enrichment tier drains — the
 * summary/embedding pipeline feeds search coverage (the benchmarked metric)
 * and must never wait behind reviews.
 *
 * Failure semantics differ from the summary pass on purpose:
 *   - empty reply (engine down / timeout)     → no gate write, retried freely
 *   - non-empty but unparseable/invalid reply → capped attempt (retried up to
 *     MAX_REVIEW_ATTEMPTS per rubric, budget resets when the rubric changes)
 *   - success                                 → row upserted, attempts reset
 */

export const MAX_REVIEW_ATTEMPTS = 3;
const REVIEW_CONTENT_CAP = 6000;
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
 * `issues[].line` non-hallucinated on small models). Returns the shown line
 * count so callers can drop line refs the model never saw.
 */
export function buildReviewPrompt(
  file: FileRecord,
  content: string,
  rubric: ResolvedRubric,
  opts: { inviteDiagram?: boolean } = {},
): { prompt: string; shownLines: number } {
  const capped =
    content.length > REVIEW_CONTENT_CAP ? content.slice(0, REVIEW_CONTENT_CAP) : content;
  const lines = capped.split('\n');
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  const truncated =
    content.length > REVIEW_CONTENT_CAP
      ? '\n(file truncated here — review only the lines shown)'
      : '';
  const kindRules = KIND_RULES[file.kind ?? ''] ?? GENERIC_RULES;
  const diagram = opts.inviteDiagram && file.kind === 'code' ? `\n${DIAGRAM_RULE}` : '';
  const prompt = [
    'You are reviewing one file for a code-intelligence index. Score it against this rubric:',
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
    `${numbered}${truncated}`,
  ].join('\n');
  return { prompt, shownLines: lines.length };
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
}

/** Review one file against its kind's rubric; see module doc for semantics. */
export async function reviewFile(
  store: IndexStore,
  workspaceDir: string,
  file: FileRecord,
  rubric: ResolvedRubric,
  deps: EnrichDeps,
): Promise<ReviewOutcome> {
  const skipped: ReviewOutcome = { reviewed: false, attempted: false, emptyReply: false };
  if (!file.hash || !deps.review) return skipped;
  const content = await readEnrichableText(workspaceDir, file);
  if (!content?.trim()) return skipped;

  const inviteDiagram =
    file.kind === 'code' && ((file.loc ?? 0) >= 60 || store.symbolsForFile(file.path).length >= 5);
  const { prompt, shownLines } = buildReviewPrompt(file, content, rubric, { inviteDiagram });

  let raw = '';
  try {
    raw = await deps.review(prompt);
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    // Engine down or timed out — burn no retry budget; the file stays listed.
    return { reviewed: false, attempted: false, emptyReply: true };
  }

  const reply = parseFileReviewReply(raw);
  if (!reply) {
    store.recordReviewAttempt(file.hash, file.path, rubric.hash);
    return { reviewed: false, attempted: true, emptyReply: false };
  }

  // Line refs past what the prompt showed are hallucinated — keep the issue,
  // drop its anchor.
  const issues = reply.issues.map((i) => {
    if (i.line !== undefined && i.line > shownLines) {
      const { line: _dropped, ...rest } = i;
      return rest;
    }
    return i;
  });
  store.upsertFileReview({
    contentHash: file.hash,
    filePath: file.path,
    rubricHash: rubric.hash,
    notesMd: sanitizeMermaid(reply.notes_md, file.kind === 'code'),
    issues,
    health: reply.health,
    healthReason: reply.health_reason,
    model: deps.model ?? 'unknown',
  });
  return { reviewed: true, attempted: true, emptyReply: false };
}
