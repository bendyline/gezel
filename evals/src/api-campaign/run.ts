import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from '../native-bin.ts';
import { captureQualificationIdentity } from '../qualification/metadata.ts';
import type { TrialResult } from '../types.ts';
import {
  CONSENT_SCRIPT,
  type CampaignCell,
  assertCampaignEnvironment,
  campaignCells,
  campaignDefinition,
  campaignPlan,
  hash,
  trialArguments,
} from './plan.ts';
import { type CampaignRow, campaignReport, campaignStopReason } from './report.ts';

interface CampaignState {
  version: 1;
  createdAt: string;
  count: number;
  definition: ReturnType<typeof campaignDefinition>;
  identity: unknown;
  cells: CampaignCell[];
  rows: CampaignRow[];
  running?: string;
  stopped?: string;
}

export async function campaignIdentity() {
  const identity = await captureQualificationIdentity(repoRoot());
  if (identity.unavailable.length)
    throw new Error(`Cannot freeze campaign: ${identity.unavailable.join(', ')}`);
  // Hash ambient Gezel settings without recording values or credentials.
  const environment = Object.entries(process.env)
    .filter(([key]) => key.startsWith('GEZEL_') && !key.startsWith('GEZEL_DEPENDENCY_LEASE_'))
    .sort(([a], [b]) => a.localeCompare(b));
  return { ...identity, environmentHash: hash(environment) };
}

async function atomicJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

async function readResult(dir: string, cell: CampaignCell): Promise<TrialResult> {
  const dirs = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const results: TrialResult[] = [];
  for (const entry of dirs.filter((d) => d.isDirectory())) {
    try {
      results.push(JSON.parse(await readFile(join(dir, entry.name, 'result.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (results.length !== 1)
    throw new Error(
      `Expected one saved result for ${cell.id}; found ${results.length}. Review this cell; it will not be rerun automatically.`,
    );
  const result = results[0]!;
  if (
    result.engine !== cell.provider ||
    result.modelId !== cell.model ||
    result.scenarioId !== cell.scenario ||
    result.repairPolicy !== cell.repairPolicy ||
    result.generalistMode !== 'on'
  )
    throw new Error(`Treatment mismatch in ${cell.id}`);
  return result;
}

export async function executeCell(
  cell: CampaignCell,
  dir: string,
  script: string,
  signal?: AbortSignal,
) {
  const args = [
    join(repoRoot(), 'scripts/run-with-dependency-lease.mjs'),
    '--direct-node',
    'evals/src/bin/run.ts',
    ...trialArguments(cell, dir, script),
  ];
  const code = await new Promise<number>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Campaign interrupted'));
      return;
    }
    const child = spawn(process.execPath, args, {
      cwd: repoRoot(),
      env: process.env,
      stdio: 'inherit',
    });
    const abort = () => child.kill('SIGINT');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolve(code ?? 130);
    });
  });
  if (code !== 0 && code !== 1) throw new Error(`Trial process exited ${code}; inspect ${dir}`);
}

export interface CampaignOptions {
  runsDir: string;
  count?: number;
  execute?: boolean;
  signal?: AbortSignal;
}
interface CampaignDependencies {
  identity: () => Promise<unknown>;
  execute: typeof executeCell;
  script: () => Promise<unknown>;
  log: (message: string) => void;
}

/** Each paid attempt is journaled before launch. Resume never silently retries it. */
export async function runCampaign(
  opts: CampaignOptions,
  deps: CampaignDependencies = {
    identity: campaignIdentity,
    execute: executeCell,
    script: async () => JSON.parse(await readFile(join(repoRoot(), CONSENT_SCRIPT), 'utf8')),
    log: console.log,
  },
) {
  assertCampaignEnvironment(process.env);
  await mkdir(opts.runsDir, { recursive: true });
  const lockPath = join(opts.runsDir, 'campaign.lock');
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new Error(
      `Campaign locked: ${lockPath}. If a previous process crashed, verify it has exited before removing its lock.`,
    );
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const path = join(opts.runsDir, 'campaign.json');
    const definition = campaignDefinition(await deps.script());
    const identity = await deps.identity();
    let state: CampaignState;
    const existing = await readFile(path, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) {
      state = JSON.parse(existing);
      if (
        state.version !== 1 ||
        hash(state.definition) !== hash(definition) ||
        hash(state.identity) !== hash(identity)
      )
        throw new Error(
          'Campaign definition, source/build/catalog, consent, or environment changed. Use a new --runs-dir for a new baseline.',
        );
      if (hash(state.cells) !== hash(campaignCells(state.count)))
        throw new Error('Campaign schedule was modified');
      const count = opts.count ?? state.count;
      if (count < state.count) throw new Error('Cannot reduce an existing campaign count');
      state.cells = campaignCells(count);
      state.count = count;
    } else {
      const count = opts.count ?? 1;
      state = {
        version: 1,
        createdAt: new Date().toISOString(),
        count,
        definition,
        identity,
        cells: campaignCells(count),
        rows: [],
      };
    }
    const scriptPath = join(opts.runsDir, 'user-script.json');
    // Recover the frozen script from the manifest; never use a mutable script during trials.
    await atomicJson(scriptPath, definition.userScript);
    const save = async () => {
      await atomicJson(path, state);
      await writeFile(join(opts.runsDir, 'plan.md'), campaignPlan(state.cells));
      await atomicJson(join(opts.runsDir, 'summary.json'), {
        planned: state.cells.length,
        recorded: state.rows.length,
        stopped: state.stopped ?? null,
        rows: state.rows,
      });
      await writeFile(
        join(opts.runsDir, 'report.md'),
        campaignReport(state.cells, state.rows, state.stopped),
      );
    };
    const record = async (cell: CampaignCell) => {
      const result = await readResult(join(opts.runsDir, cell.id), cell);
      const row = { cell, result };
      state.rows.push(row);
      delete state.running;
      state.stopped = campaignStopReason(row);
      await save();
    };
    if (state.running) {
      const cell = state.cells.find((c) => c.id === state.running);
      if (!cell || state.rows.some((r) => r.cell.id === cell.id))
        throw new Error('Inconsistent campaign journal');
      await record(cell);
    }
    await save();
    const remaining = state.cells.filter((c) => !state.rows.some((r) => r.cell.id === c.id));
    deps.log(
      `[api-campaign] ${state.rows.length}/${state.cells.length} recorded; ${remaining.length} remaining at ${opts.runsDir}`,
    );
    deps.log(
      '[api-campaign] Sequential trials, 10m execution target + up to 2m completion each; startup/cleanup and in-flight grace add time. API charges are usage-based; no dollar cap is enforced.',
    );
    if (!opts.execute) {
      deps.log('[api-campaign] Plan only; add --execute to start paid API calls.');
      for (const cell of remaining) deps.log(`  ${cell.id} (${cell.model})`);
      return state;
    }
    if (state.stopped)
      throw new Error(
        `Campaign stopped: ${state.stopped}. Review the recorded failure before starting a new campaign.`,
      );
    for (const cell of remaining) {
      if (opts.signal?.aborted) break;
      if (hash(await deps.identity()) !== hash(state.identity))
        throw new Error('Campaign identity drifted; stopped before the next API trial');
      const dir = join(opts.runsDir, cell.id);
      // An unjournaled directory may contain evidence of an earlier paid attempt.
      await mkdir(dir);
      state.running = cell.id;
      await save();
      deps.log(`[api-campaign] Starting ${cell.id}`);
      await deps.execute(cell, dir, scriptPath, opts.signal);
      await record(cell);
      if (hash(await deps.identity()) !== hash(state.identity)) {
        state.stopped =
          'Source/build/catalog or environment changed during the trial; results are not a frozen comparison';
        state.rows.at(-1)!.comparisonIssue = state.stopped;
        await save();
      }
      if (state.stopped) {
        deps.log(`[api-campaign] Stopped: ${state.stopped}`);
        break;
      }
    }
    deps.log(
      `[api-campaign] ${state.rows.length}/${state.cells.length} recorded; comparison: ${join(opts.runsDir, 'report.md')}`,
    );
    return state;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
