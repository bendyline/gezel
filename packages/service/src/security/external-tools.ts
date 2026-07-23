/**
 * Opportunistic OSS security-tool ingestion. Detects `semgrep`, `osv-scanner`,
 * `gitleaks`, and `npm` on the host PATH and, when present, runs them and
 * normalizes their JSON output into the index's finding/advisory shapes — the
 * exact "shell out to a real tool if it's installed, otherwise degrade" pattern
 * gezel already uses for ripgrep. NONE of these is a dependency; every call is
 * wrapped so a missing binary, a non-zero exit, or malformed output yields an
 * empty result rather than an error. Secret VALUES are never propagated.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';
import type { SecurityFindingInput, SecuritySeverity } from '../index-store/index-store.js';

const log = createLogger('security');
const exec = promisify(execFile);

const TOOL_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 128 * 1024 * 1024;

export type ToolFinding = SecurityFindingInput & { filePath: string };

export interface ToolAdvisory {
  /** npm/pypi package name. */
  name: string;
  ecosystem: string;
  advisoryIds: string[];
  maxSeverity: SecuritySeverity | null;
}

/** Which OSS tools are available on this host. */
export interface AvailableTools {
  semgrep: boolean;
  osvScanner: boolean;
  gitleaks: boolean;
  npm: boolean;
}

/** True when `cmd` resolves on PATH. */
export async function hasCommand(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await exec(probe, [cmd], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectTools(): Promise<AvailableTools> {
  const [semgrep, osvScanner, gitleaks, npm] = await Promise.all([
    hasCommand('semgrep'),
    hasCommand('osv-scanner'),
    hasCommand('gitleaks'),
    hasCommand('npm'),
  ]);
  return { semgrep, osvScanner, gitleaks, npm };
}

async function runJson(cmd: string, args: string[], cwd: string): Promise<unknown | null> {
  try {
    const { stdout } = await exec(cmd, args, {
      cwd,
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  } catch (err) {
    // Many of these tools exit non-zero WHEN THEY FIND ISSUES but still print
    // valid JSON to stdout — recover it from the error object when present.
    const e = err as { stdout?: string; message?: string };
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch {
        /* fall through */
      }
    }
    log.debug(`[security] ${cmd} run failed:`, e.message ?? err);
    return null;
  }
}

// ── semgrep ────────────────────────────────────────────────────────────────

function semgrepSeverity(s: string | undefined): SecuritySeverity {
  switch ((s ?? '').toUpperCase()) {
    case 'ERROR':
      return 'high';
    case 'WARNING':
      return 'medium';
    default:
      return 'low';
  }
}

export async function runSemgrep(workspaceDir: string): Promise<ToolFinding[]> {
  const json = (await runJson(
    'semgrep',
    ['--json', '--quiet', '--config', 'auto', '--metrics=off', '.'],
    workspaceDir,
  )) as { results?: Array<Record<string, unknown>> } | null;
  if (!json?.results) return [];
  const out: ToolFinding[] = [];
  for (const r of json.results) {
    const extra = (r.extra ?? {}) as { severity?: string; message?: string };
    const start = (r.start ?? {}) as { line?: number };
    const checkId = String(r.check_id ?? 'semgrep');
    out.push({
      filePath: relPath(String(r.path ?? ''), workspaceDir),
      line: start.line ?? null,
      ruleId: checkId,
      category: categoryFromCheckId(checkId),
      severity: semgrepSeverity(extra.severity),
      title: (extra.message ?? checkId).slice(0, 200),
    });
  }
  return out;
}

/** Bucket a semgrep check id into one of our coarse categories. */
function categoryFromCheckId(id: string): string {
  const s = id.toLowerCase();
  if (/sql|injection|inject/.test(s)) return 'injection';
  if (/command|exec|shell/.test(s)) return 'command-injection';
  if (/xss|innerhtml|dom/.test(s)) return 'xss';
  if (/ssrf|request-forgery/.test(s)) return 'ssrf';
  if (/path|traversal/.test(s)) return 'path-traversal';
  if (/deserial|pickle|yaml/.test(s)) return 'deserialization';
  if (/crypto|hash|cipher|random/.test(s)) return 'crypto';
  if (/secret|hardcoded|credential|token|password/.test(s)) return 'secret';
  if (/auth|access-control|permission/.test(s)) return 'auth';
  return 'other';
}

// ── gitleaks ────────────────────────────────────────────────────────────────

export async function runGitleaks(workspaceDir: string): Promise<ToolFinding[]> {
  // `--no-git` scans the working tree (not just committed history); report to
  // stdout. We deliberately ignore the `Secret`/`Match` fields — only location.
  const json = (await runJson(
    'gitleaks',
    ['detect', '--no-git', '--report-format', 'json', '--report-path', '/dev/stdout', '--redact'],
    workspaceDir,
  )) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(json)) return [];
  return json.map((r) => ({
    filePath: relPath(String(r.File ?? ''), workspaceDir),
    line: typeof r.StartLine === 'number' ? r.StartLine : null,
    ruleId: `gitleaks.${String(r.RuleID ?? 'secret')}`,
    category: 'secret',
    severity: 'high' as SecuritySeverity,
    title: String(r.Description ?? 'Secret detected by gitleaks').slice(0, 200),
  }));
}

// ── SCA: osv-scanner (preferred) then npm audit (fallback) ──────────────────

function osvSeverity(v: Record<string, unknown>): SecuritySeverity {
  const ds = (v.database_specific ?? {}) as { severity?: string };
  switch ((ds.severity ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'medium';
  }
}

export async function runOsvScanner(workspaceDir: string): Promise<ToolAdvisory[]> {
  const json = (await runJson('osv-scanner', ['--format', 'json', '-r', '.'], workspaceDir)) as {
    results?: Array<{ packages?: Array<Record<string, unknown>> }>;
  } | null;
  if (!json?.results) return [];
  const byPkg = new Map<string, ToolAdvisory>();
  for (const res of json.results) {
    for (const p of res.packages ?? []) {
      const pkg = (p.package ?? {}) as { name?: string; ecosystem?: string };
      const vulns = (p.vulnerabilities ?? []) as Array<Record<string, unknown>>;
      if (!pkg.name || vulns.length === 0) continue;
      const eco = (pkg.ecosystem ?? 'npm').toLowerCase();
      const key = `${eco}:${pkg.name}`;
      const rec = byPkg.get(key) ?? {
        name: pkg.name,
        ecosystem: eco,
        advisoryIds: [],
        maxSeverity: null,
      };
      for (const v of vulns) {
        if (v.id) rec.advisoryIds.push(String(v.id));
        rec.maxSeverity = maxSev(rec.maxSeverity, osvSeverity(v));
      }
      byPkg.set(key, rec);
    }
  }
  return [...byPkg.values()];
}

export async function runNpmAudit(workspaceDir: string): Promise<ToolAdvisory[]> {
  const json = (await runJson('npm', ['audit', '--json', '--audit-level=low'], workspaceDir)) as {
    vulnerabilities?: Record<string, Record<string, unknown>>;
  } | null;
  const vulns = json?.vulnerabilities;
  if (!vulns) return [];
  const out: ToolAdvisory[] = [];
  for (const [name, info] of Object.entries(vulns)) {
    const via = (info.via ?? []) as Array<string | Record<string, unknown>>;
    const advisoryIds: string[] = [];
    for (const v of via) {
      if (typeof v === 'object' && v.source != null) advisoryIds.push(`npm-${String(v.source)}`);
    }
    out.push({
      name,
      ecosystem: 'npm',
      advisoryIds,
      maxSeverity: npmSeverity(String(info.severity ?? '')),
    });
  }
  return out;
}

function npmSeverity(s: string): SecuritySeverity {
  switch (s.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'medium';
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const SEV_ORDER: SecuritySeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
function maxSev(a: SecuritySeverity | null, b: SecuritySeverity): SecuritySeverity {
  if (!a) return b;
  return SEV_ORDER.indexOf(b) > SEV_ORDER.indexOf(a) ? b : a;
}

/** Normalize a tool-reported path to workspace-relative, forward-slashed. */
function relPath(p: string, workspaceDir: string): string {
  let rel = p;
  if (p.startsWith(workspaceDir)) rel = p.slice(workspaceDir.length);
  return rel.replace(/^[./\\]+/, '').replaceAll('\\', '/');
}
