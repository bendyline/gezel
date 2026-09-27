/**
 * `pnpm --filter @bendyline/gezel-evals run retrieval-bench [...flags]`
 *
 * Retrieval-quality bench: one trial of the `retrieval-bench` scenario (no
 * agent — labeled corpus seed → every query through the retrieval preview →
 * report). The chat model is never prompted; it only has to be installed so
 * the trial daemon boots, so the default is the platform's small model.
 *
 * Flags:
 *   --mode <off|lean|balanced|deep>  per-turn policy the turn surface is judged under (default balanced)
 *   --rounds <N>                     measured rounds per query (default 3; round 1 is judged)
 *   --arm <label>                    report label (default `baseline`)
 *   --relevance-model <id>           add relevance-model arms: off, raw (uncalibrated), and
 *                                    one per --thresholds triple; writes a threshold sweep
 *   --thresholds "d,k,s;d,k,s"       candidate thresholds to confirm live (with --relevance-model)
 *   --provider <p> --model <id>      trial daemon's chat engine (never prompted)
 *   --runs-dir <path>                override the output root
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { defaultCacheRoot } from '../model-cache.ts';
import { repoRoot } from '../native-bin.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import type { BenchReport } from '../retrieval-bench/report.ts';
import { renderBenchMarkdown } from '../retrieval-bench/report.ts';
import { runTrial } from '../runner.ts';
import { getScenario } from '../scenarios/index.ts';
import { parseArgs, resolveProviderFlag } from './args.ts';

async function readArtifact(runDir: string, name: string): Promise<string | null> {
  const artifactsRoot = join(runDir, 'artifacts');
  try {
    for (const project of await readdir(artifactsRoot)) {
      try {
        return await readFile(join(artifactsRoot, project, 'retrieval-bench', name), 'utf8');
      } catch {
        /* not this project */
      }
    }
  } catch {
    /* no artifacts captured */
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = resolveProviderFlag(args.flags) ?? defaultProvider();
  const modelId = String(args.flags.model ?? defaultModelFor(provider));
  process.env.GEZEL_RETRIEVAL_BENCH_MODE = String(args.flags.mode ?? 'balanced');
  process.env.GEZEL_RETRIEVAL_BENCH_ROUNDS = String(args.flags.rounds ?? 3);
  process.env.GEZEL_RETRIEVAL_BENCH_ARM = String(args.flags.arm ?? 'baseline');
  process.env.GEZEL_HF_CACHE_DIR ??= join(defaultCacheRoot(), 'hf-cache');
  if (args.flags['relevance-model']) {
    const thresholds = String(args.flags.thresholds ?? '')
      .split(';')
      .map((triple) => triple.split(',').map(Number))
      .filter((values) => values.length === 3 && values.every(Number.isFinite))
      .map(([drop, keep, strong]) => ({ drop: drop!, keep: keep!, strong: strong! }));
    process.env.GEZEL_RETRIEVAL_BENCH_RELEVANCE = JSON.stringify({
      modelId: String(args.flags['relevance-model']),
      thresholds,
    });
    // One verified copy across trials, like the embedder cache.
    process.env.GEZEL_RELEVANCE_MODELS_DIR ??= join(defaultCacheRoot(), 'relevance-models');
  }

  const scenario = getScenario('retrieval-bench');
  acquireEvalDeviceLockIfNeeded({ provider, scenarios: [scenario] });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = args.flags['runs-dir']
    ? String(args.flags['runs-dir'])
    : join(repoRoot(), 'evals', 'runs', `retrieval-bench-${ts}`);
  await mkdir(outRoot, { recursive: true });

  const result = await runTrial(scenario, {
    engine: provider,
    modelId,
    disableBackgroundEnrich: true,
    runsDir: outRoot,
  });
  const raw = await readArtifact(result.runDir, 'report.json');
  if (!raw) {
    console.error(`[retrieval-bench] no report — ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(raw) as BenchReport;
  await writeFile(join(outRoot, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outRoot, 'report.md'), renderBenchMarkdown(report));
  for (const name of [
    'traces.json',
    'arms.json',
    'comparison.md',
    'sweep.json',
    'sweep.md',
    'traces-raw.json',
    'traces-off.json',
  ]) {
    const content = await readArtifact(result.runDir, name);
    if (content) await writeFile(join(outRoot, name), content);
  }
  const comparison = await readArtifact(result.runDir, 'comparison.md');
  const sweep = await readArtifact(result.runDir, 'sweep.md');
  console.log(comparison ?? renderBenchMarkdown(report));
  if (sweep) console.log(sweep);
  console.log(`[retrieval-bench] ${result.success ? 'ok' : 'INVALID'} — ${result.reason}`);
  console.log(`[retrieval-bench] wrote ${outRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
