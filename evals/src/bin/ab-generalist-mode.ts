import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { runMatrix } from '../batch.ts';
import type { ContinuityFacts } from '../continuity-facts.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { defaultProvider } from '../providers.ts';
import { slugifyForDirName } from '../runner.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { getSuite } from '../suites.ts';
import type { BatchOptions, EvalScenario } from '../types.ts';
import {
  assertKnownFlags,
  parseArgs,
  parseDuration,
  printScenarios,
  resolveProviderFlag,
  resolveRepairPolicyFlag,
} from './args.ts';

/**
 * Generalist-mode A/B (docs/generalist-mode.md): the same scenarios under
 * `--generalist off` (stepwise: a specialist per step, a session per gezel
 * change) and `--generalist on` (one owner, one continuous session, the union
 * tool surface), per model.
 *
 *   pnpm eval:ab-generalist --suite generalist-smoke --model qwen3.8-27b-q4 --count 1 --arms off,on --aba
 *
 * Arms are interleaved PER SCENARIO by default (scenario outer, arm inner) so
 * machine drift — thermal throttling, a warm vs cold prefix cache — lands on
 * both arms of a scenario rather than on one whole arm. `auto` is refused as
 * an arm unless `--allow-auto`: for task-driven scenarios it equals `off` on
 * local models, so an `auto` arm silently measures nothing.
 *
 * Layout: `<root>/<model>/<stepwise|generalist>/<scenario>/<trial>/`. Per
 * cell the summary reads each trial's `facts.json` (`facts.continuity`) —
 * steps, sessions per step, compactions, fanout integrity, budget trips —
 * alongside pass rate and wall-clock, and records the content root, git sha
 * and host so arms are provably comparable.
 */

export type GeneralistArm = 'off' | 'on' | 'auto';
export const ARM_LABEL: Record<GeneralistArm, string> = {
  off: 'stepwise',
  on: 'generalist',
  auto: 'auto',
};
const DEFAULT_ARMS: GeneralistArm[] = ['off', 'on'];
const DEFAULT_MODELS = 'qwen3.8-27b-q4,gemma4-12b-q4';
const DEFAULT_SUITE = 'generalist-smoke';
const OWN_FLAGS = [
  'model',
  'suite',
  'scenarios',
  'arms',
  'allow-auto',
  'interleave',
  'aba',
  'count',
  'count-strict',
  'timeout',
  'runs-dir',
  'list',
  'mlx-source-home',
  'repair-policy',
] as const;

/**
 * Craftbook cells run under `--repair-policy runtime` unless told otherwise.
 * This bin compares two ways the RUNTIME executes a book; the harness's
 * repair channel (sniff nudges in plain sessions, missing-deliverable kicks,
 * Developer recruitment) is a third actor that speaks to whichever gezel it
 * scores best and bypasses the mode under test. The dry run of 2026-09-18
 * lost both invoice-run arms to that channel before the runtime had finished
 * step one. `--repair-policy harness` restores the standard craftbook-matrix
 * behaviour for a deliberate comparison with older runs.
 */
export function resolveAbRepairPolicy(
  flags: Record<string, string | boolean>,
): 'harness' | 'runtime' {
  return resolveRepairPolicyFlag(flags) ?? 'runtime';
}

export function parseArms(raw: unknown, allowAuto: boolean): GeneralistArm[] {
  if (raw === undefined || raw === true || raw === false) return DEFAULT_ARMS;
  const arms = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: GeneralistArm[] = [];
  for (const arm of arms) {
    if (arm !== 'off' && arm !== 'on' && arm !== 'auto') {
      throw new Error(`unknown arm "${arm}" — expected off, on, or auto`);
    }
    if (arm === 'auto' && !allowAuto) {
      throw new Error(
        'an `auto` arm measures nothing on local models (it resolves to `off` for every task-driven scenario); force on/off, or pass --allow-auto to run it anyway',
      );
    }
    if (!out.includes(arm)) out.push(arm);
  }
  if (out.length === 0) return DEFAULT_ARMS;
  return out;
}

export interface TrialRow {
  trialId: string;
  success: boolean;
  durationMs: number;
  failureMode?: string;
  failureClass?: string;
  failureClassRule?: string;
  continuity?: ContinuityFacts;
}

export interface CellSummary {
  modelId: string;
  arm: GeneralistArm;
  label: string;
  scenarioId: string;
  trials: number;
  successes: number;
  passRate: number;
  medianDurationMs: number | null;
  medianSteps: number | null;
  medianSessionsPerStep: number | null;
  reusedSessions: number;
  compactions: { betweenTurn: number; midTurn: number; forceFit: number; observable: boolean };
  maxContextFill: number | null;
  fanout: { spawned: number; completed: number };
  budgetHardTrips: number;
  failureClasses: Record<string, number>;
  bugWatch: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeCell(
  modelId: string,
  arm: GeneralistArm,
  scenarioId: string,
  rows: TrialRow[],
): CellSummary {
  const successes = rows.filter((r) => r.success).length;
  const cont = rows.flatMap((r) => (r.continuity ? [r.continuity] : []));
  const failureClasses: Record<string, number> = {};
  for (const r of rows) {
    if (r.success) continue;
    const key = r.failureClassRule ? `${r.failureClass ?? 'model'}/${r.failureClassRule}` : 'model';
    failureClasses[key] = (failureClasses[key] ?? 0) + 1;
  }
  const bugWatch = new Set<string>();
  for (const c of cont) {
    if (c.compaction.firstTurnPrefixOver >= 3) bugWatch.add('prefix-over-threshold');
    if (c.sessions.continuityBreaks > 0) bugWatch.add('continuity-broken');
    if (c.compaction.loopHalts > 0) bugWatch.add('compaction-loop');
    if (c.fanout.childrenSpawned > 0 && c.fanout.childrenCompleted < c.fanout.childrenSpawned) {
      bugWatch.add('fanout-incomplete');
    }
    if (c.fanout.barrierReleaseFailures > 0) bugWatch.add('fanout-barrier-failed');
    if (c.sessions.resumeFailures > 0) bugWatch.add('resume-failed');
    if (c.budget.taskBudgetHard > 0) bugWatch.add('task-budget-hard');
    if (arm === 'on' && c.resolvedModes.generalist === 0 && c.steps.activated > 0) {
      bugWatch.add('generalist-not-resolved');
    }
    if (arm === 'off' && c.resolvedModes.generalist > 0)
      bugWatch.add('stepwise-arm-ran-generalist');
  }
  const maxFill = cont.flatMap((c) =>
    c.compaction.maxContextFill === null ? [] : [c.compaction.maxContextFill],
  );
  return {
    modelId,
    arm,
    label: ARM_LABEL[arm],
    scenarioId,
    trials: rows.length,
    successes,
    passRate: rows.length > 0 ? successes / rows.length : 0,
    medianDurationMs: median(rows.map((r) => r.durationMs)),
    medianSteps: median(cont.map((c) => c.steps.activated)),
    medianSessionsPerStep: median(
      cont.flatMap((c) =>
        c.sessions.sessionsPerStep === null ? [] : [c.sessions.sessionsPerStep],
      ),
    ),
    reusedSessions: cont.reduce((n, c) => n + c.sessions.reusedAcrossSteps, 0),
    compactions: {
      betweenTurn: cont.reduce((n, c) => n + c.compaction.betweenTurn, 0),
      midTurn: cont.reduce((n, c) => n + c.compaction.midTurn, 0),
      forceFit: cont.reduce((n, c) => n + c.compaction.forceFit, 0),
      observable: cont.every((c) => c.compaction.observable),
    },
    maxContextFill: maxFill.length > 0 ? Math.max(...maxFill) : null,
    fanout: {
      spawned: cont.reduce((n, c) => n + c.fanout.childrenSpawned, 0),
      completed: cont.reduce((n, c) => n + c.fanout.childrenCompleted, 0),
    },
    budgetHardTrips: cont.reduce((n, c) => n + c.budget.taskBudgetHard, 0),
    failureClasses,
    bugWatch: [...bugWatch].sort(),
  };
}

async function readTrialRows(armDir: string, scenarioId: string): Promise<TrialRow[]> {
  const dir = join(armDir, scenarioId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const rows: TrialRow[] = [];
  for (const name of entries) {
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(await readFile(join(dir, name, 'result.json'), 'utf8'));
    } catch {
      continue;
    }
    let continuity: ContinuityFacts | undefined;
    try {
      const facts = JSON.parse(await readFile(join(dir, name, 'facts.json'), 'utf8')) as {
        continuity?: ContinuityFacts;
      };
      continuity = facts.continuity;
    } catch {
      continuity = undefined;
    }
    rows.push({
      trialId: String(result.trialId ?? name),
      success: result.success === true,
      durationMs: Number(result.durationMs ?? 0),
      ...(typeof result.failureMode === 'string' ? { failureMode: result.failureMode } : {}),
      ...(typeof result.failureClass === 'string' ? { failureClass: result.failureClass } : {}),
      ...(typeof result.failureClassRule === 'string'
        ? { failureClassRule: result.failureClassRule }
        : {}),
      ...(continuity ? { continuity } : {}),
    });
  }
  return rows;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`;
}

function fmtNum(n: number | null, digits = 1): string {
  return n === null ? '—' : n.toFixed(digits);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function renderMarkdown(
  cells: CellSummary[],
  meta: Record<string, unknown>,
  arms: GeneralistArm[],
): string {
  const lines: string[] = ['# Generalist-mode A/B', ''];
  for (const [k, v] of Object.entries(meta)) lines.push(`- **${k}:** ${String(v)}`);
  lines.push('');
  const models = [...new Set(cells.map((c) => c.modelId))];
  for (const modelId of models) {
    lines.push(`## ${modelId}`, '');
    lines.push(
      '| Scenario | Arm | Pass | Median wall | Steps | Sess/step | Reused | Compact b/m/f | Max fill | Fanout | Budget | Failure classes | Bug-watch |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const scenarios = [
      ...new Set(cells.filter((c) => c.modelId === modelId).map((c) => c.scenarioId)),
    ];
    for (const scenarioId of scenarios) {
      for (const arm of arms) {
        const cell = cells.find(
          (c) => c.modelId === modelId && c.scenarioId === scenarioId && c.arm === arm,
        );
        if (!cell) continue;
        const compact = cell.compactions.observable
          ? `${cell.compactions.betweenTurn}/${cell.compactions.midTurn}/${cell.compactions.forceFit}`
          : 'n/a';
        const fanout =
          cell.fanout.spawned > 0 ? `${cell.fanout.completed}/${cell.fanout.spawned}` : '—';
        const classes = Object.entries(cell.failureClasses)
          .map(([k, v]) => `${k}×${v}`)
          .join(', ');
        lines.push(
          `| ${scenarioId} | ${cell.label} | ${cell.successes}/${cell.trials} (${pct(cell.passRate)}) | ${fmtMs(cell.medianDurationMs)} | ${fmtNum(cell.medianSteps, 0)} | ${fmtNum(cell.medianSessionsPerStep, 2)} | ${cell.reusedSessions} | ${compact} | ${cell.maxContextFill === null ? '—' : pct(cell.maxContextFill)} | ${fanout} | ${cell.budgetHardTrips} | ${classes || '—'} | ${cell.bugWatch.join(' ') || '—'} |`,
        );
      }
    }
    lines.push('');
    for (const arm of arms) {
      const armCells = cells.filter((c) => c.modelId === modelId && c.arm === arm);
      const trials = armCells.reduce((n, c) => n + c.trials, 0);
      const successes = armCells.reduce((n, c) => n + c.successes, 0);
      lines.push(
        `- **${ARM_LABEL[arm]}:** ${successes}/${trials} (${trials > 0 ? pct(successes / trials) : '—'}) across ${armCells.length} scenario(s)`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Read-out rules: only `failureClass: model` trials speak to capability; n=1 deltas are leads, not results; compaction columns are `n/a` where the provider compacts inside its own process (CLI wrappers, Copilot).',
  );
  return `${lines.join('\n')}\n`;
}

async function gitSha(): Promise<string> {
  try {
    const head = (await readFile(join(repoRoot(), '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12);
    const ref = head.slice(4).trim();
    return (await readFile(join(repoRoot(), '.git', ref), 'utf8')).trim().slice(0, 12);
  } catch {
    return 'unknown';
  }
}

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(
        `\n[ab-generalist] ${sig} received — aborting gracefully (again to force-exit)`,
      );
      ac.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, [...OWN_FLAGS]);
  const suiteId = typeof args.flags.suite === 'string' ? args.flags.suite : DEFAULT_SUITE;
  const scenarioIds =
    typeof args.flags.scenarios === 'string'
      ? args.flags.scenarios
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [...getSuite(suiteId).scenarios];
  const scenarios: EvalScenario[] = scenarioIds.map((id) => {
    const scenario = SCENARIOS[id];
    if (!scenario) throw new Error(`unknown scenario "${id}"`);
    // `suggestedTrials` caps matrix cost; this bin is the deliberate
    // experiment, so `--count` wins.
    const { suggestedTrials: _suggestedTrials, ...rest } = scenario;
    return rest;
  });
  if (args.flags.list) {
    printScenarios(scenarios);
    return;
  }
  const arms = parseArms(args.flags.arms, args.flags['allow-auto'] === true);
  const interleave = args.flags.interleave === 'arm' ? 'arm' : 'scenario';
  const models = String(args.flags.model || DEFAULT_MODELS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const engine = resolveProviderFlag(args.flags) ?? defaultProvider();
  const count = args.flags.count ? Number(args.flags.count) : 1;
  const countStrict = args.flags['count-strict'] === true;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const repairPolicy = resolveAbRepairPolicy(args.flags);
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-generalist-${ts}`);
  await mkdir(root, { recursive: true });
  const meta: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    models: models.join(', '),
    engine,
    suite: typeof args.flags.scenarios === 'string' ? '(ad hoc)' : suiteId,
    scenarios: scenarios.map((s) => s.id).join(', '),
    arms: arms.map((a) => `${a} (${ARM_LABEL[a]})`).join(', '),
    interleave,
    count,
    countStrict,
    repairPolicy,
    gildeDataDir: gildeDataDir(),
    gitSha: await gitSha(),
    host: `${hostname()} ${platform()}/${arch()}`,
    root,
  };
  console.log(
    `[ab-generalist] ${Object.entries(meta)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ')}`,
  );

  const ac = installSignalHandlers();
  const armDir = (modelId: string, arm: GeneralistArm, suffix = '') =>
    join(root, slugifyForDirName(modelId), `${ARM_LABEL[arm]}${suffix}`);
  const baseOpts = (modelId: string, arm: GeneralistArm, dir: string): BatchOptions => ({
    modelId,
    engine,
    count,
    ...(countStrict ? { countStrict: true } : {}),
    timeoutMs,
    signal: ac.signal,
    runsDir: dir,
    generalistMode: arm,
    repairPolicy,
    ...(args.flags['mlx-source-home']
      ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
      : {}),
  });

  try {
    for (const modelId of models) {
      if (ac.signal.aborted) break;
      if (interleave === 'scenario') {
        for (const scenario of scenarios) {
          for (const arm of arms) {
            if (ac.signal.aborted) break;
            console.log(
              `\n[ab-generalist] ===== ${modelId} / ${scenario.id} / ${ARM_LABEL[arm]} =====`,
            );
            await runMatrix([scenario], baseOpts(modelId, arm, armDir(modelId, arm)));
          }
        }
      } else {
        for (const arm of arms) {
          if (ac.signal.aborted) break;
          console.log(`\n[ab-generalist] ===== ${modelId} / arm=${ARM_LABEL[arm]} =====`);
          await runMatrix(scenarios, baseOpts(modelId, arm, armDir(modelId, arm)));
        }
      }
      // A/B/A: re-run the first arm on the cheapest scenario at the end, so
      // a drift between the first and last cell of the day is visible as a
      // first-arm-vs-first-arm difference instead of masquerading as a mode effect.
      if (args.flags.aba === true && !ac.signal.aborted && scenarios[0] && arms[0]) {
        console.log(
          `\n[ab-generalist] ===== ${modelId} / ${scenarios[0].id} / ${ARM_LABEL[arms[0]]} (A/B/A re-run) =====`,
        );
        await runMatrix(
          [scenarios[0]],
          baseOpts(modelId, arms[0], armDir(modelId, arms[0], '-aba')),
        );
      }
    }
  } finally {
    deviceLock?.release();
  }

  const cells: CellSummary[] = [];
  for (const modelId of models) {
    for (const scenario of scenarios) {
      for (const arm of arms) {
        cells.push(
          summarizeCell(
            modelId,
            arm,
            scenario.id,
            await readTrialRows(armDir(modelId, arm), scenario.id),
          ),
        );
      }
    }
    if (args.flags.aba === true && scenarios[0] && arms[0]) {
      const rows = await readTrialRows(armDir(modelId, arms[0], '-aba'), scenarios[0].id);
      if (rows.length > 0) {
        const cell = summarizeCell(modelId, arms[0], scenarios[0].id, rows);
        cells.push({ ...cell, label: `${cell.label} (A/B/A)` });
      }
    }
  }
  meta.finishedAt = new Date().toISOString();
  meta.status = ac.signal.aborted ? 'interrupted' : 'complete';
  const markdown = renderMarkdown(cells, meta, arms);
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify({ meta, cells }, null, 2));
  await writeFile(join(root, 'ab-summary.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`[ab-generalist] summary: ${join(root, 'ab-summary.md')}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && /ab-generalist-mode\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
