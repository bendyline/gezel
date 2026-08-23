import type { CheckResult, WorkspaceLike } from './types.js';
import { createCitedPathChecker } from './workspace-exists.js';

/**
 * Structural gate for a whole-codebase security review deliverable — the
 * closing-the-gate-gap check. A `markdown-report` floor (minBytes + a heading
 * regex) can't tell a real audit from confident fiction, so this verifies the
 * report's SHAPE and, crucially, that every finding cites a REAL file (the
 * anti-fabrication rule, same lesson as `citationsResolve`).
 *
 * It asserts, in order:
 *   1. the report + a machine-readable findings JSON both exist and parse;
 *   2. every finding is pinned to a real file:line with a severity + remediation
 *      (no fabricated paths — the failure names them);
 *   3. the report carries the required sections;
 *   4. when there's enough material to cluster (≥ themeThreshold findings), the
 *      "Systemic Themes" section names ≥ minThemes themes with root cause + blast
 *      radius — the systemic synthesis a per-file scan can't produce;
 *   5. the verdict is consistent with the open severity (no "safe" over an open
 *      critical/high).
 *
 * Pure + Node-free so it bundles into the sandbox SDK.
 */

const DEFAULT_SECTIONS = [
  'Verdict',
  'Systemic Themes',
  'Findings',
  'Verified Safe',
  'Not Statically Verifiable',
];

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

export interface SecurityReportOptions {
  /** Path to the machine-readable findings JSON. */
  findings?: string;
  /** Section headings the report must contain. */
  requiredSections?: string[];
  /** Minimum systemic themes required once findings ≥ themeThreshold. */
  minThemes?: number;
  /** Findings count at/above which systemic-theme synthesis is required. */
  themeThreshold?: number;
}

export interface SecurityReportResult extends CheckResult {
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

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

export async function securityReport(
  ws: WorkspaceLike,
  reportFile: string,
  opts: SecurityReportOptions = {},
): Promise<SecurityReportResult> {
  const fail = (detail: string, count = 0, fabricated: string[] = []): SecurityReportResult => ({
    ok: false,
    detail,
    findingCount: count,
    fabricated,
  });

  const content = await ws.read(reportFile);
  if (content === null) {
    return fail(`${reportFile} not found — write the security report before advancing.`);
  }

  const findingsPath = opts.findings ?? 'security-review/findings.json';
  const raw = await ws.read(findingsPath);
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

  const citedPathExists = createCitedPathChecker(ws);
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
    if (typeof line !== 'number') problems.push(`${label} is not pinned to a line`);
    if (sev === 'critical' || sev === 'high') critHigh++;
  }

  if (fabricated.length > 0) {
    return fail(
      `findings cite ${fabricated.length} file(s) that don't exist in the workspace: ${uniq(fabricated).slice(0, 5).join(', ')} — every finding must point at a real file:line (no fabricated citations).`,
      arr.length,
      uniq(fabricated),
    );
  }
  if (problems.length > 0) {
    return fail(
      `${problems.length} finding(s) are incomplete: ${problems.slice(0, 4).join('; ')} — every finding needs a real file:line, a severity, and a concrete remediation.`,
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

  const themeThreshold = opts.themeThreshold ?? 3;
  const minThemes = opts.minThemes ?? 2;
  if (arr.length >= themeThreshold) {
    const themes = sectionBody(content, 'Systemic Themes');
    const items = countThemeItems(themes);
    if (items < minThemes) {
      return fail(
        `the "Systemic Themes" section lists ${items} theme(s); a review with ${arr.length} findings needs ≥ ${minThemes}, each naming a root cause and its blast radius.`,
        arr.length,
      );
    }
    if (
      !/root[\s-]?cause/i.test(themes) ||
      !/(blast[\s-]?radius|impact|scope|reach)/i.test(themes)
    ) {
      return fail(
        'the "Systemic Themes" section must analyze each theme\'s root cause and blast radius — that analysis is absent.',
        arr.length,
      );
    }
  }

  const verdict = sectionBody(content, 'Verdict').toLowerCase();
  if (
    critHigh > 0 &&
    /(safe[\s-]?to[\s-]?merge|no (security )?(issues|findings|vulnerabilities)|looks secure|no concerns|all clear)/.test(
      verdict,
    ) &&
    !/(block|after[\s-]?fix|merge[\s-]?after|do not merge|concern|open (critical|high))/.test(
      verdict,
    )
  ) {
    return fail(
      `the verdict reads "safe" but there ${critHigh === 1 ? 'is' : 'are'} ${critHigh} critical/high finding(s) — the verdict must reflect the open severity.`,
      arr.length,
    );
  }

  return {
    ok: true,
    detail: `security report OK: ${arr.length} finding(s), all cite real files, required sections present${arr.length >= themeThreshold ? ', systemic themes analyzed' : ''}.`,
    findingCount: arr.length,
    fabricated: [],
  };
}
