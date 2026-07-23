import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Summary of Keurmeester intervention case records harvested into
 * `<runDir>/keurmeester/cases/*.jsonl` by the trial capture step.
 * Attached to `result.json` and to the score-trial facts so supervisor
 * A/Bs can read consult counts / action mix / outcomes without parsing
 * raw JSONL. `null` (absent) means the trial ran without the
 * supervisor arm — distinct from `consults: 0` (armed but never
 * triggered), which is the expected control-scenario reading.
 */
export interface KeurmeesterTrialSummary {
  consults: number;
  applied: number;
  /** Verdict action mix, e.g. { corrective_prompt: 2, rewrite_step: 1 }. */
  actions: Record<string, number>;
  /** Diagnosed failure classes, e.g. { silent_stall: 2 }. */
  failureClasses: Record<string, number>;
  /** Joined case outcomes, e.g. { unblocked: 2, gave_up: 1 }. */
  outcomes: Record<string, number>;
  avgConsultDurationMs: number;
  /** Cases whose consult itself failed (no verdict parsed). */
  consultFailures: number;
}

interface CaseOpenedLine {
  record: 'case.opened';
  caseId: string;
  applied?: boolean;
  consultDurationMs?: number;
  verdict?: { failureClass?: string; action?: { kind?: string } };
}

interface CaseClosedLine {
  record: 'case.closed';
  caseId: string;
  outcome?: string;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Read + aggregate the harvested case records for one trial. Returns
 * null when the trial has no `keurmeester/cases/` dir (control arm).
 * Malformed lines are skipped — a partial harvest must not fail the
 * whole scoring pass.
 */
export async function summarizeKeurmeesterCases(
  runDir: string,
): Promise<KeurmeesterTrialSummary | null> {
  const casesDir = join(runDir, 'keurmeester', 'cases');
  let files: string[];
  try {
    files = (await readdir(casesDir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return null;
  }
  const contents = await Promise.all(
    files.map((f) => readFile(join(casesDir, f), 'utf8').catch(() => '')),
  );
  return aggregate(contents);
}

/** Sync twin for the synchronous score-trial facts pass. */
export function summarizeKeurmeesterCasesSync(runDir: string): KeurmeesterTrialSummary | null {
  const casesDir = join(runDir, 'keurmeester', 'cases');
  let files: string[];
  try {
    files = readdirSync(casesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return null;
  }
  const contents = files.map((f) => {
    try {
      return readFileSync(join(casesDir, f), 'utf8');
    } catch {
      return '';
    }
  });
  return aggregate(contents);
}

function aggregate(contents: string[]): KeurmeesterTrialSummary {
  const summary: KeurmeesterTrialSummary = {
    consults: 0,
    applied: 0,
    actions: {},
    failureClasses: {},
    outcomes: {},
    avgConsultDurationMs: 0,
    consultFailures: 0,
  };
  let durationTotal = 0;
  for (const raw of contents) {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: CaseOpenedLine | CaseClosedLine;
      try {
        parsed = JSON.parse(line) as CaseOpenedLine | CaseClosedLine;
      } catch {
        continue;
      }
      if (parsed.record === 'case.opened') {
        summary.consults += 1;
        if (parsed.applied) summary.applied += 1;
        durationTotal += parsed.consultDurationMs ?? 0;
        if (parsed.verdict?.action?.kind) bump(summary.actions, parsed.verdict.action.kind);
        else summary.consultFailures += 1;
        if (parsed.verdict?.failureClass) {
          bump(summary.failureClasses, parsed.verdict.failureClass);
        }
      } else if (parsed.record === 'case.closed' && parsed.outcome) {
        bump(summary.outcomes, parsed.outcome);
      }
    }
  }
  if (summary.consults > 0) {
    summary.avgConsultDurationMs = Math.round(durationTotal / summary.consults);
  }
  return summary;
}
