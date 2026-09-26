import { createHash } from 'node:crypto';
import type { RetrievalTraceSurface } from '@bendyline/gezel';
import type { Interval } from '../ab-stats.ts';
import { quantile } from '../ab-stats.ts';
import type { SeedReport } from '../retrieval-corpora/seed.ts';
import type { BenchQuery } from './corpus/queries.ts';
import type { DriveResult } from './drive.ts';
import {
  type JudgedRow,
  type SurfaceSummary,
  injectedAnything,
  setPrecision,
  strictRecallAtK,
  summarizeSurface,
} from './metrics.ts';
import { pairedDelta } from './sweep.ts';

export const LATENCY_GATES_MS = { turn: 250, search: 750 } as const;
export const REFERENCE_TIMEOUT_GATE = 0.02;

export interface BenchReport {
  generatedAt: string;
  arm: string;
  mode: string;
  embedModel: string;
  /** Fingerprint of the frozen labels; a change means results are not comparable. */
  labelsHash: string;
  seed: SeedReport;
  queries: number;
  summaries: Record<'all' | 'dev' | 'test', SurfaceSummary[]>;
  /** Per query class on the turn surface: coverage or false-injection rate. */
  turnByClass: Array<{ class: string; rows: number; injectedRate: number }>;
  gates: Array<{ name: string; value: number; limit: number; ok: boolean }>;
  unstable: string[];
  errors: string[];
}

export function labelsHash(queries: readonly BenchQuery[]): string {
  const frozen = queries.map((q) => [q.id, q.expect, q.labels, q.decoys]);
  return createHash('sha256').update(JSON.stringify(frozen)).digest('hex').slice(0, 16);
}

export function buildBenchReport(args: {
  arm: string;
  mode: string;
  seed: SeedReport;
  queries: readonly BenchQuery[];
  drive: DriveResult;
  iterations?: number;
}): BenchReport {
  const surfaces: RetrievalTraceSurface[] = ['turn', 'references', 'search'];
  const summarize = (rows: readonly JudgedRow[]) =>
    surfaces
      .map((surface) => {
        const forSurface = rows.filter((row) => row.surface === surface);
        return forSurface.length === 0
          ? null
          : summarizeSurface(surface, forSurface, { iterations: args.iterations ?? 10_000 });
      })
      .filter((summary): summary is SurfaceSummary => summary !== null);
  const turnRows = args.drive.rows.filter((row) => row.surface === 'turn');
  const classes = [...new Set(turnRows.map((row) => row.class))];
  const warmP95 = (surface: string) => {
    const values = [...(args.drive.latencies[surface] ?? [])].sort((a, b) => a - b);
    return values.length === 0 ? 0 : quantile(values, 0.95);
  };
  const referenceRows = args.drive.rows.filter((row) => row.surface === 'references');
  const referenceTimeouts =
    referenceRows.length === 0
      ? 0
      : referenceRows.filter((row) => row.timedOut).length / referenceRows.length;
  return {
    generatedAt: new Date().toISOString(),
    arm: args.arm,
    mode: args.mode,
    embedModel: args.seed.embedModel,
    labelsHash: labelsHash(args.queries),
    seed: args.seed,
    queries: args.queries.length,
    summaries: {
      all: summarize(args.drive.rows),
      dev: summarize(args.drive.rows.filter((row) => row.split === 'dev')),
      test: summarize(args.drive.rows.filter((row) => row.split === 'test')),
    },
    turnByClass: classes.map((queryClass) => {
      const rows = turnRows.filter((row) => row.class === queryClass);
      return {
        class: queryClass,
        rows: rows.length,
        injectedRate: rows.filter((row) => row.kept.length > 0).length / rows.length,
      };
    }),
    gates: [
      {
        name: 'turn p95 ms (warm)',
        value: warmP95('turn'),
        limit: LATENCY_GATES_MS.turn,
        ok: warmP95('turn') <= LATENCY_GATES_MS.turn,
      },
      {
        name: 'search p95 ms (warm)',
        value: warmP95('search'),
        limit: LATENCY_GATES_MS.search,
        ok: warmP95('search') <= LATENCY_GATES_MS.search,
      },
      {
        name: 'references budget-miss rate',
        value: referenceTimeouts,
        limit: REFERENCE_TIMEOUT_GATE,
        ok: referenceTimeouts <= REFERENCE_TIMEOUT_GATE,
      },
    ],
    unstable: args.drive.unstable,
    errors: args.drive.errors,
  };
}

export function renderBenchMarkdown(report: BenchReport): string {
  const lines: string[] = [
    `# Retrieval bench — ${report.arm}`,
    '',
    `Generated ${report.generatedAt} · mode ${report.mode} · embedder ${report.embedModel} · labels ${report.labelsHash} · ${report.queries} queries`,
    '',
    `Corpus: ${report.seed.knowledgeDocs} catalog documents, ${report.seed.sharedDocs} shared, ${report.seed.workspaceFiles} workspace; unembedded at start: project ${report.seed.embedPending.project}, shared ${report.seed.embedPending.shared}.`,
    '',
  ];
  for (const split of ['all', 'dev', 'test'] as const) {
    lines.push(`## ${split === 'all' ? 'All queries' : `${split} split`}`, '');
    lines.push(
      '| surface | rows | nDCG@5 | MRR | strict R@5 | set precision | false injection (strict) | false injection (lenient) | abstention bal. acc. | decoy items | tokens/relevant hit | p50 / p95 ms |',
      '|---|---:|---|---|---|---|---|---|---:|---:|---:|---|',
    );
    for (const s of report.summaries[split]) {
      lines.push(
        [
          s.surface,
          String(s.rows),
          ci(s.ndcg5),
          ci(s.mrr),
          ci(s.strictRecall5),
          ci(s.setPrecision),
          ci(s.falseInjectionStrict),
          ci(s.falseInjectionLenient),
          num(s.abstentionBalancedAccuracy),
          num(s.distractorItemRate),
          s.tokensPerRelevantHit === null ? '—' : s.tokensPerRelevantHit.toFixed(0),
          `${s.latencyP50Ms.toFixed(0)} / ${s.latencyP95Ms.toFixed(0)}`,
        ]
          .join(' | ')
          .replace(/^/, '| ')
          .concat(' |'),
      );
    }
    lines.push('');
  }
  lines.push(
    '## Turn surface by query class',
    '',
    '| class | rows | kept anything |',
    '|---|---:|---:|',
  );
  for (const row of report.turnByClass) {
    lines.push(`| ${row.class} | ${row.rows} | ${(row.injectedRate * 100).toFixed(0)}% |`);
  }
  lines.push('', '## Gates', '', '| gate | value | limit | ok |', '|---|---:|---:|---|');
  for (const gate of report.gates) {
    lines.push(
      `| ${gate.name} | ${gate.value.toFixed(gate.limit < 1 ? 3 : 0)} | ${gate.limit} | ${gate.ok ? 'yes' : 'NO'} |`,
    );
  }
  if (report.unstable.length > 0) {
    lines.push('', `Unstable across warm rounds: ${report.unstable.join(', ')}`);
  }
  if (report.errors.length > 0) {
    lines.push('', '## Errors', '', ...report.errors.map((error) => `- ${error}`));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Every arm side by side, then each arm's paired difference from the
 * model-off arm on the test split — the acceptance evidence: a false-
 * injection CI that excludes 0 at a recall cost of no more than 5 points.
 */
export function renderArmComparison(
  reports: readonly BenchReport[],
  drives: ReadonlyMap<string, DriveResult>,
): string {
  const lines: string[] = [
    '# Retrieval bench — arm comparison',
    '',
    `labels ${reports[0]?.labelsHash ?? '—'} · mode ${reports[0]?.mode ?? '—'} · arms ${reports.map((r) => r.arm).join(', ')}`,
    '',
  ];
  for (const split of ['dev', 'test'] as const) {
    for (const surface of ['turn', 'references', 'search'] as const) {
      lines.push(
        `## ${surface} — ${split} split`,
        '',
        '| arm | nDCG@5 | strict R@5 | set precision | false injection (strict) | decoy items | tokens/relevant hit | p95 ms |',
        '|---|---|---|---|---|---:|---:|---:|',
      );
      for (const report of reports) {
        const s = report.summaries[split].find((summary) => summary.surface === surface);
        if (!s) continue;
        lines.push(
          `| ${report.arm} | ${ci(s.ndcg5)} | ${ci(s.strictRecall5)} | ${ci(s.setPrecision)} | ${ci(s.falseInjectionStrict)} | ${num(s.distractorItemRate)} | ${s.tokensPerRelevantHit === null ? '—' : s.tokensPerRelevantHit.toFixed(0)} | ${s.latencyP95Ms.toFixed(0)} |`,
        );
      }
      lines.push('');
    }
  }
  const off = drives.get('off');
  if (off) {
    lines.push(
      '## Paired difference from the model-off arm (test split)',
      '',
      '| arm | surface | Δ false injection | Δ strict R@5 | Δ set precision |',
      '|---|---|---|---|---|',
    );
    const testRows = (rows: readonly JudgedRow[]) => rows.filter((row) => row.split === 'test');
    for (const report of reports) {
      const drive = drives.get(report.arm);
      if (!drive || report.arm === 'off') continue;
      for (const surface of ['turn', 'references', 'search'] as const) {
        const base = testRows(off.rows).filter((row) => row.surface === surface);
        const arm = testRows(drive.rows).filter((row) => row.surface === surface);
        if (arm.length === 0) continue;
        const delta = (stat: (row: JudgedRow) => number | null) =>
          ci(pairedDelta(base, arm, stat, { iterations: 5_000 }));
        lines.push(
          `| ${report.arm} | ${surface} | ${delta((row) => (row.expect === 'abstain' ? (injectedAnything(row) ? 1 : 0) : null))} | ${delta((row) => strictRecallAtK(row, 5))} | ${delta((row) => setPrecision(row))} |`,
        );
      }
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function ci(interval: Interval | null): string {
  if (!interval) return '—';
  return `${interval.estimate.toFixed(2)} [${interval.low.toFixed(2)}, ${interval.high.toFixed(2)}]`;
}

function num(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}
