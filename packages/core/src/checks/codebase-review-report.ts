import type { CheckResult, WorkspaceLike } from './types.js';
import { createCitedPathChecker } from './workspace-exists.js';

/**
 * Structural gate for a comprehensive codebase-review deliverable. A
 * `markdown-report` floor (minBytes + a heading regex) can't tell a real
 * consultant review from confident fiction, so this verifies the report's
 * SHAPE and, crucially, that every finding cites a REAL source file (the
 * anti-fabrication rule shared with `securityReport` / `citationsResolve`).
 *
 * Two surfaces, because a review's deliverables and its subject live in
 * different stores: `reports` is where the report + findings JSON land
 * (the artifacts drawer for the night-shift review books), `workspace` is
 * the source tree the findings cite. `securityReport` conflates the two,
 * which is why it silently stopped gating once review output moved to the
 * drawer.
 *
 * It asserts, in order:
 *   1. the report + a machine-readable findings JSON both exist and parse;
 *   2. every finding names a real workspace file with a severity, title,
 *      and concrete remediation — critical/high findings must also be
 *      pinned to a line (file-level citations are legal below that);
 *   3. the report carries the required sections;
 *   4. the Scorecard section holds a real per-dimension table;
 *   5. with enough material to cluster (≥ themeThreshold findings), the
 *      systemic-themes section names ≥ minThemes themes with root cause +
 *      blast radius;
 *   6. the executive summary is consistent with the open severity (no
 *      "excellent health" over an open critical/high).
 *
 * Pure + Node-free so it bundles into the sandbox SDK.
 */

const DEFAULT_SECTIONS = [
  'Executive summary',
  'Scorecard',
  'Index coverage and method',
  'Systemic themes',
  'Findings',
  'Quick wins',
  'Strategic recommendations',
  'Verified sound',
  'Not assessed',
  'Suggested deeper reviews',
];

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

export interface CodebaseReviewReportOptions {
  /** Path (in `reports`) to the machine-readable findings JSON. */
  findings?: string;
  /** Section headings the report must contain. */
  requiredSections?: string[];
  /** Minimum systemic themes required once findings ≥ themeThreshold. */
  minThemes?: number;
  /** Findings count at/above which systemic-theme synthesis is required. */
  themeThreshold?: number;
  /** Minimum data rows the Scorecard table must carry. */
  minScorecardRows?: number;
}

export interface CodebaseReviewReportResult extends CheckResult {
  findingCount: number;
  /** Cited files that don't exist in the workspace, for logs/facts. */
  fabricated: string[];
}

function str(x: unknown): string {
  return typeof x === 'string' ? x.trim() : '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the doc has a `## Name` (1–4 hashes) heading, case-insensitive. */
function hasSection(content: string, name: string): boolean {
  return new RegExp(`^#{1,4}\\s+${escapeRe(name)}\\b`, 'im').test(content);
}

/** The text under a `## Name` heading up to the next same-or-higher heading. */
function sectionBody(content: string, name: string): string {
  const m = new RegExp(`^(#{1,4})\\s+${escapeRe(name)}\\b`, 'im').exec(content);
  if (!m) return '';
  const level = m[1]!.length;
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  const next = new RegExp(`^#{1,${level}}\\s+\\S`, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Count theme items in a section: sub-headings, bullets, or numbered/bold leads. */
function countThemeItems(section: string): number {
  let n = 0;
  for (const line of section.split(/\r?\n/)) {
    if (/^\s*(#{3,4}\s+\S|[-*]\s+\S|\d+\.\s+\S|\*\*[^*]+\*\*)/.test(line)) n++;
  }
  return n;
}

/** Data rows of the first markdown table whose header names a Dimension column. */
function scorecardRows(section: string): number {
  const lines = section.split(/\r?\n/);
  let headerAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /^\s*\|/.test(line) &&
      /dimension/i.test(line) &&
      /(grade|rating|score|health)/i.test(line)
    ) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) return -1;
  let rows = 0;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s*\|/.test(line)) break;
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue; // separator row
    if (line.replace(/[|\s]/g, '').length === 0) continue;
    rows++;
  }
  return rows;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

export async function codebaseReviewReport(
  reports: WorkspaceLike,
  workspace: WorkspaceLike,
  reportFile: string,
  opts: CodebaseReviewReportOptions = {},
): Promise<CodebaseReviewReportResult> {
  const fail = (
    detail: string,
    count = 0,
    fabricated: string[] = [],
  ): CodebaseReviewReportResult => ({
    ok: false,
    detail,
    findingCount: count,
    fabricated,
  });

  const content = await reports.read(reportFile);
  if (content === null) {
    return fail(`${reportFile} not found — write the codebase review report before advancing.`);
  }

  const findingsPath = opts.findings ?? 'codebase-review-findings.json';
  const raw = await reports.read(findingsPath);
  if (raw === null) {
    return fail(
      `${findingsPath} not found — emit a machine-readable findings JSON alongside the report.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(
      `${findingsPath} is not valid JSON (${e instanceof Error ? e.message : 'parse error'}). Emit a JSON array of findings.`,
    );
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : null;
  if (!arr) {
    return fail(`${findingsPath} must be a JSON array of findings (or { "findings": [...] }).`);
  }

  const citedPathExists = createCitedPathChecker(workspace);
  const problems: string[] = [];
  const fabricated: string[] = [];
  let critHigh = 0;

  for (const [i, rawFinding] of arr.entries()) {
    const f = (rawFinding ?? {}) as Record<string, unknown>;
    const file = str(f.file ?? f.path);
    const sev = str(f.severity).toLowerCase();
    const remediation = str(f.remediation ?? f.fix ?? f.recommendation);
    const title = str(f.title ?? f.description ?? f.summary);
    const line = f.line ?? f.lineStart;
    const label = file || `#${i + 1}`;
    if (!file) problems.push(`finding #${i + 1} has no file`);
    else if (!(await citedPathExists(file))) fabricated.push(file);
    if (!VALID_SEVERITIES.has(sev)) problems.push(`${label} has an invalid severity "${sev}"`);
    if (!remediation) problems.push(`${label} has no remediation`);
    if (!title) problems.push(`${label} has no title/description`);
    if ((sev === 'critical' || sev === 'high') && typeof line !== 'number') {
      problems.push(`${label} is ${sev} but not pinned to a line`);
    }
    if (sev === 'critical' || sev === 'high') critHigh++;
  }

  if (fabricated.length > 0) {
    return fail(
      `findings cite ${fabricated.length} file(s) that don't exist in the workspace: ${uniq(fabricated).slice(0, 5).join(', ')} — every finding must point at a real file (no fabricated citations).`,
      arr.length,
      uniq(fabricated),
    );
  }
  if (problems.length > 0) {
    return fail(
      `${problems.length} finding(s) are incomplete: ${problems.slice(0, 4).join('; ')} — every finding needs a real file, a severity, a title, and a concrete remediation (critical/high pinned to a line).`,
      arr.length,
    );
  }

  const requiredSections = opts.requiredSections ?? DEFAULT_SECTIONS;
  const missing = requiredSections.filter((s) => !hasSection(content, s));
  if (missing.length > 0) {
    return fail(
      `the report is missing required section(s): ${missing.map((s) => `## ${s}`).join(', ')}.`,
      arr.length,
    );
  }

  const minRows = opts.minScorecardRows ?? 4;
  const rows = scorecardRows(sectionBody(content, 'Scorecard'));
  if (rows < 0) {
    return fail(
      'the "Scorecard" section has no per-dimension table — add a markdown table with Dimension and Grade columns.',
      arr.length,
    );
  }
  if (rows < minRows) {
    return fail(
      `the Scorecard table has ${rows} dimension row(s); grade at least ${minRows} dimensions (e.g. architecture, code quality, hygiene, security, tests).`,
      arr.length,
    );
  }

  const themeThreshold = opts.themeThreshold ?? 3;
  const minThemes = opts.minThemes ?? 2;
  if (arr.length >= themeThreshold) {
    const themes = sectionBody(content, 'Systemic themes');
    const items = countThemeItems(themes);
    if (items < minThemes) {
      return fail(
        `the "Systemic themes" section lists ${items} theme(s); a review with ${arr.length} findings needs ≥ ${minThemes}, each naming a root cause and its blast radius.`,
        arr.length,
      );
    }
    if (
      !/root[\s-]?cause/i.test(themes) ||
      !/(blast[\s-]?radius|impact|scope|reach)/i.test(themes)
    ) {
      return fail(
        'the "Systemic themes" section must analyze each theme\'s root cause and blast radius — that analysis is absent.',
        arr.length,
      );
    }
  }

  const summary = sectionBody(content, 'Executive summary').toLowerCase();
  if (
    critHigh > 0 &&
    /(excellent (health|shape|condition)|no (significant |material )?(issues|problems|findings)|nothing to fix|clean bill of health)/.test(
      summary,
    ) &&
    !/(critical|high|however|but |concern|risk)/.test(summary)
  ) {
    return fail(
      `the executive summary reads clean but there ${critHigh === 1 ? 'is' : 'are'} ${critHigh} critical/high finding(s) — the summary must reflect the open severity.`,
      arr.length,
    );
  }

  return {
    ok: true,
    detail: `codebase review OK: ${arr.length} finding(s), all cite real files, ${rows} scorecard dimension(s), required sections present${arr.length >= themeThreshold ? ', systemic themes analyzed' : ''}.`,
    findingCount: arr.length,
    fabricated: [],
  };
}
