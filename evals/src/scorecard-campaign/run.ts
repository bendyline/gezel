import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  campaignIdentity,
  describeIdentityChanges,
  identityChanges,
} from '../api-campaign/identity.ts';
import { assertCampaignEnvironment, hash } from '../api-campaign/plan.ts';
import type { TrialFacts } from '../bin/score-trial.ts';
import { launchEvalChromium } from '../chromium.ts';
import type { FixedRubricScore } from '../fixed-rubric.ts';
import { type EngineKey, findReadOnlyModelDir, staleInstallReason } from '../model-cache.ts';
import { repoRoot, resolveSdBinary } from '../native-bin.ts';
import type { TrialMetrics } from '../perf-collector.ts';
import { discoverTrialCandidates } from '../postmortem-report.ts';
import { isLocalEngine, probeProviderAuth } from '../providers.ts';
import { captureDevice } from '../scorecard.ts';
import type { TrialResult } from '../types.ts';
import {
  type Cell,
  type Definition,
  comparisonArguments,
  comparisonCells,
  comparisonPlan,
  trialEnvironment,
} from './plan.ts';
import { type IdentityCorrection, type Row, comparisonCsv, comparisonReport } from './report.ts';

interface State {
  version: 1;
  createdAt: string;
  definition: Definition;
  identity: unknown;
  cells: Cell[];
  rows: Row[];
  running?: string;
  stopped?: string;
  identityCorrections?: IdentityCorrection[];
}
async function atomicJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function comparisonIdentity(d: Definition) {
  const cliVersions: Record<string, string> = {};
  for (const name of new Set(
    d.targets.flatMap((t) =>
      t.provider === 'codex-cli' ? ['codex'] : t.provider === 'anthropic-cli' ? ['claude'] : [],
    ),
  )) {
    const result = spawnSync(name, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: process.env,
    });
    if (result.status !== 0 || !result.stdout.trim())
      throw new Error(`Cannot determine ${name} CLI version; check its PATH installation`);
    cliVersions[name] = result.stdout.trim();
  }
  const models = [
    ...d.targets
      .filter((t) => isLocalEngine(t.provider))
      .map((t) => ({ engine: t.provider as EngineKey, modelId: t.model })),
    ...new Set(d.scenarios.flatMap((s) => (s.imageModel ? [s.imageModel] : []))),
  ].map((m) => (typeof m === 'string' ? { engine: 'sd-cpp' as const, modelId: m } : m));
  const localInstalls: Record<string, unknown> = {};
  for (const model of models) {
    const dir = await findReadOnlyModelDir({ ...model, sourceHome: d.sourceHome });
    if (!dir)
      throw new Error(
        `Missing complete ${model.engine}/${model.modelId} in ${d.sourceHome}; no downloads or trials started`,
      );
    const stale = await staleInstallReason({ ...model, cacheRoot: d.sourceHome, modelDir: dir });
    if (stale) throw new Error(`Stale ${model.modelId}: ${stale}`);
    const files: Record<string, unknown> = {};
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isFile())
        files[name] = {
          bytes: info.size,
          modified: info.mtimeMs,
          ...(info.size < 1024 * 1024 ? { contentHash: hash(await readFile(path, 'base64')) } : {}),
        };
    }
    localInstalls[`${model.engine}/${model.modelId}`] = { path: await realpath(dir), files };
  }
  const imageBinary = models.some((m) => m.engine === 'sd-cpp') ? resolveSdBinary() : null;
  if (models.some((m) => m.engine === 'sd-cpp') && !imageBinary)
    throw new Error('Image scenarios require an installed sd-server binary');
  const imageBinaryStat = imageBinary ? await stat(imageBinary.path) : null;
  return {
    ...(await campaignIdentity()),
    cliVersions,
    localInstalls,
    device: captureDevice(),
    imageBinary: imageBinary
      ? { ...imageBinary, bytes: imageBinaryStat!.size, modified: imageBinaryStat!.mtimeMs }
      : null,
  };
}

export async function readRow(dir: string, cell: Cell, definition: Definition): Promise<Row> {
  const candidates = await discoverTrialCandidates(dir);
  if (candidates.length !== 1)
    throw new Error(
      `Expected exactly one trial in ${cell.id}; found ${candidates.length}. This attempt will not be repeated automatically.`,
    );
  const path = candidates[0]!;
  const active = await stat(join(path, 'status.json')).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    },
  );
  if (active)
    throw new Error(`Trial ${cell.id} still has active status; wait for cleanup before resuming`);
  const [result, score, metrics, facts] = await Promise.all([
    json<TrialResult>(join(path, 'result.json')),
    json<FixedRubricScore>(join(path, 'score.json')),
    json<TrialMetrics>(join(path, 'metrics.json')),
    json<TrialFacts>(join(path, 'facts.json')),
  ]);
  if (
    result.engine !== cell.provider ||
    result.modelId !== cell.model ||
    result.scenarioId !== cell.scenario ||
    result.generalistMode !== definition.generalist ||
    (result.repairPolicy ?? 'harness') !==
      definition.scenarios.find((s) => s.suite === cell.suite && s.id === cell.scenario)
        ?.repairPolicy ||
    score.trialId !== result.trialId ||
    facts.trialId !== result.trialId ||
    resolve(result.runDir) !== resolve(path)
  )
    throw new Error(`Result treatment/evidence mismatch in ${cell.id}`);
  if (
    !Number.isFinite(score.composite) ||
    !metrics.derived ||
    !metrics.usage ||
    !facts.timing ||
    !facts.toolUse ||
    !facts.autoAnswer
  )
    throw new Error(`Incomplete score/performance evidence in ${cell.id}`);
  return {
    cell,
    result,
    score,
    metrics,
    timing: facts.timing,
    toolCalls: facts.toolUse.totalToolCalls,
    autoAnswers: facts.autoAnswer.total,
    modes: facts.continuity,
  };
}

export async function executeCell(
  cell: Cell,
  d: Definition,
  dir: string,
  root: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error('Campaign interrupted before launch');
  return await new Promise<number>((resolveCode, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(repoRoot(), 'scripts/run-with-dependency-lease.mjs'),
        '--direct-node',
        'evals/src/bin/all.ts',
        ...comparisonArguments(cell, d, dir, join(root, 'preflight')),
      ],
      {
        cwd: repoRoot(),
        env: trialEnvironment(d, cell, process.env),
        stdio: 'inherit',
      },
    );
    const abort = () => {
      child.kill('SIGINT');
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolveCode(code ?? 130);
    });
  });
}

export interface Options {
  runsDir: string;
  definition: Definition;
  execute?: boolean;
  limit?: number;
  signal?: AbortSignal;
}
interface Dependencies {
  identity: (d: Definition) => Promise<unknown>;
  execute: typeof executeCell;
  read: typeof readRow;
  preflight: (d: Definition) => void | Promise<void>;
  log: (line: string) => void;
}
const defaults: Dependencies = {
  identity: comparisonIdentity,
  execute: executeCell,
  read: readRow,
  log: console.log,
  async preflight(d) {
    const problems = d.targets.flatMap((t) => {
      const probe = probeProviderAuth(t.provider, trialEnvironment(d, t, process.env));
      return probe.ok ? [] : [`${t.id}: ${probe.message}`];
    });
    if (problems.length)
      throw new Error(`No trials launched. Provider setup required:\n${problems.join('\n')}`);
    if (d.scenarios.some((s) => s.requires.includes('chromium'))) {
      const browser = await launchEvalChromium();
      await browser.close();
    }
  },
};

/** Journal before every attempt. A partial/crashed paid trial is evidence, never a retry request. */
export async function runComparison(opts: Options, deps: Dependencies = defaults): Promise<State> {
  assertCampaignEnvironment(process.env);
  // Keep mutable evidence outside source identity and the published dataset.
  const rel = relative(join(repoRoot(), 'evals/runs'), resolve(opts.runsDir));
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    resolve(opts.runsDir) === resolve(join(repoRoot(), 'evals/runs'))
  )
    throw new Error('--runs-dir must be a dedicated directory under evals/runs');
  await mkdir(opts.runsDir, { recursive: true });
  const lockPath = join(opts.runsDir, 'campaign.lock');
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new Error(
      `Campaign locked at ${lockPath}; verify the owner has exited before removing a stale lock`,
    );
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const path = join(opts.runsDir, 'campaign.json');
    const identity = await deps.identity(opts.definition);
    const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const cells = comparisonCells(opts.definition);
    const state: State = existing
      ? JSON.parse(existing)
      : {
          version: 1,
          createdAt: new Date().toISOString(),
          definition: opts.definition,
          identity,
          cells,
          rows: [],
        };
    if (
      state.version !== 1 ||
      hash(state.definition) !== hash(opts.definition) ||
      hash(state.cells) !== hash(cells)
    )
      throw new Error('Campaign definition changed; use a new --runs-dir');
    if (
      new Set(state.rows.map((r) => r.cell.id)).size !== state.rows.length ||
      state.rows.some((r) => !cells.some((c) => hash(c) === hash(r.cell)))
    )
      throw new Error('Inconsistent campaign journal');
    const save = async () => {
      await atomicJson(path, state);
      await atomicJson(join(opts.runsDir, 'summary.json'), {
        planned: cells.length,
        recorded: state.rows.length,
        running: state.running ?? null,
        stopped: state.stopped ?? null,
        identityCorrections: state.identityCorrections ?? [],
        rows: state.rows,
      });
      await writeFile(join(opts.runsDir, 'plan.md'), comparisonPlan(opts.definition, cells));
      await writeFile(
        join(opts.runsDir, 'report.md'),
        comparisonReport(
          opts.definition,
          cells,
          state.rows,
          state.stopped,
          state.identityCorrections,
        ),
      );
      await writeFile(join(opts.runsDir, 'trials.csv'), comparisonCsv(state.rows));
    };
    const drift = async (observed: unknown, phase: string) => {
      const changes = identityChanges(state.identity, observed);
      if (!changes.length) return undefined;
      const evidence = `identity-drift-${phase}.json`;
      await atomicJson(join(opts.runsDir, evidence), {
        expected: state.identity,
        observed,
        changes,
        cell: state.running ?? null,
      });
      return `Frozen comparison changed: ${describeIdentityChanges(changes)} (see ${evidence})`;
    };
    const record = async (cell: Cell, observed: unknown) => {
      const row = await deps.read(join(opts.runsDir, cell.id), cell, opts.definition);
      row.comparisonIssue = await drift(observed, 'after-trial');
      state.rows.push(row);
      delete state.running;
      state.stopped =
        row.comparisonIssue ??
        (['infra', 'operator', 'grader'].includes(
          row.result.failureClass ?? row.score.eligibility.failureClass,
        )
          ? `${row.result.failureClass ?? row.score.eligibility.failureClass}: ${row.result.reason}`
          : undefined);
      await save();
    };
    if (state.running) {
      const cell = cells.find((c) => c.id === state.running);
      if (!cell || state.rows.some((r) => r.cell.id === cell.id))
        throw new Error('Inconsistent running cell');
      await record(cell, identity);
    } else {
      const changed = await drift(identity, 'resume');
      if (changed) {
        state.stopped = changed;
        await save();
        throw new Error(changed);
      }
    }
    await save();
    deps.log(
      `[scorecard-campaign] ${state.rows.length}/${cells.length} recorded at ${opts.runsDir}`,
    );
    if (!opts.execute) {
      deps.log(
        '[scorecard-campaign] Prepared only; --execute starts pending trials. No provider calls made.',
      );
      return state;
    }
    if (state.stopped)
      throw new Error(
        `Campaign stopped: ${state.stopped}. Review evidence before preparing a new baseline.`,
      );
    if (state.rows.length === cells.length) return state;
    await deps.preflight(opts.definition);
    let launched = 0;
    for (const cell of cells.filter((c) => !state.rows.some((r) => r.cell.id === c.id))) {
      if (opts.signal?.aborted || (opts.limit !== undefined && launched >= opts.limit)) break;
      const changed = await drift(await deps.identity(opts.definition), 'before-trial');
      if (changed) {
        state.stopped = changed;
        await save();
        break;
      }
      const dir = join(opts.runsDir, cell.id);
      await mkdir(dir); // An unjournaled directory may contain an earlier attempt; do not reuse it.
      state.running = cell.id;
      await save();
      deps.log(
        `[scorecard-campaign] Starting ${cell.id} (${state.rows.length + 1}/${cells.length})`,
      );
      const code = await deps.execute(cell, opts.definition, dir, opts.runsDir, opts.signal);
      launched++;
      if (code !== 0 && code !== 1) {
        throw new Error(
          `Cell ${cell.id} exited ${code}; inspect its evidence. It will not be retried automatically.`,
        );
      }
      await record(cell, await deps.identity(opts.definition));
      if (state.stopped) break;
    }
    deps.log(
      `[scorecard-campaign] ${state.rows.length}/${cells.length} recorded; report: ${join(opts.runsDir, 'report.md')}`,
    );
    if (state.stopped) deps.log(`[scorecard-campaign] Stopped: ${state.stopped}`);
    return state;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
