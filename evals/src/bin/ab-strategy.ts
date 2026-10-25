import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { arch, hostname, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { runMatrix } from '../batch.ts';
import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { CRAFTBOOK_EVAL_SPECS } from '../craftbooks/specs.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { defaultProvider } from '../providers.ts';
import { slugifyForDirName } from '../runner.ts';
import {
  STRATEGY_BENCHMARK_BOOKS,
  STRATEGY_PILOT_BOOKS,
  armOrder,
  parseStrategyArms,
} from '../strategy/books.ts';
import { renderJudgeValidityMarkdown, runJudgeValidity } from '../strategy/judge-validity.ts';
import { JUDGE_MODEL, judgeTrial } from '../strategy/judge.ts';
import {
  type StrategyTrialRow,
  compareArms,
  gradeArmScenario,
  renderStrategyMarkdown,
} from '../strategy/summary.ts';
import type { EvalScenario, TrialTaskStrategy } from '../types.ts';
import { assertKnownFlags, parseArgs, parseDuration, resolveProviderFlag } from './args.ts';

/**
 * Task-strategy benchmark (docs/task-strategies.md §6): the same books under
 * each strategy arm, per model, graded against each book's contract.
 *
 *   GEZEL_GILDE_DATA_DIR=../gilde/data pnpm eval:ab-strategy --model qwen3.8-27b-q4 \
 *     --books pilot --arms stepwise,generalist,outcome,outcome-solo,outcome-bare --count 1
 *
 * Every trial runs the book as a real workflow task with the runtime's own
 * repair policy, the same worker, the product's description of the request,
 * and tier-collapse off. Arms run back to back per book and replicate, their
 * order rotated each replicate. After the run, each trial is graded from its
 * directory (`contract-grade.json`) and the arms are compared with the
 * stepwise control: P2 with a bootstrap over books, P1 with McNemar.
 *
 * `--judge` adds P3: the pinned judge (strategy/judge.ts) scores each trial's
 * blinded deliverables three times through the Claude CLI. `--judge-validity`
 * also runs the judge's pre-registered validity checks (strategy/judge-validity.ts):
 * test-retest, planted defects, and a second judge on a quarter of the trials.
 *
 * Layout: `<root>/<model>/<arm>/<scenario>/<trial>/`.
 */

const OWN_FLAGS = [
  'model',
  'books',
  'arms',
  'count',
  'timeout',
  'runs-dir',
  'list',
  'allow-no-contract',
  'grade-only',
  'judge',
  'judge-validity',
  'mlx-source-home',
] as const;

/** The latest version of a book in the gilde data the daemon will read. */
async function latestBook(dataDir: string, id: string): Promise<Record<string, unknown> | null> {
  const root = join(dataDir, 'craftbook-templates');
  for (const shard of await readdir(root).catch(() => [] as string[])) {
    const versionsDir = join(root, shard, id, 'versions');
    const versions = await readdir(versionsDir).catch(() => null);
    if (!versions?.length) continue;
    const latest = versions
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1)!;
    try {
      return JSON.parse(await readFile(join(versionsDir, latest, 'craftbook.json'), 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function resolveBooks(raw: unknown): string[] {
  if (raw === undefined || raw === 'pilot') return [...STRATEGY_PILOT_BOOKS];
  if (raw === 'benchmark' || raw === 'all') return [...STRATEGY_BENCHMARK_BOOKS];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function scenarioFor(craftbookId: string): EvalScenario {
  const spec = CRAFTBOOK_EVAL_SPECS.find((s) => s.craftbookId === craftbookId);
  if (!spec) throw new Error(`no eval spec (test.json) for craftbook "${craftbookId}"`);
  const { suggestedTrials: _suggestedTrials, ...scenario } = craftbookScenarioFromSpec({
    ...spec,
    mode: 'workflow',
    repairPolicy: 'runtime',
  });
  return scenario;
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

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(`\n[ab-strategy] ${sig} received — aborting gracefully (again to force-exit)`);
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
  const books = resolveBooks(args.flags.books);
  const arms = parseStrategyArms(args.flags.arms);
  const models = String(args.flags.model || 'qwen3.8-27b-q4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const engine = resolveProviderFlag(args.flags) ?? defaultProvider();
  const count = args.flags.count ? Number(args.flags.count) : 1;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const dataDir = gildeDataDir();

  const missing: string[] = [];
  for (const id of books) {
    const book = await latestBook(dataDir, id);
    if (!book?.contract) missing.push(id);
  }
  if (missing.length > 0 && args.flags['allow-no-contract'] !== true) {
    throw new Error(
      `no contract in ${dataDir} for: ${missing.join(', ')}. Point GEZEL_GILDE_DATA_DIR at a gilde checkout whose books carry contracts, or pass --allow-no-contract.`,
    );
  }
  const scenarios = new Map(books.map((id) => [id, scenarioFor(id)]));
  if (args.flags.list) {
    for (const [id, s] of scenarios) console.log(`${id}\t${s.id}`);
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-strategy-${ts}`);
  await mkdir(root, { recursive: true });
  const meta: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    models: models.join(', '),
    engine,
    books: books.join(', '),
    arms: arms.map((a) => a.arm).join(', '),
    replicates: count,
    timeout: timeoutMs ? `${Math.round(timeoutMs / 60_000)}m` : 'scenario default',
    gildeDataDir: dataDir,
    gitSha: await gitSha(),
    host: `${hostname()} ${platform()}/${arch()}`,
    root,
  };
  console.log(
    `[ab-strategy] ${Object.entries(meta)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ')}`,
  );
  const armDir = (modelId: string, arm: TrialTaskStrategy) =>
    join(root, slugifyForDirName(modelId), arm.arm);

  if (args.flags['grade-only'] !== true) {
    const deviceLock = acquireEvalDeviceLockIfNeeded({
      provider: engine,
      scenarios: [...scenarios.values()],
    });
    const ac = installSignalHandlers();
    try {
      for (const modelId of models) {
        for (let replicate = 0; replicate < count; replicate++) {
          for (const [bookIndex, id] of books.entries()) {
            for (const arm of armOrder(arms, replicate + bookIndex)) {
              if (ac.signal.aborted) break;
              console.log(
                `\n[ab-strategy] ===== ${modelId} / ${id} / ${arm.arm} / replicate ${replicate + 1} =====`,
              );
              await runMatrix([scenarios.get(id)!], {
                modelId,
                engine,
                count: 1,
                countStrict: true,
                ...(timeoutMs ? { timeoutMs } : {}),
                signal: ac.signal,
                runsDir: armDir(modelId, arm),
                taskStrategy: arm,
                repairPolicy: 'runtime',
                ...(args.flags['mlx-source-home']
                  ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
                  : {}),
              });
            }
          }
        }
      }
      meta.status = ac.signal.aborted ? 'interrupted' : 'complete';
    } finally {
      deviceLock?.release();
    }
  }

  const rows: StrategyTrialRow[] = [];
  for (const modelId of models) {
    for (const [id, scenario] of scenarios) {
      for (const arm of arms) {
        rows.push(
          ...(await gradeArmScenario(armDir(modelId, arm), scenario.id, {
            modelId,
            craftbookId: id,
            arm: arm.arm,
          })),
        );
      }
    }
  }
  // P3: judge each graded trial once (the pinned judge, three samples), then
  // read the scores back into its row.
  const validity = args.flags['judge-validity'] === true;
  const sourcesFor = (craftbookId: string) =>
    (CRAFTBOOK_EVAL_SPECS.find((s) => s.craftbookId === craftbookId)?.setup?.files ?? []).map(
      (f) => f.path,
    );
  if (args.flags.judge === true || validity) {
    for (const [index, row] of rows.entries()) {
      if (row.p3 !== null) continue;
      const sources = sourcesFor(row.craftbookId);
      const report = await judgeTrial(row.trialDir, row.craftbookId, sources).catch((err) => {
        console.error(`[ab-strategy] judge failed for ${row.trialId}: ${String(err)}`);
        return null;
      });
      if (report?.samples.length) rows[index] = { ...row, p3: report.mean };
    }
    meta.judge = JUDGE_MODEL;
  }
  const comparisons = compareArms(
    rows,
    arms.map((a) => a.arm),
  );
  meta.finishedAt = new Date().toISOString();
  const judgeValidity = validity
    ? await runJudgeValidity(rows, sourcesFor, { log: (line) => console.log(line) })
    : null;
  if (judgeValidity) {
    await writeFile(join(root, 'judge-validity.json'), JSON.stringify(judgeValidity, null, 2));
  }
  const markdown =
    renderStrategyMarkdown(
      rows,
      comparisons,
      meta,
      arms.map((a) => a.arm),
    ) + (judgeValidity ? `\n${renderJudgeValidityMarkdown(judgeValidity)}` : '');
  await writeFile(
    join(root, 'strategy-summary.json'),
    JSON.stringify({ meta, rows, comparisons, judgeValidity }, null, 2),
  );
  await writeFile(join(root, 'strategy-summary.md'), markdown);
  console.log(`\n${markdown}`);
  console.log(`[ab-strategy] summary: ${join(root, 'strategy-summary.md')}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && /ab-strategy\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
