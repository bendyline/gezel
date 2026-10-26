import type { TrialTaskStrategy } from '../types.ts';

/**
 * The strategy benchmark's books and arms (docs/task-strategies.md §6). Every
 * book carries a contract in gilde and a test.json whose fixtures exercise it.
 * Classes feed only descriptive per-class estimates; the decision rule pools
 * across books.
 */
export const STRATEGY_BOOK_CLASSES: Readonly<Record<string, string>> = {
  'research-report': 'research-doc',
  'powerpoint-deck': 'research-doc',
  'corpus-synthesis': 'research-doc',
  'market-scan': 'research-doc',
  'content-accuracy-review': 'research-doc',
  'engineering-retrospective': 'research-doc',
  'bug-fix-tdd': 'code',
  'refactor-module': 'code',
  'codemod-sweep': 'code',
  'ab-test-readout': 'data',
  'cohort-analysis': 'data',
  'data-quality-audit': 'data',
  'csv-transformer': 'data',
  'alert-rules': 'ops-comms',
  runbook: 'ops-comms',
  'press-release': 'ops-comms',
  'invoice-run': 'multi-artifact',
  'html-arcade-game': 'multi-artifact',
};

export const STRATEGY_BENCHMARK_BOOKS: readonly string[] = Object.keys(STRATEGY_BOOK_CLASSES);

/** The pilot's ten: two or more per class, the short control left for the full run. */
export const STRATEGY_PILOT_BOOKS: readonly string[] = [
  'research-report',
  'powerpoint-deck',
  'content-accuracy-review',
  'bug-fix-tdd',
  'codemod-sweep',
  'ab-test-readout',
  'data-quality-audit',
  'alert-rules',
  'invoice-run',
  'html-arcade-game',
];

export const STRATEGY_ARMS: Readonly<Record<string, TrialTaskStrategy>> = {
  stepwise: { arm: 'stepwise', strategy: 'stepwise' },
  generalist: { arm: 'generalist', strategy: 'generalist' },
  outcome: { arm: 'outcome', strategy: 'outcome' },
  'outcome-solo': { arm: 'outcome-solo', strategy: 'outcome', options: { subagents: false } },
  'outcome-bare': { arm: 'outcome-bare', strategy: 'outcome', options: { procedure: 'none' } },
};

export const DEFAULT_STRATEGY_ARMS: readonly string[] = ['stepwise', 'generalist', 'outcome'];

/** The control every other arm is compared with. */
export const CONTROL_ARM = 'stepwise';

export function parseStrategyArms(raw: unknown): TrialTaskStrategy[] {
  const ids =
    typeof raw === 'string' && raw.trim()
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [...DEFAULT_STRATEGY_ARMS];
  const out: TrialTaskStrategy[] = [];
  for (const id of ids) {
    const arm = STRATEGY_ARMS[id];
    if (!arm) {
      throw new Error(
        `unknown arm "${id}" — expected one of ${Object.keys(STRATEGY_ARMS).join(', ')}`,
      );
    }
    if (!out.some((a) => a.arm === arm.arm)) out.push(arm);
  }
  return out;
}

/**
 * The arm order for one replicate: a rotation per replicate, so no arm always
 * runs first on a warm or cold engine (a Latin square over arms when the
 * replicate count is a multiple of the arm count).
 */
export function armOrder<T>(arms: readonly T[], replicate: number): T[] {
  if (arms.length === 0) return [];
  const shift = replicate % arms.length;
  return [...arms.slice(shift), ...arms.slice(0, shift)];
}
