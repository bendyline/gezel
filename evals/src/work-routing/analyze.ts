import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type PairedEffect, holm, pairedEffect, pairsNeeded } from '../ab-stats.ts';
import type { ProbeCategory } from './probes.ts';
import { probeForScenario, rescoreTrial } from './rescore.ts';

/**
 * Read-out for the suggest_work / start_work A/B: per arm, per category, and
 * paired against the baseline per model. Rows come from each trial's
 * `result.json`, whose `diagnostics` the route probes write. Any other
 * scenario (a whole first project, say) is an `end-to-end` row scored on
 * its own pass/fail.
 *
 * Trials pair on (probe, rep): rep k of a probe in one arm against rep k in
 * the other. Reps of one probe are not independent — a probe the model finds
 * hard is hard in every rep — so the interval is a bootstrap stratified by
 * probe, beside the exact McNemar test on the discordant pairs.
 */

export interface RouteTrialRow {
  model: string;
  arm: string;
  scenarioId: string;
  probe: string;
  category: ProbeCategory | 'unknown' | 'end-to-end';
  /** Not used to set suggest_work's floors (probes.ts). */
  heldOut: boolean;
  rep: number;
  accepted: boolean;
  kindAccepted: boolean;
  routeKind: string;
  routeTarget?: string;
  callsBeforeRoute: number | null;
  fabricatedClaim: boolean;
  durationMs: number;
  reason: string;
  /** Re-scoring from the saved transcript changed this trial's route or verdict. */
  changedByRescore?: boolean;
  /** Never reached the model (setup crash, engine stall); left out of every statistic. */
  excluded?: boolean;
}

const HARNESS_FAILURE_RE = /^runner crashed:|pre-provider stall/;

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** `<root>/<model>/<arm>/<scenario>/<trial>/result.json` → rows. */
export async function readRouteRows(
  root: string,
  opts: { rescore?: boolean } = {},
): Promise<RouteTrialRow[]> {
  const rows: RouteTrialRow[] = [];
  for (const model of await listDirs(root)) {
    for (const arm of await listDirs(join(root, model))) {
      for (const scenarioId of await listDirs(join(root, model, arm))) {
        const routeProbe = scenarioId.startsWith('route-');
        const trials = (await listDirs(join(root, model, arm, scenarioId))).sort();
        let rep = 0;
        for (const trial of trials) {
          let result: Record<string, unknown>;
          try {
            result = JSON.parse(
              await readFile(join(root, model, arm, scenarioId, trial, 'result.json'), 'utf8'),
            );
          } catch {
            continue;
          }
          const d = (result.diagnostics ?? {}) as Record<string, unknown>;
          const route = (d.route ?? {}) as { kind?: string; target?: string };
          const row: RouteTrialRow = {
            model,
            arm,
            scenarioId,
            probe: typeof d.probe === 'string' ? d.probe : scenarioId.replace(/^route-/, ''),
            category: routeProbe
              ? ((typeof d.category === 'string' ? d.category : 'unknown') as
                  | ProbeCategory
                  | 'unknown')
              : 'end-to-end',
            heldOut: d.heldOut === true,
            rep: rep++,
            accepted: routeProbe ? d.accepted === true : result.success === true,
            kindAccepted: routeProbe ? d.kindAccepted === true : result.success === true,
            routeKind: route.kind ?? (result.success ? 'unknown' : 'none'),
            ...(route.target ? { routeTarget: route.target } : {}),
            callsBeforeRoute: typeof d.callsBeforeRoute === 'number' ? d.callsBeforeRoute : null,
            fabricatedClaim: d.fabricatedClaim === true,
            durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
            reason: typeof result.reason === 'string' ? result.reason : '',
          };
          // A trial that never reached the model — its setup crashed, or the
          // engine never answered — says nothing about routing, so it leaves
          // the statistics rather than counting as a failure.
          if (opts.rescore && HARNESS_FAILURE_RE.test(row.reason)) row.excluded = true;
          const probeDef = probeForScenario(scenarioId);
          if (opts.rescore && probeDef) {
            row.probe = probeDef.id;
            row.category = probeDef.category;
            row.heldOut = probeDef.heldOut === true;
          }
          // Re-read every trial with a transcript, including one that hit the
          // ceiling while a consult it opened was still running.
          const verdict =
            opts.rescore && routeProbe && !row.excluded
              ? await rescoreTrial(join(root, model, arm, scenarioId, trial), scenarioId)
              : null;
          if (verdict) {
            const before = `${row.routeKind}:${row.routeTarget ?? ''}:${row.accepted}`;
            row.accepted = verdict.accepted;
            row.kindAccepted = verdict.kindAccepted;
            row.routeKind = verdict.route.kind;
            if (verdict.route.target) row.routeTarget = verdict.route.target;
            else delete row.routeTarget;
            row.callsBeforeRoute = verdict.callsBeforeRoute;
            row.fabricatedClaim = verdict.fabricatedClaim;
            row.changedByRescore =
              before !== `${row.routeKind}:${row.routeTarget ?? ''}:${row.accepted}`;
          }
          rows.push(row);
        }
      }
    }
  }
  return rows;
}

export interface ArmSummary {
  model: string;
  arm: string;
  trials: number;
  accepted: number;
  kindAccepted: number;
  /** Self probes that started work instead of answering. */
  selfOverRouted: number;
  selfTrials: number;
  /** Non-ask probes that asked. */
  askedOnClear: number;
  clearTrials: number;
  /** Exact-format probes routed correctly. */
  exactAccepted: number;
  exactTrials: number;
  fabricated: number;
  meanCallsBeforeRoute: number | null;
  medianDurationMs: number | null;
  byCategory: Record<string, { trials: number; accepted: number }>;
}

const ANSWER_KINDS = new Set(['answer', 'consult', 'status']);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeArm(rows: readonly RouteTrialRow[]): Omit<ArmSummary, 'model' | 'arm'> {
  const byCategory: ArmSummary['byCategory'] = {};
  for (const row of rows) {
    const cell = byCategory[row.category] ?? { trials: 0, accepted: 0 };
    byCategory[row.category] = cell;
    cell.trials++;
    if (row.accepted) cell.accepted++;
  }
  const self = rows.filter((r) => r.category === 'self');
  const clear = rows.filter((r) => r.category !== 'ask' && r.category !== 'end-to-end');
  const exact = rows.filter((r) => r.category === 'exact');
  const calls = rows.map((r) => r.callsBeforeRoute).filter((n): n is number => n !== null);
  return {
    trials: rows.length,
    accepted: rows.filter((r) => r.accepted).length,
    kindAccepted: rows.filter((r) => r.kindAccepted).length,
    selfOverRouted: self.filter((r) => !ANSWER_KINDS.has(r.routeKind)).length,
    selfTrials: self.length,
    askedOnClear: clear.filter((r) => r.routeKind === 'ask').length,
    clearTrials: clear.length,
    exactAccepted: exact.filter((r) => r.accepted).length,
    exactTrials: exact.length,
    fabricated: rows.filter((r) => r.fabricatedClaim).length,
    meanCallsBeforeRoute: calls.length ? calls.reduce((a, b) => a + b, 0) / calls.length : null,
    medianDurationMs: median(rows.map((r) => r.durationMs).filter((ms) => ms > 0)),
    byCategory,
  };
}

export interface PairedComparison {
  model: string;
  baseline: string;
  treatment: string;
  effect: PairedEffect;
  /** Holm-adjusted across this model's treatment arms. */
  adjustedP: number;
  /** Pairs needed to detect a 10-point gain at this delta spread (80% power). */
  pairsForTenPoints: number | null;
}

/** Paired (probe, rep) deltas of treatment over baseline on `accepted`. */
export function compareArms(
  rows: readonly RouteTrialRow[],
  model: string,
  baseline: string,
  treatment: string,
): Omit<PairedComparison, 'adjustedP'> {
  const key = (r: RouteTrialRow) => `${r.scenarioId}#${r.rep}`;
  const base = new Map(
    rows.filter((r) => r.model === model && r.arm === baseline).map((r) => [key(r), r]),
  );
  const deltas: number[] = [];
  const strata: string[] = [];
  for (const row of rows.filter((r) => r.model === model && r.arm === treatment)) {
    const paired = base.get(key(row));
    if (!paired) continue;
    deltas.push(Number(row.accepted) - Number(paired.accepted));
    strata.push(row.probe);
  }
  const effect = pairedEffect(deltas, { strata });
  const mean = effect.meanDelta;
  const sd =
    deltas.length > 1 && mean !== null
      ? Math.sqrt(deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (deltas.length - 1))
      : null;
  return {
    model,
    baseline,
    treatment,
    effect,
    pairsForTenPoints: sd !== null && sd > 0 ? pairsNeeded(sd, 0.1) : null,
  };
}

export function compareAll(
  allRows: readonly RouteTrialRow[],
  baseline: string,
): PairedComparison[] {
  const rows = allRows.filter((r) => !r.excluded);
  const out: PairedComparison[] = [];
  for (const model of [...new Set(rows.map((r) => r.model))]) {
    const treatments = [...new Set(rows.filter((r) => r.model === model).map((r) => r.arm))].filter(
      (arm) => arm !== baseline,
    );
    const raw = treatments.map((arm) => compareArms(rows, model, baseline, arm));
    const adjusted = holm(raw.map((c) => c.effect.signTestP));
    raw.forEach((c, i) => out.push({ ...c, adjustedP: adjusted[i] ?? 1 }));
  }
  return out;
}

export function summarizeAll(rows: readonly RouteTrialRow[]): ArmSummary[] {
  const out: ArmSummary[] = [];
  const cells = new Map<string, RouteTrialRow[]>();
  for (const row of rows) {
    if (row.excluded) continue;
    const k = `${row.model}\u0000${row.arm}`;
    cells.set(k, [...(cells.get(k) ?? []), row]);
  }
  for (const [k, cellRows] of cells) {
    const [model, arm] = k.split('\u0000') as [string, string];
    out.push({ model, arm, ...summarizeArm(cellRows) });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm));
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

export function renderRouteReport(
  rows: readonly RouteTrialRow[],
  baseline: string,
  meta: Record<string, unknown> = {},
): string {
  const summaries = summarizeAll(rows);
  const comparisons = compareAll(rows, baseline);
  // The floors were set on the other probes; these say whether they generalize.
  const heldOutRows = rows.filter((r) => r.heldOut);
  const heldOutComparisons = heldOutRows.length > 0 ? compareAll(heldOutRows, baseline) : [];
  const categories = [...new Set(rows.filter((r) => !r.excluded).map((r) => r.category))].sort();
  const excluded = rows.filter((r) => r.excluded);
  const lines: string[] = ['# Work-routing A/B', ''];
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}:** ${String(v)}`);
  if (excluded.length > 0) {
    lines.push(
      `- **excluded:** ${excluded.length} trial(s) that never reached the model (${[...new Set(excluded.map((r) => `${r.model} ${r.scenarioId}`))].join(', ')})`,
    );
  }
  lines.push('');
  for (const model of [...new Set(summaries.map((s) => s.model))]) {
    lines.push(`## ${model}`, '');
    lines.push(
      '| arm | route correct | kind correct | self over-routed | asked when clear | exact | fabricated | calls before route | median s |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    const modelArms = summaries.filter((x) => x.model === model);
    for (const s of modelArms) {
      lines.push(
        `| ${s.arm} | ${s.accepted}/${s.trials} (${pct(s.accepted, s.trials)}) | ${pct(s.kindAccepted, s.trials)} | ${s.selfOverRouted}/${s.selfTrials} | ${s.askedOnClear}/${s.clearTrials} | ${s.exactAccepted}/${s.exactTrials} | ${s.fabricated} | ${s.meanCallsBeforeRoute?.toFixed(2) ?? '—'} | ${s.medianDurationMs !== null ? Math.round(s.medianDurationMs / 1000) : '—'} |`,
      );
    }
    lines.push('', `| category | ${modelArms.map((s) => s.arm).join(' | ')} |`);
    lines.push(`|---|${modelArms.map(() => '---').join('|')}|`);
    for (const category of categories) {
      const cells = modelArms.map((s) => {
        const c = s.byCategory[category];
        return c ? `${c.accepted}/${c.trials}` : '—';
      });
      lines.push(`| ${category} | ${cells.join(' | ')} |`);
    }
    lines.push('');
    const comparisonLine = (c: PairedComparison, label: string) => {
      const e = c.effect;
      const ci = e.bootstrap
        ? `[${(e.bootstrap.low * 100).toFixed(0)}, ${(e.bootstrap.high * 100).toFixed(0)}]`
        : '—';
      return `- **${c.treatment} vs ${c.baseline}${label}:** Δ ${e.meanDelta !== null ? `${(e.meanDelta * 100).toFixed(1)} pts` : '—'} over ${e.n} pairs (bootstrap by probe ${ci}); ${e.wins} better / ${e.losses} worse; McNemar p=${e.signTestP.toFixed(3)}, Holm p=${c.adjustedP.toFixed(3)}${c.pairsForTenPoints !== null ? `; ~${c.pairsForTenPoints} pairs resolve a 10-point gain` : ''}`;
    };
    for (const c of comparisons.filter((x) => x.model === model)) lines.push(comparisonLine(c, ''));
    for (const c of heldOutComparisons.filter((x) => x.model === model)) {
      lines.push(comparisonLine(c, ' (held-out probes only)'));
    }
    lines.push('');
  }
  lines.push(
    'Decision rule (set before the runs): a treatment advances only with route correct ≥ +10 points on one model and no worse than −3 on the other, and no rise in self over-routing, exact-format misses, or fabricated claims.',
  );
  return `${lines.join('\n')}\n`;
}
