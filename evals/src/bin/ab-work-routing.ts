import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { defaultProvider } from '../providers.ts';
import { slugifyForDirName } from '../runner.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { getSuite } from '../suites.ts';
import type { BatchOptions, EvalScenario } from '../types.ts';
import {
  compareAll,
  readRouteRows,
  renderRouteReport,
  summarizeAll,
} from '../work-routing/analyze.ts';
import {
  assertKnownFlags,
  parseArgs,
  parseDuration,
  printScenarios,
  resolveProviderFlag,
} from './args.ts';

/**
 * The suggest_work / start_work A/B: the `work-routing` route probes under
 * each arm, per model, interleaved per probe so machine drift lands on every
 * arm of a probe instead of on one whole arm.
 *
 *   pnpm eval:ab-work-routing --model gemma4-e4b-q4,qwen3.5-9b-q4 --count 3
 *   pnpm eval:ab-work-routing --arms baseline,work-routing --scenarios route-trip,route-advice
 *   pnpm eval:ab-work-routing --analyze evals/runs/ab-work-routing-<ts>
 *   pnpm eval:ab-work-routing --arms work-options-prelude,no-guidance,ordinal-ids,top-one \
 *     --reference work-options-prelude
 *   pnpm eval:ab-work-routing --arms baseline,work-options-prelude --embeddings \
 *     --scenarios first-project-trip,first-project-trip-paraphrase --timeout 40m
 *
 * Arms are behavior flags only — the same daemon, probes and grader:
 *   baseline              today's routing surface
 *   work-routing          tools.work-routing (suggest_work → start_work)
 *   work-options-prelude  + prompt.work-options-prelude (the list arrives with the message)
 *
 * Layout: `<root>/<model>/<arm>/<scenario>/<trial>/`; the read-out lands in
 * `ab-summary.md` / `ab-summary.json` beside them.
 */

export const WORK_ROUTING_ARMS = {
  baseline: [],
  'work-routing': ['tools.work-routing'],
  'work-options-prelude': ['tools.work-routing', 'prompt.work-options-prelude'],
  // Stage-2 ablations of the pre-ranked note; pair them with
  // `--reference work-options-prelude`.
  'no-guidance': [
    'tools.work-routing',
    'prompt.work-options-prelude',
    'prompt.work-options-no-guidance',
  ],
  'ordinal-ids': [
    'tools.work-routing',
    'prompt.work-options-prelude',
    'prompt.work-options-ordinal',
  ],
  'top-one': ['tools.work-routing', 'prompt.work-options-prelude', 'prompt.work-options-top-one'],
} as const satisfies Record<string, readonly string[]>;
type ArmId = keyof typeof WORK_ROUTING_ARMS;

const DEFAULT_MODELS = 'gemma4-e4b-q4,qwen3.5-9b-q4';
const BASELINE_ARM: ArmId = 'baseline';
const OWN_FLAGS = [
  'model',
  'suite',
  'scenarios',
  'arms',
  'reference',
  'embeddings',
  'count',
  'timeout',
  'runs-dir',
  'aba',
  'analyze',
  'resume',
  'rescore',
  'list',
] as const;

/** Trials in a cell that finished (wrote result.json); an interrupted one does not count. */
async function completedTrials(cellDir: string): Promise<number> {
  try {
    const entries = await readdir(cellDir, { withFileTypes: true });
    let done = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await stat(join(cellDir, entry.name, 'result.json'));
        done++;
      } catch {
        // No result: the trial never finished.
      }
    }
    return done;
  } catch {
    return 0;
  }
}

export function parseWorkRoutingArms(raw: unknown, reference: ArmId = BASELINE_ARM): ArmId[] {
  if (typeof raw !== 'string') return Object.keys(WORK_ROUTING_ARMS) as ArmId[];
  const arms = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const arm of arms) {
    if (!(arm in WORK_ROUTING_ARMS)) {
      throw new Error(
        `unknown arm "${arm}" — expected ${Object.keys(WORK_ROUTING_ARMS).join(', ')}`,
      );
    }
  }
  if (!arms.includes(reference)) {
    throw new Error(
      `every run needs its reference arm "${reference}": the read-out pairs each arm against it`,
    );
  }
  return [...new Set(arms)] as ArmId[];
}

export function parseReferenceArm(raw: unknown): ArmId {
  if (raw === undefined || raw === true) return BASELINE_ARM;
  const arm = String(raw).trim();
  if (!(arm in WORK_ROUTING_ARMS)) {
    throw new Error(
      `unknown reference arm "${arm}" — expected one of ${Object.keys(WORK_ROUTING_ARMS).join(', ')}`,
    );
  }
  return arm as ArmId;
}

async function gitSha(): Promise<string> {
  try {
    const head = (await readFile(join(repoRoot(), '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12);
    return (await readFile(join(repoRoot(), '.git', head.slice(4).trim()), 'utf8'))
      .trim()
      .slice(0, 12);
  } catch {
    return 'unknown';
  }
}

/**
 * `--rescore` re-classifies every trial from its saved transcript with the
 * current classifier and writes `ab-summary.rescored.*` beside the as-run
 * summary, which stays as it was.
 */
async function writeReport(
  root: string,
  meta: Record<string, unknown>,
  opts: { rescore?: boolean; reference?: ArmId } = {},
): Promise<void> {
  const reference = opts.reference ?? BASELINE_ARM;
  const rows = await readRouteRows(root, opts);
  const changed = rows.filter((row) => row.changedByRescore).length;
  const fullMeta = opts.rescore
    ? { ...meta, rescored: `${changed} of ${rows.length} trials changed route or verdict` }
    : meta;
  const markdown = renderRouteReport(rows, reference, fullMeta);
  const stem = opts.rescore ? 'ab-summary.rescored' : 'ab-summary';
  await writeFile(
    join(root, `${stem}.json`),
    JSON.stringify(
      {
        meta: fullMeta,
        arms: summarizeAll(rows),
        comparisons: compareAll(rows, reference),
        rows,
      },
      null,
      2,
    ),
  );
  await writeFile(join(root, `${stem}.md`), markdown);
  console.log(`\n${markdown}`);
  console.log(`[ab-work-routing] summary: ${join(root, `${stem}.md`)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, [...OWN_FLAGS]);
  const reference = parseReferenceArm(args.flags.reference);
  if (typeof args.flags.analyze === 'string') {
    const root = isAbsolute(args.flags.analyze)
      ? args.flags.analyze
      : join(repoRoot(), args.flags.analyze);
    await writeReport(
      root,
      { root, reanalyzedAt: new Date().toISOString() },
      { rescore: args.flags.rescore === true, reference },
    );
    return;
  }
  const scenarioIds =
    typeof args.flags.scenarios === 'string'
      ? args.flags.scenarios
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [
          ...getSuite(typeof args.flags.suite === 'string' ? args.flags.suite : 'work-routing')
            .scenarios,
        ];
  const scenarios: EvalScenario[] = scenarioIds.map((id) => {
    const scenario = SCENARIOS[id];
    if (!scenario) throw new Error(`unknown scenario "${id}"`);
    // Every route probe loads embeddings, as production does; --embeddings
    // gives other scenarios (whole first projects) the same footing, so
    // suggest_work ranks them by meaning in both arms.
    return args.flags.embeddings === true ? { ...scenario, requiresEmbeddings: true } : scenario;
  });
  if (args.flags.list) {
    printScenarios(scenarios);
    return;
  }
  const arms = parseWorkRoutingArms(args.flags.arms, reference);
  const models = String(args.flags.model || DEFAULT_MODELS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const engine = resolveProviderFlag(args.flags) ?? defaultProvider();
  const count = args.flags.count ? Number(args.flags.count) : 3;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-work-routing-${ts}`);
  await mkdir(root, { recursive: true });
  const meta: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    models: models.join(', '),
    engine,
    arms: arms
      .map((arm) => `${arm} [${WORK_ROUTING_ARMS[arm].join(', ') || 'no flags'}]`)
      .join('; '),
    probes: scenarios.length,
    count,
    gildeDataDir: gildeDataDir(),
    gitSha: await gitSha(),
    host: `${hostname()} ${platform()}/${arch()}`,
    root,
  };
  console.log(
    `[ab-work-routing] ${Object.entries(meta)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ')}`,
  );

  const ac = new AbortController();
  let interrupted = false;
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error(
      `\n[ab-work-routing] ${sig} received — finishing the current trial (again to force-exit)`,
    );
    ac.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const armDir = (modelId: string, arm: string) => join(root, slugifyForDirName(modelId), arm);
  const options = (modelId: string, arm: ArmId, dir: string): BatchOptions => ({
    modelId,
    engine,
    count,
    countStrict: true,
    timeoutMs,
    signal: ac.signal,
    runsDir: dir,
    repairPolicy: 'runtime',
    ...(WORK_ROUTING_ARMS[arm].length > 0 ? { forceBehaviors: [...WORK_ROUTING_ARMS[arm]] } : {}),
  });

  // --resume tops each cell up to --count from the trials already on disk, so
  // an interrupted run continues in the same root without re-running cells.
  const resume = args.flags.resume === true;
  const runCell = async (
    modelId: string,
    scenario: EvalScenario,
    arm: ArmId,
    dir: string,
    label: string,
  ): Promise<void> => {
    const done = resume ? await completedTrials(join(dir, scenario.id)) : 0;
    const remaining = count - done;
    if (remaining <= 0) {
      console.log(
        `[ab-work-routing] ${modelId} / ${scenario.id} / ${label}: ${done} done, skipping`,
      );
      return;
    }
    console.log(
      `\n[ab-work-routing] ===== ${modelId} / ${scenario.id} / ${label}${done > 0 ? ` (resuming: ${done} done, ${remaining} to go)` : ''} =====`,
    );
    await runMatrix([scenario], { ...options(modelId, arm, dir), count: remaining });
  };

  try {
    for (const modelId of models) {
      for (const scenario of scenarios) {
        for (const arm of arms) {
          if (ac.signal.aborted) break;
          await runCell(modelId, scenario, arm, armDir(modelId, arm), arm);
        }
      }
      // A/B/A: the reference arm again on the first probe, so drift between
      // the first and last cell shows as reference-vs-reference, not as an
      // effect.
      if (args.flags.aba === true && !ac.signal.aborted && scenarios[0]) {
        await runCell(
          modelId,
          scenarios[0],
          reference,
          armDir(modelId, `${reference}-aba`),
          `${reference} (A/B/A)`,
        );
      }
    }
  } finally {
    deviceLock?.release();
  }
  meta.finishedAt = new Date().toISOString();
  meta.status = ac.signal.aborted ? 'interrupted' : 'complete';
  await writeReport(root, meta, { reference });
}

const invokedDirectly =
  process.argv[1] !== undefined && /ab-work-routing\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
