import type { TrialResult } from '../types.ts';
import type { CampaignCell } from './plan.ts';

export interface CampaignRow {
  cell: CampaignCell;
  result: TrialResult;
  comparisonIssue?: string;
}

export function outcome(result: TrialResult) {
  const q = result.qualification;
  const evidenceIssues = q?.issues.filter(
    (issue) =>
      !issue.startsWith('assisted diagnostic;') &&
      issue !== 'artifact checks did not pass' &&
      issue !== 'turn/task lifecycle did not complete',
  ) ?? ['qualification evidence missing'];
  return {
    artifact: q?.artifactSuccess === true,
    lifecycle: q?.lifecycle?.status ?? 'unobserved',
    complete:
      !!q?.artifactSuccess && q.lifecycle?.status === 'complete' && evidenceIssues.length === 0,
    qualified: q?.passed === true,
    evidenceIssues,
  };
}

/** Account, protocol and measurement failures stop spend; task failures remain observations. */
export function campaignStopReason(row: CampaignRow): string | undefined {
  const q = row.result.qualification;
  const o = outcome(row.result);
  if (['infra', 'grader', 'operator'].includes(row.result.failureClass ?? ''))
    return `${row.result.failureClass}: ${row.result.reason}`;
  if (o.evidenceIssues.length) return o.evidenceIssues.join('; ');
  if ((q?.api.failures ?? 0) + (q?.api.incomplete ?? 0) > 0)
    return 'API failure or incomplete response';
  if (row.cell.repairPolicy === 'runtime' && q?.independence !== 'observed')
    return 'runtime arm lacks independent API provenance';
  return undefined;
}

export function campaignReport(
  cells: CampaignCell[],
  rows: CampaignRow[],
  stopped?: string,
): string {
  const lines = [
    '# API harness campaign',
    '',
    `${rows.length}/${cells.length} trials recorded. Counts describe this sample, not established reliability.`,
    '',
    'Runtime is the primary product result. Harness is an assisted diagnostic; its qualification flag is expected to be false.',
    '',
    '| Provider/model | Scenario | Policy | Trials | Artifact pass | Lifecycle complete | Both + valid evidence | Independent qualification | Evaluator repairs |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  const groups = new Map<string, CampaignRow[]>();
  if (stopped) lines.splice(4, 0, `Campaign stopped: ${stopped}`, '');
  for (const row of rows) {
    const key = `${row.cell.provider}/${row.cell.model} | ${row.cell.scenario} | ${row.cell.repairPolicy}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of groups) {
    const count = (predicate: (r: CampaignRow) => boolean) => group.filter(predicate).length;
    lines.push(
      `| ${key} | ${group.length} | ${count((r) => outcome(r.result).artifact)} | ${count((r) => outcome(r.result).lifecycle === 'complete')} | ${count((r) => !r.comparisonIssue && outcome(r.result).complete)} | ${count((r) => outcome(r.result).qualified)} | ${group.reduce((n, r) => n + (r.result.qualification?.interventions.delivered ?? 0), 0)} |`,
    );
  }
  lines.push(
    '',
    '## Paired outcomes',
    '',
    '| Provider | Scenario | Pairs | Both complete | Runtime only | Harness only | Neither | Pairs with evaluator repairs |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const cell of cells.filter((c) => c.repetition === 1 && c.repairPolicy === 'runtime')) {
    const matching = rows.filter(
      (r) =>
        !r.comparisonIssue &&
        r.cell.provider === cell.provider &&
        r.cell.scenario === cell.scenario,
    );
    const pairs = matching
      .filter((r) => r.cell.repairPolicy === 'runtime')
      .flatMap((runtime) => {
        const harness = matching.find(
          (r) => r.cell.repairPolicy === 'harness' && r.cell.repetition === runtime.cell.repetition,
        );
        return harness ? [{ runtime, harness }] : [];
      });
    const n = (a: boolean, b: boolean) =>
      pairs.filter(
        (p) => outcome(p.runtime.result).complete === a && outcome(p.harness.result).complete === b,
      ).length;
    lines.push(
      `| ${cell.provider} | ${cell.scenario} | ${pairs.length} | ${n(true, true)} | ${n(true, false)} | ${n(false, true)} | ${n(false, false)} | ${pairs.filter((p) => (p.harness.result.qualification?.interventions.delivered ?? 0) > 0).length} |`,
    );
  }
  lines.push(
    '',
    'A pair without evaluator repairs does not demonstrate their benefit or interference.',
    '',
    '## Individual trials',
    '',
    '| Cell | Outcome | Duration | Failure class | Evidence |',
    '|---|---|---:|---|---|',
  );
  for (const row of rows) {
    lines.push(
      `| ${row.cell.id} | ${row.comparisonIssue ? 'invalid comparison' : outcome(row.result).complete ? 'complete' : 'incomplete'} | ${(row.result.durationMs / 1000).toFixed(1)}s | ${row.result.failureClass ?? 'none'} | [result](${row.result.runDir}/result.json) |`,
    );
  }
  lines.push(
    '',
    'Native token counters, API errors, prepared runtime interventions, and reasons remain in summary.json and each trial. Provider-native input/cache counts have different meanings; no cross-provider token sum or estimated dollar cost is implied.',
    '',
  );
  return lines.join('\n');
}
