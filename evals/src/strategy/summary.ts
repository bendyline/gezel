import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { holm, mcnemarExact, meanOf, quantile, seededRandom } from '../ab-stats.ts';
import { CONTROL_ARM, STRATEGY_BOOK_CLASSES } from './books.ts';
import { type ContractGrade, gradeContract } from './contract-grade.ts';
import { type JudgeReport, isCurrentJudgeReport } from './judge.ts';

/**
 * One strategy-benchmark trial, read back from its directory and graded.
 *
 * Two measures, as pre-registered (docs/task-strategies.md §6):
 *  - P1 (binary): the test's result checks passed with the task finished, and
 *    every acceptance criterion of the contract passed.
 *  - P2 (continuous): the share of checked items that passed, over the
 *    contract's checked criteria and the test's result checks together. The
 *    test's checks carry what a contract cannot state generically (a code
 *    book's hidden oracle tests); the contract carries what a test did not
 *    think to check (grounding).
 */
export interface StrategyTrialRow {
  modelId: string;
  craftbookId: string;
  bookClass: string;
  arm: string;
  trialId: string;
  trialDir: string;
  testPass: boolean;
  testScore: number | null;
  testMax: number | null;
  contract: ContractGrade | null;
  p1: boolean;
  p2: number | null;
  /** P3: the judge's mean score, when the trial was judged. */
  p3: number | null;
  durationMs: number;
  failureMode?: string;
  failureClass?: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface FactsShape {
  sniff?: {
    latest?: { score?: number; scoreMax?: number } | null;
    progression?: Array<{ score?: number; scoreMax?: number }>;
  };
  perf?: { usage?: { totalInputTokens?: number; totalOutputTokens?: number } };
}

/** Grade one trial directory, writing `contract-grade.json` beside it. */
export async function gradeTrial(
  trialDir: string,
  meta: { modelId: string; craftbookId: string; arm: string },
): Promise<StrategyTrialRow | null> {
  const result = await readJson<Record<string, unknown>>(join(trialDir, 'result.json'));
  if (!result) return null;
  const facts = await readJson<FactsShape>(join(trialDir, 'facts.json'));
  const contract = await gradeContract(trialDir, meta.craftbookId).catch(() => null);
  if (contract) {
    await writeFile(join(trialDir, 'contract-grade.json'), JSON.stringify(contract, null, 2));
  }
  const last = facts?.sniff?.latest ?? facts?.sniff?.progression?.at(-1) ?? null;
  const testScore = typeof last?.score === 'number' ? last.score : null;
  const testMax = typeof last?.scoreMax === 'number' ? last.scoreMax : null;
  const testPass = result.success === true;
  const checked = (contract?.checked ?? 0) + (testMax ?? 0);
  const passed = (contract?.passed ?? 0) + (testScore ?? 0);
  const usage = facts?.perf?.usage;
  const judge = await readJson<Partial<JudgeReport>>(join(trialDir, 'judge.json'));
  return {
    ...meta,
    bookClass: STRATEGY_BOOK_CLASSES[meta.craftbookId] ?? 'other',
    trialId: String(result.trialId ?? trialDir.split('/').pop()),
    trialDir,
    testPass,
    testScore,
    testMax,
    contract,
    p1: testPass && (contract ? contract.acceptancePassed : true),
    p2: checked > 0 ? passed / checked : null,
    p3: isCurrentJudgeReport(judge) ? judge.mean : null,
    durationMs: Number(result.durationMs ?? 0),
    ...(typeof result.failureMode === 'string' ? { failureMode: result.failureMode } : {}),
    ...(typeof result.failureClass === 'string' ? { failureClass: result.failureClass } : {}),
    ...(typeof usage?.totalInputTokens === 'number' ? { inputTokens: usage.totalInputTokens } : {}),
    ...(typeof usage?.totalOutputTokens === 'number'
      ? { outputTokens: usage.totalOutputTokens }
      : {}),
  };
}

/** Every trial under `<armDir>/<scenarioId>/<trialId>/`. */
export async function gradeArmScenario(
  armDir: string,
  scenarioId: string,
  meta: { modelId: string; craftbookId: string; arm: string },
): Promise<StrategyTrialRow[]> {
  let entries: string[];
  try {
    entries = await readdir(join(armDir, scenarioId));
  } catch {
    return [];
  }
  const rows: StrategyTrialRow[] = [];
  for (const name of entries.sort()) {
    const row = await gradeTrial(join(armDir, scenarioId, name), meta);
    if (row) rows.push(row);
  }
  return rows;
}

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/**
 * Percentile bootstrap that resamples whole books: trials of one book share
 * its difficulty, so resampling them one by one would overstate precision.
 */
export function clusterBootstrap<T>(
  rows: readonly T[],
  cluster: (row: T) => string,
  stat: (sample: readonly T[]) => number | null,
  opts: { iterations?: number; seed?: number } = {},
): Interval | null {
  const estimate = stat(rows);
  if (estimate === null) return null;
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = cluster(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const keys = [...groups.keys()];
  const random = seededRandom(opts.seed ?? 20_261_022);
  const draws: number[] = [];
  for (let i = 0; i < (opts.iterations ?? 10_000); i++) {
    const sample: T[] = [];
    for (let k = 0; k < keys.length; k++) {
      sample.push(...groups.get(keys[Math.floor(random() * keys.length)]!)!);
    }
    const value = stat(sample);
    if (value !== null) draws.push(value);
  }
  if (draws.length === 0) return { estimate, low: estimate, high: estimate };
  draws.sort((a, b) => a - b);
  return { estimate, low: quantile(draws, 0.025), high: quantile(draws, 0.975) };
}

export interface ArmComparison {
  modelId: string;
  arm: string;
  pairs: number;
  /** P2: mean paired delta (arm − stepwise), with a cluster bootstrap over books. */
  p2Delta: Interval | null;
  /** P3: the same for the judge's score, over the pairs both judged. */
  p3Delta: Interval | null;
  /** P1: discordant pairs and the exact McNemar p, Holm-adjusted within the model. */
  p1: { armOnly: number; controlOnly: number; p: number; pHolm: number };
  /** Median of the per-pair wall-time ratio (arm / stepwise). */
  wallRatio: number | null;
  /** Failure modes seen in at least two arm trials and no control trial. */
  newFailureModes: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

/**
 * Pair each arm's trials with the control's on the same model and book, by
 * replicate order, and compare.
 */
export function compareArms(rows: readonly StrategyTrialRow[], arms: readonly string[]) {
  const out: ArmComparison[] = [];
  const models = [...new Set(rows.map((r) => r.modelId))];
  for (const modelId of models) {
    const forModel = rows.filter((r) => r.modelId === modelId);
    const comparisons: ArmComparison[] = [];
    for (const arm of arms) {
      if (arm === CONTROL_ARM) continue;
      const pairs: Array<{ book: string; x: StrategyTrialRow; c: StrategyTrialRow }> = [];
      for (const book of new Set(forModel.map((r) => r.craftbookId))) {
        const xs = forModel.filter((r) => r.craftbookId === book && r.arm === arm);
        const cs = forModel.filter((r) => r.craftbookId === book && r.arm === CONTROL_ARM);
        for (let i = 0; i < Math.min(xs.length, cs.length); i++) {
          pairs.push({ book, x: xs[i]!, c: cs[i]! });
        }
      }
      const scored = pairs.filter((p) => p.x.p2 !== null && p.c.p2 !== null);
      const armOnly = pairs.filter((p) => p.x.p1 && !p.c.p1).length;
      const controlOnly = pairs.filter((p) => !p.x.p1 && p.c.p1).length;
      const ratios = pairs
        .filter((p) => p.c.durationMs > 0)
        .map((p) => p.x.durationMs / p.c.durationMs);
      const modeCount = (side: 'x' | 'c', mode: string) =>
        pairs.filter((p) => p[side].failureMode === mode && !p[side].p1).length;
      const modes = new Set(pairs.flatMap((p) => (p.x.failureMode ? [p.x.failureMode] : [])));
      comparisons.push({
        modelId,
        arm,
        pairs: pairs.length,
        p2Delta: clusterBootstrap(
          scored,
          (p) => p.book,
          (sample) => meanOf(sample.map((p) => p.x.p2! - p.c.p2!)),
        ),
        p3Delta: clusterBootstrap(
          pairs.filter((p) => p.x.p3 !== null && p.c.p3 !== null),
          (p) => p.book,
          (sample) => meanOf(sample.map((p) => p.x.p3! - p.c.p3!)),
        ),
        p1: { armOnly, controlOnly, p: mcnemarExact(armOnly, controlOnly), pHolm: 1 },
        wallRatio: median(ratios),
        newFailureModes: [...modes].filter(
          (mode) => modeCount('x', mode) >= 2 && modeCount('c', mode) === 0,
        ),
      });
    }
    const adjusted = holm(comparisons.map((c) => c.p1.p));
    comparisons.forEach((c, i) => {
      c.p1.pHolm = adjusted[i]!;
    });
    out.push(...comparisons);
  }
  return out;
}

function pct(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(0)}%`;
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(3)}`;
}

export function renderStrategyMarkdown(
  rows: readonly StrategyTrialRow[],
  comparisons: readonly ArmComparison[],
  meta: Record<string, unknown>,
  arms: readonly string[],
): string {
  const lines = ['# Task-strategy benchmark', ''];
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}:** ${String(v)}`);
  lines.push('');
  // A task that ran without its contract was judged on the test alone, and
  // every arm's gates differ from the design: the comparison is void for it.
  // A finished task's gates approved, so every gate criterion of its
  // contract should pass post hoc. Disagreement means the grader and the
  // runtime read the contract differently (the pilot requires >= 95%).
  const finished = rows.flatMap((r) =>
    r.contract?.status === 'complete'
      ? r.contract.criteria.filter((c) => c.enforce === 'gate' && c.pass !== null)
      : [],
  );
  if (finished.length > 0) {
    const agree = finished.filter((c) => c.pass === true).length;
    lines.push(
      `- **runtime/post-hoc agreement:** ${agree}/${finished.length} gate criteria on finished tasks (${pct(agree / finished.length)})`,
      '',
    );
  }
  const uncontracted = rows.filter((r) => r.contract === null);
  if (uncontracted.length > 0) {
    lines.push(
      `> **Warning:** ${uncontracted.length} trial(s) ran without a contract on their task: ${uncontracted.map((r) => `${r.arm}/${r.craftbookId}`).join(', ')}. Check that the daemon read the gilde data with contracts.`,
      '',
    );
  }
  for (const modelId of [...new Set(rows.map((r) => r.modelId))]) {
    lines.push(`## ${modelId}`, '');
    lines.push(`| Book | ${arms.join(' | ')} |`);
    lines.push(`|---|${arms.map(() => '---').join('|')}|`);
    for (const book of [...new Set(rows.map((r) => r.craftbookId))]) {
      const cells = arms.map((arm) => {
        const trials = rows.filter(
          (r) => r.modelId === modelId && r.craftbookId === book && r.arm === arm,
        );
        if (trials.length === 0) return '—';
        const p1 = trials.filter((r) => r.p1).length;
        const p2 = meanOf(trials.map((r) => r.p2));
        const wall = median(trials.map((r) => r.durationMs));
        return `${p1}/${trials.length} · ${pct(p2)} · ${wall === null ? '—' : `${Math.round(wall / 60_000)}m`}`;
      });
      lines.push(`| ${book} | ${cells.join(' | ')} |`);
    }
    lines.push('', 'Cells: P1 passes / trials · mean P2 · median wall time.', '');
    for (const c of comparisons.filter((x) => x.modelId === modelId)) {
      const interval = (d: Interval | null) =>
        d ? `${signed(d.estimate)} [${signed(d.low)}, ${signed(d.high)}]` : '—';
      lines.push(
        `- **${c.arm} − ${CONTROL_ARM}** (${c.pairs} pairs): P2 ${interval(c.p2Delta)}; P3 ${interval(c.p3Delta)}; P1 discordant ${c.p1.armOnly}/${c.p1.controlOnly} (McNemar p=${c.p1.p.toFixed(3)}, Holm ${c.p1.pHolm.toFixed(3)}); wall ×${c.wallRatio === null ? '—' : c.wallRatio.toFixed(2)}${c.newFailureModes.length > 0 ? `; new failure modes: ${c.newFailureModes.join(', ')}` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Per-class figures are descriptive. The decision rule (docs/task-strategies.md §6) reads the P2 interval, the pooled P1 discordance, the wall ratio and new failure modes together.',
  );
  return `${lines.join('\n')}\n`;
}
