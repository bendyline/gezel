import type { TrialFacts } from '../bin/score-trial.ts';
import type { FixedRubricScore } from '../fixed-rubric.ts';
import type { TrialMetrics } from '../perf-collector.ts';
import type { TrialResult } from '../types.ts';
import type { Cell, Definition } from './plan.ts';

export interface Row {
  cell: Cell;
  result: TrialResult;
  score: FixedRubricScore;
  metrics: TrialMetrics;
  timing: TrialFacts['timing'];
  toolCalls: number;
  autoAnswers: number;
  modes: TrialFacts['continuity'];
  comparisonIssue?: string;
}

export interface IdentityCorrection {
  at: string;
  reason: string;
  evidence: string;
}

export function eligible(r: Row) {
  return !r.comparisonIssue && r.score.eligibility.includedInModelAggregate;
}
function numeric(values: Array<number | null | undefined>): number[] {
  return values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
}
export function median(values: Array<number | null | undefined>): number | null {
  const sorted = numeric(values).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length
    ? sorted.length % 2
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2
    : null;
}
const format = (n: number | null | undefined, digits = 1) => (n == null ? '—' : n.toFixed(digits));
const escapeCell = (s: string) => s.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
function measured(values: Array<number | null | undefined>, sum = false, digits = 1) {
  const ns = numeric(values);
  return ns.length
    ? `${format(sum ? ns.reduce((a, b) => a + b, 0) : median(ns), digits)} (${ns.length}/${values.length})`
    : '—';
}

export function comparisonReport(
  d: Definition,
  cells: Cell[],
  rows: Row[],
  stopped?: string,
  corrections: IdentityCorrection[] = [],
) {
  const lines = [
    '# Provider scorecard comparison',
    '',
    `${rows.length}/${cells.length} trials recorded. ${stopped ? `Stopped: ${escapeCell(stopped)}` : rows.length === cells.length ? 'Execution complete; advisory judging is a separate follow-up.' : 'Incomplete — no final ranking yet.'}`,
    '',
    'Three observations per scenario/configuration give a preliminary comparison, not established reliability. Aggregate rows combine different tasks; inspect scenario rows before choosing a provider.',
    '',
    ...corrections.flatMap((c) => [
      `Identity correction (${escapeCell(c.at)}): ${escapeCell(c.reason)} [Audit evidence](<${c.evidence}>).`,
      '',
    ]),
    '## Capability',
    '',
    '| Target | Recorded/planned | Eligible | Passed | Excluded | Mean fixed score /10 |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const t of d.targets) {
    const all = rows.filter((r) => r.cell.targetId === t.id);
    const valid = all.filter(eligible);
    lines.push(
      `| ${t.id} | ${all.length}/${cells.filter((c) => c.targetId === t.id).length} | ${valid.length} | ${valid.filter((r) => r.result.success).length} | ${all.length - valid.length} | ${format(valid.length ? valid.reduce((n, r) => n + r.score.composite, 0) / valid.length : null)} |`,
    );
  }
  lines.push(
    '',
    '## Performance',
    '',
    'Timing uses eligible trials; both all-outcome and successful-only medians are shown to expose fast-failure bias. Other measurements show sample coverage (observed/eligible); — means unavailable. Token and cost sums cover only measured trials and retain provider-native accounting. Reported CLI dollar estimates are not subscription invoices.',
    '',
    '| Target | Median seconds (all) | Median seconds (passes) | First tool seconds | First artifact seconds | Median tool calls | Auto-answers (sum) |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const t of d.targets) {
    const rs = rows.filter((r) => r.cell.targetId === t.id && eligible(r));
    const seconds = (v: number | null) => (v === null ? null : v / 1000);
    lines.push(
      `| ${t.id} | ${format(median(rs.map((r) => r.result.durationMs / 1000)))} | ${format(median(rs.filter((r) => r.result.success).map((r) => r.result.durationMs / 1000)))} | ${measured(rs.map((r) => seconds(r.timing.timeToFirstToolCallMs)))} | ${measured(rs.map((r) => seconds(r.timing.timeToFirstArtifactMs)))} | ${measured(rs.map((r) => r.toolCalls))} | ${measured(
        rs.map((r) => r.autoAnswers),
        true,
      )} |`,
    );
  }
  lines.push(
    '',
    '| Target | Input tokens (sum) | Output tokens (sum) | Reported USD (sum) | Decode tok/s (median) | Prefill tok/s (median) | Peak RSS MB (median) | Peak GPU % (median) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const t of d.targets) {
    const rs = rows.filter((r) => r.cell.targetId === t.id && eligible(r));
    lines.push(
      `| ${t.id} | ${measured(
        rs.map((r) => (r.metrics.usage.available ? r.metrics.usage.totalInputTokens : null)),
        true,
      )} | ${measured(
        rs.map((r) => (r.metrics.usage.available ? r.metrics.usage.totalOutputTokens : null)),
        true,
      )} | ${measured(
        rs.map((r) => (r.metrics.usage.available ? r.metrics.usage.totalCostUsd : null)),
        true,
        4,
      )} | ${measured(rs.map((r) => r.metrics.derived.genTokensPerSec))} | ${measured(rs.map((r) => r.metrics.derived.promptTokensPerSec))} | ${measured(rs.map((r) => r.metrics.derived.peakRssMb))} | ${measured(rs.map((r) => r.metrics.derived.peakGpuUtilPercent))} |`,
    );
  }
  lines.push(
    '',
    'Actual decode/prefill timings are used above. Whole-trial tokens/second are deliberately omitted. Cloud hardware is not observable; local RSS/GPU and image generation share this device. Timing includes startup and tool work; local warmup/admission probes add elapsed campaign time outside the trial. Cache details and normalized billing remain in summary.json and metrics.json.',
    '',
    '## Scenario results',
    '',
    '| Suite | Scenario | Target | Passed/eligible | Recorded/planned | Mean fixed score | Median seconds |',
    '|---|---|---|---:|---:|---:|---:|',
  );
  for (const s of d.scenarios)
    for (const t of d.targets) {
      const all = rows.filter(
        (r) => r.cell.suite === s.suite && r.cell.scenario === s.id && r.cell.targetId === t.id,
      );
      const rs = all.filter(eligible);
      lines.push(
        `| ${s.suite} | ${s.id} | ${t.id} | ${rs.filter((r) => r.result.success).length}/${rs.length} | ${all.length}/${d.count} | ${format(rs.length ? rs.reduce((n, r) => n + r.score.composite, 0) / rs.length : null)} | ${format(median(rs.map((r) => r.result.durationMs / 1000)))} |`,
      );
    }
  lines.push(
    '',
    '## Failure and exclusion evidence',
    '',
    '| Cell | Class | Reason | Evidence |',
    '|---|---|---|---|',
    ...rows
      .filter((r) => !r.result.success || !eligible(r))
      .map(
        (r) =>
          `| ${r.cell.id} | ${r.result.failureClass ?? r.score.eligibility.failureClass} | ${escapeCell(r.comparisonIssue ?? r.result.reason)} | [result](<${r.result.runDir}/result.json>) |`,
      ),
    '',
    'A standard scorecard pass is the scenario artifact/task gate. Natural lifecycle completion and independent API qualification are not measured by this campaign. Scenario repair policies and user simulation are preserved; CLI harnesses are part of the treatment. No results are merged with prior API qualification campaigns or the published dataset.',
    '',
    'Advisory judging: pending until artifact review; use declared scenario axes, separate from the fixed capability score. See plan.md for the protocol.',
    '',
  );
  return lines.join('\n');
}

export function comparisonCsv(rows: Row[]) {
  const table: unknown[][] = [
    [
      'cell',
      'provider',
      'model',
      'suite',
      'scenario',
      'repetition',
      'success',
      'eligible',
      'failureClass',
      'fixedComposite',
      'durationMs',
      'firstToolMs',
      'firstArtifactMs',
      'toolCalls',
      'autoAnswers',
      'inputTokens',
      'outputTokens',
      'reportedCostUsd',
      'decodeTokensPerSec',
      'prefillTokensPerSec',
      'peakRssMb',
      'peakGpuPercent',
      'repairPolicy',
      'runDir',
    ],
  ];
  for (const r of rows)
    table.push([
      r.cell.id,
      r.cell.provider,
      r.cell.model,
      r.cell.suite,
      r.cell.scenario,
      r.cell.repetition,
      r.result.success,
      eligible(r),
      r.result.failureClass ?? '',
      r.score.composite,
      r.result.durationMs,
      r.timing.timeToFirstToolCallMs,
      r.timing.timeToFirstArtifactMs,
      r.toolCalls,
      r.autoAnswers,
      r.metrics.usage.totalInputTokens,
      r.metrics.usage.totalOutputTokens,
      r.metrics.usage.totalCostUsd,
      r.metrics.derived.genTokensPerSec,
      r.metrics.derived.promptTokensPerSec,
      r.metrics.derived.peakRssMb,
      r.metrics.derived.peakGpuUtilPercent,
      r.result.repairPolicy ?? 'harness',
      r.result.runDir,
    ]);
  return `${table
    .map((row) => row.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n')}\n`;
}
