/**
 * `pnpm --filter @bendyline/gezel-evals run index-bench [...flags]`
 *
 * Index-quality bench: sweeps the `index-bench` scenario (no agent — corpus
 * seed → golden-query retrieval at three checkpoints → report artifact)
 * across local models. Because the trial model IS the enricher model, the
 * `--models` list is the enricher A/B. Reports per model land in the trial
 * runDirs; this bin aggregates them into one comparison table.
 *
 * Flags:
 *   --models <id[,id...]>  chat/enricher model catalog ids (required)
 *   --provider <p>         engine (default: platform default)
 *   --corpus <id>          corpus manifest id (default `squisq`)
 *   --source-dir <path>     git checkout containing the corpus's pinned SHA
 *   --limit-files <N>      smoke mode: seed only the first N corpus files
 *   --drive-deadline <dur> enrichment-drive deadline (default `90m`)
 *   --embed-model <id>     embedding model (lever 2), e.g. `Xenova/gte-small`
 *                          (default bge-small). Same-dim models are drop-in.
 *   --embed-dim <N>        vec_text dim when the embed model isn't 384
 *   --no-window            disable windowed chunking of large functions
 *                          (GEZEL_INDEX_WINDOW=0). Windowing is ON by default
 *                          (lever 3); this is the control
 *                          arm for A/B-ing it.
 *   --no-query-instruction disable the bge query-side retrieval prefix (for
 *                          isolating its contribution vs the no-prefix baseline).
 *   --runs-dir <path>      override the output root
 *
 * Smoke example (minutes, not hours):
 *   run index-bench -- --models qwen3.5-4b-q4 --limit-files 40 --drive-deadline 10m
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { defaultCacheRoot } from '../model-cache.ts';
import { repoRoot } from '../native-bin.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import { runTrial } from '../runner.ts';
import { slugifyForDirName } from '../runner.ts';
import type { IndexBenchReport } from '../scenarios/index-bench.ts';
import { getScenario } from '../scenarios/index.ts';
import { parseArgs, parseDuration, resolveProviderFlag } from './args.ts';

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(`\n[index-bench] ${sig} received — aborting gracefully`);
      ac.abort();
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac;
}

async function readReport(runDir: string): Promise<IndexBenchReport | null> {
  // captureFinalState copies project artifacts to <runDir>/artifacts/<proj>/…
  const artifactsRoot = join(runDir, 'artifacts');
  try {
    const { readdir } = await import('node:fs/promises');
    for (const proj of await readdir(artifactsRoot)) {
      const p = join(artifactsRoot, proj, 'index-bench', 'report.json');
      try {
        return JSON.parse(await readFile(p, 'utf8')) as IndexBenchReport;
      } catch {
        /* not this project */
      }
    }
  } catch {
    /* no artifacts captured */
  }
  return null;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = resolveProviderFlag(args.flags) ?? defaultProvider();
  const models = String(args.flags.models ?? args.flags.model ?? defaultModelFor(provider))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const corpus = String(args.flags.corpus ?? 'squisq');
  const limitFiles = args.flags['limit-files']
    ? Number.parseInt(String(args.flags['limit-files']), 10)
    : null;
  const driveDeadlineMs = args.flags['drive-deadline']
    ? parseDuration(String(args.flags['drive-deadline']))
    : 90 * 60_000;

  process.env.GEZEL_INDEX_BENCH_CORPUS = corpus;
  if (args.flags['source-dir']) {
    process.env.GEZEL_INDEX_BENCH_SOURCE_DIR = String(args.flags['source-dir']);
  }
  if (limitFiles) process.env.GEZEL_INDEX_BENCH_LIMIT_FILES = String(limitFiles);
  process.env.GEZEL_INDEX_BENCH_DRIVE_MS = String(driveDeadlineMs);
  // Embedding-model lever (#2). The daemon inherits process.env, so setting
  // these here reaches every trial. Share one HF cache across trials so a new
  // embedder downloads once, not per trial.
  if (args.flags['embed-model']) process.env.GEZEL_EMBED_MODEL = String(args.flags['embed-model']);
  if (args.flags['embed-dim']) process.env.GEZEL_EMBED_DIM = String(args.flags['embed-dim']);
  // Levers 3 & 1b — retrieval-quality toggles the daemon reads from its env.
  // Both are ON by default now; these flags are the A/B control arms.
  if (args.flags['no-window']) process.env.GEZEL_INDEX_WINDOW = '0';
  if (args.flags['no-query-instruction']) process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION = '1';
  process.env.GEZEL_HF_CACHE_DIR ??= join(defaultCacheRoot(), 'hf-cache');

  const scenario = getScenario('index-bench');
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider, scenarios: [scenario] });
  const ac = installSignalHandlers();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outRoot = args.flags['runs-dir']
    ? String(args.flags['runs-dir'])
    : join(repoRoot(), 'evals', 'runs', `index-bench-${ts}`);
  await mkdir(outRoot, { recursive: true });

  const rows: Array<{ model: string; report: IndexBenchReport | null; reason: string }> = [];
  for (const modelId of models) {
    if (ac.signal.aborted) break;
    console.log(`\n[index-bench] === model ${modelId} (${provider}) ===`);
    const result = await runTrial(scenario, {
      engine: provider,
      modelId,
      disableBackgroundEnrich: true,
      runsDir: join(outRoot, slugifyForDirName(modelId)),
      signal: ac.signal,
      ...(args.flags['mlx-source-home']
        ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
        : {}),
    });
    const report = await readReport(result.runDir);
    rows.push({ model: modelId, report, reason: result.reason ?? '' });
    console.log(`[index-bench] ${modelId}: ${result.success ? 'ok' : 'FAILED'} — ${result.reason}`);
  }

  const summary = {
    corpus,
    limitFiles,
    provider,
    embedModel:
      rows.find((r) => r.report)?.report?.embedModel ??
      process.env.GEZEL_EMBED_MODEL ??
      '(daemon default)',
    levers: {
      window: process.env.GEZEL_INDEX_WINDOW !== '0',
      queryInstruction: process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION !== '1',
    },
    generatedAt: new Date().toISOString(),
    models: rows.map((r) => ({
      model: r.model,
      reason: r.reason,
      ...(r.report
        ? {
            semanticR5Structural: r.report.checkpoint1.semantic.recallAt5,
            semanticR5Enriched: r.report.checkpoint2.semantic.recallAt5,
            autoMrrEnriched: r.report.checkpoint2.auto.mrr,
            keywordR5: r.report.checkpoint2.keyword.recallAt5,
            summarized: r.report.enrichment?.summarized ?? null,
            eligible: r.report.enrichment?.eligible ?? null,
            areasCovered: `${r.report.areas.expectedCovered}/${r.report.areas.expectedTotal}`,
            architecture: r.report.areas.architecture,
            driveMinutes: Math.round(r.report.drive.durationMs / 60_000),
          }
        : {}),
    })),
  };
  await writeFile(join(outRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\n=== index-bench summary (embed: ${summary.embedModel}) ===`);
  console.log(
    [
      'model'.padEnd(28),
      'semR@5 c1→c2'.padEnd(15),
      'MRR'.padEnd(7),
      'kwR@5'.padEnd(8),
      'summarized'.padEnd(13),
      'areas'.padEnd(7),
      'drive',
    ].join(''),
  );
  for (const r of rows) {
    const rep = r.report;
    if (!rep) {
      console.log(`${r.model.padEnd(28)}(no report — ${r.reason})`);
      continue;
    }
    console.log(
      [
        r.model.padEnd(28),
        `${pct(rep.checkpoint1.semantic.recallAt5)}→${pct(rep.checkpoint2.semantic.recallAt5)}`.padEnd(
          15,
        ),
        rep.checkpoint2.auto.mrr.toFixed(2).padEnd(7),
        pct(rep.checkpoint2.keyword.recallAt5).padEnd(8),
        `${rep.enrichment?.summarized ?? '?'}/${rep.enrichment?.eligible ?? '?'}`.padEnd(13),
        `${rep.areas.expectedCovered}/${rep.areas.expectedTotal}`.padEnd(7),
        `${Math.round(rep.drive.durationMs / 60_000)}m`,
      ].join(''),
    );
  }
  console.log(`\nreports: ${outRoot}`);
  deviceLock?.release();
}

main().catch((err) => {
  console.error('[index-bench] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
