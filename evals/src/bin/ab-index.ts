/**
 * `pnpm --filter @bendyline/gezel-evals run ab-index [...flags]`
 *
 * Warm-vs-cold index A/B over the index-leverage scenarios. Both arms run
 * with the background enrichment tick disabled; the `warm` arm drives the
 * index to completion inside each scenario's setup (GEZEL_INDEX_ARM), the
 * `cold` arm leaves only the structural scan. Arms are interleaved per
 * model (warm then cold for model 1, then model 2) so machine-level drift
 * hits both arms equally — the ab-craftbook-format discipline.
 *
 * Stage 2 (behavior toggles) is a separate invocation within the warm arm:
 *   run ab-index -- --arms warm --remove-behaviors prompt.workspace-gestalt,prompt.retrieval-first
 *
 * Flags:
 *   --models <id[,id...]>   model catalog ids (default: platform default)
 *   --provider <p>          engine (default: platform default)
 *   --scenarios <a,b>       subset (default: squisq-codebase-qa,squisq-broad-refactor,tool-routing-retrieval)
 *   --arms <warm,cold>      arms to run (default both)
 *   --count <N>             trials per scenario per arm (default 1)
 *   --timeout <dur>         per-trial timeout override
 *   --force-behaviors / --remove-behaviors  behavior toggles for ALL arms
 *   --enrich-model <id>     SECOND local model for index enrichment
 *                           (GEZEL_ENRICH_MODEL) — executor stays --models.
 *                           The mixed-model harness: fast enricher, capable
 *                           executor, so warm arms enrich in minutes.
 *   --mlx-source-home <p>   MLX weights source home (default ~/.gezel-dev)
 *   --runs-dir <path>       output root override
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { defaultCacheRoot } from '../model-cache.ts';
import { repoRoot } from '../native-bin.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import { slugifyForDirName } from '../runner.ts';
import { getScenario } from '../scenarios/index.ts';
import type { EvalScenario, MatrixSummary } from '../types.ts';
import { parseArgs, parseDuration, resolveProviderFlag } from './args.ts';

const DEFAULT_SCENARIOS = ['squisq-codebase-qa', 'squisq-broad-refactor', 'tool-routing-retrieval'];
type Arm = 'warm' | 'cold';

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(`\n[ab-index] ${sig} received — aborting gracefully`);
      ac.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac;
}

interface Cell {
  arm: Arm;
  model: string;
  scenarioId: string;
  passed: number;
  trials: number;
  meanDurationMs: number;
}

function cellsFromMatrix(summary: MatrixSummary, arm: Arm, model: string): Cell[] {
  return summary.scenarios.map((s) => ({
    arm,
    model,
    scenarioId: s.scenarioId,
    passed: s.successes,
    trials: s.trials,
    meanDurationMs: 0,
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = resolveProviderFlag(args.flags) ?? defaultProvider();
  const models = String(args.flags.models ?? args.flags.model ?? defaultModelFor(provider))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const scenarioIds = String(args.flags.scenarios ?? DEFAULT_SCENARIOS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const arms = String(args.flags.arms ?? 'warm,cold')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Arm => s === 'warm' || s === 'cold');
  const count = args.flags.count ? Number.parseInt(String(args.flags.count), 10) : 1;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const parseCsv = (v: unknown): string[] =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const forceBehaviors = parseCsv(args.flags['force-behaviors']);
  const removeBehaviors = parseCsv(args.flags['remove-behaviors']);
  // Embedding-model lever (#2) — inherited by every trial daemon; shared HF
  // cache so a new embedder downloads once.
  if (args.flags['embed-model']) process.env.GEZEL_EMBED_MODEL = String(args.flags['embed-model']);
  if (args.flags['embed-dim']) process.env.GEZEL_EMBED_DIM = String(args.flags['embed-dim']);
  process.env.GEZEL_HF_CACHE_DIR ??= join(defaultCacheRoot(), 'hf-cache');

  const scenarios: EvalScenario[] = scenarioIds.map((id) => getScenario(id));
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider, scenarios });
  const ac = installSignalHandlers();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = args.flags['runs-dir']
    ? String(args.flags['runs-dir'])
    : join(repoRoot(), 'evals', 'runs', `ab-index-${ts}`);
  await mkdir(outRoot, { recursive: true });

  const cells: Cell[] = [];
  for (const model of models) {
    for (const arm of arms) {
      if (ac.signal.aborted) break;
      console.log(`\n[ab-index] === ${model} · ${arm} ===`);
      process.env.GEZEL_INDEX_ARM = arm;
      const summary = await runMatrix(scenarios, {
        engine: provider,
        modelId: model,
        count,
        disableBackgroundEnrich: true,
        skipPreflight: true,
        runsDir: join(outRoot, slugifyForDirName(model), arm),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(forceBehaviors.length > 0 ? { forceBehaviors } : {}),
        ...(removeBehaviors.length > 0 ? { removeBehaviors } : {}),
        ...(args.flags['enrich-model']
          ? { enrichModelId: String(args.flags['enrich-model']) }
          : {}),
        ...(args.flags['mlx-source-home']
          ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
          : {}),
        signal: ac.signal,
      });
      cells.push(...cellsFromMatrix(summary, arm, model));
    }
  }

  await writeFile(
    join(outRoot, 'ab-summary.json'),
    `${JSON.stringify({ provider, models, arms, scenarioIds, count, forceBehaviors, removeBehaviors, cells }, null, 2)}\n`,
  );

  console.log('\n=== ab-index summary (pass rate warm vs cold) ===');
  for (const model of models) {
    for (const sid of scenarioIds) {
      const warm = cells.find((c) => c.model === model && c.arm === 'warm' && c.scenarioId === sid);
      const cold = cells.find((c) => c.model === model && c.arm === 'cold' && c.scenarioId === sid);
      const fmt = (c?: Cell) => (c ? `${c.passed}/${c.trials}` : '—');
      console.log(
        `${model.padEnd(26)} ${sid.padEnd(26)} warm ${fmt(warm).padEnd(6)} cold ${fmt(cold)}`,
      );
    }
  }
  console.log(`\nreports: ${outRoot}`);
  deviceLock?.release();
}

main().catch((err) => {
  console.error('[ab-index] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
