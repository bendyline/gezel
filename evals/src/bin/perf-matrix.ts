/**
 * Cross-model performance readout over a sweep's trial dirs.
 *
 * Capability (does the model pass) already has `compare-scores` /
 * `completions-per-hour`. This is the other half the postmortem rubric
 * deliberately keeps separate: how fast and how heavy each model×engine
 * combo ran. It joins the three per-trial sidecars the runner writes —
 * `result.json` (outcome), `metrics.json` (perf samples), `host.json`
 * (hardware + engine binary) — so no scoring pass is needed first.
 *
 * Medians, not means: one cold-start or SSD-streaming trial skews a mean
 * badly, and decode throughput across a suite is not normally distributed.
 *
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/perf-matrix.ts [runsDir] [--tsv]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface TrialRow {
  scenarioId: string;
  modelId: string;
  engine: string;
  success: boolean;
  failureMode?: string;
  durationMs: number;
  genTps: number | null;
  promptTps: number | null;
  peakRssMb: number | null;
  peakGpuUtil: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Every dir containing a result.json, walked depth-first. */
function findTrialDirs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.includes('result.json')) {
      out.push(dir);
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) stack.push(p);
      } catch {
        // Race with a concurrent sweep writing dirs — skip.
      }
    }
  }
  return out;
}

function collect(runsDir: string): TrialRow[] {
  const rows: TrialRow[] = [];
  for (const dir of findTrialDirs(runsDir)) {
    const result = readJson<{
      scenarioId?: string;
      modelId?: string;
      success?: boolean;
      durationMs?: number;
      failureMode?: string;
    }>(join(dir, 'result.json'));
    if (!result?.modelId || !result?.scenarioId) continue;
    const metrics = readJson<{
      derived?: {
        genTokensPerSec?: number | null;
        promptTokensPerSec?: number | null;
        meanTokensPerSec?: number | null;
        peakRssMb?: number | null;
        peakGpuUtilPercent?: number | null;
      };
      usage?: { totalInputTokens?: number; totalOutputTokens?: number };
    }>(join(dir, 'metrics.json'));
    const host = readJson<{ framework?: string }>(join(dir, 'host.json'));
    const d = metrics?.derived ?? {};
    rows.push({
      scenarioId: result.scenarioId,
      modelId: result.modelId,
      engine: host?.framework ?? 'unknown',
      success: Boolean(result.success),
      ...(result.failureMode ? { failureMode: result.failureMode } : {}),
      durationMs: result.durationMs ?? 0,
      genTps: d.genTokensPerSec ?? d.meanTokensPerSec ?? null,
      promptTps: d.promptTokensPerSec ?? null,
      peakRssMb: d.peakRssMb ?? null,
      peakGpuUtil: d.peakGpuUtilPercent ?? null,
      inputTokens: metrics?.usage?.totalInputTokens ?? null,
      outputTokens: metrics?.usage?.totalOutputTokens ?? null,
    });
  }
  return rows;
}

function median(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
}

function fmt(v: number | null, digits = 1): string {
  return v === null ? 'n/a' : v.toFixed(digits);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const tsv = args.includes('--tsv');
  const positional = args.filter((a) => !a.startsWith('--'));
  const runsDir = resolve(positional[0] ?? join(here, '..', '..', 'runs'));
  if (!existsSync(runsDir)) {
    console.error(`[perf] no such runs dir: ${runsDir}`);
    process.exit(1);
  }

  const rows = collect(runsDir);
  if (rows.length === 0) {
    console.error(`[perf] no trials with result.json under ${runsDir}`);
    process.exit(1);
  }

  if (tsv) {
    console.log(
      'model\tengine\tscenario\tsuccess\tfailureMode\tdurationMs\tgenTps\tpromptTps\tpeakRssMb\tinTok\toutTok',
    );
    for (const r of rows) {
      console.log(
        [
          r.modelId,
          r.engine,
          r.scenarioId,
          r.success,
          r.failureMode ?? '',
          r.durationMs,
          r.genTps ?? '',
          r.promptTps ?? '',
          r.peakRssMb ?? '',
          r.inputTokens ?? '',
          r.outputTokens ?? '',
        ].join('\t'),
      );
    }
    return;
  }

  const byModel = new Map<string, TrialRow[]>();
  for (const r of rows) {
    const key = `${r.modelId} (${r.engine})`;
    const list = byModel.get(key);
    if (list) list.push(r);
    else byModel.set(key, [r]);
  }

  const summaries = [...byModel.entries()]
    .map(([key, list]) => ({
      key,
      trials: list.length,
      passed: list.filter((r) => r.success).length,
      decode: median(list.map((r) => r.genTps)),
      prefill: median(list.map((r) => r.promptTps)),
      peakRss: Math.max(...list.map((r) => r.peakRssMb ?? 0)) || null,
      medDurationMin: (median(list.map((r) => r.durationMs)) ?? 0) / 60_000,
      totalWallMin: list.reduce((a, r) => a + r.durationMs, 0) / 60_000,
      outTok: list.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
    }))
    // Fastest decode first — the ordering a perf audit reads down.
    .sort((a, b) => (b.decode ?? -1) - (a.decode ?? -1));

  const w = Math.max(28, ...summaries.map((s) => s.key.length + 1));
  console.log(`\nPerformance matrix — ${rows.length} trials under ${runsDir}\n`);
  console.log(
    `${'model (engine)'.padEnd(w)} ${'pass'.padStart(6)} ${'decode t/s'.padStart(11)} ${'prefill t/s'.padStart(12)} ${'peak RSS MB'.padStart(12)} ${'med min'.padStart(8)} ${'total min'.padStart(10)} ${'out tok'.padStart(9)}`,
  );
  console.log('-'.repeat(w + 76));
  for (const s of summaries) {
    console.log(
      `${s.key.padEnd(w)} ${`${s.passed}/${s.trials}`.padStart(6)} ${fmt(s.decode).padStart(11)} ${fmt(s.prefill).padStart(12)} ${fmt(s.peakRss, 0).padStart(12)} ${fmt(s.medDurationMin).padStart(8)} ${fmt(s.totalWallMin).padStart(10)} ${String(s.outTok).padStart(9)}`,
    );
  }

  // Per-scenario decode spread: a scenario whose throughput collapses on
  // every model points at the framework (prompt size, tool-loop churn),
  // not at any one model.
  const byScenario = new Map<string, Array<number | null>>();
  for (const r of rows) {
    const list = byScenario.get(r.scenarioId);
    if (list) list.push(r.genTps);
    else byScenario.set(r.scenarioId, [r.genTps]);
  }
  console.log('\nMedian decode t/s by scenario (all models):\n');
  const sw = Math.max(24, ...[...byScenario.keys()].map((k) => k.length + 1));
  for (const [scenario, tps] of [...byScenario.entries()].sort(
    (a, b) => (median(b[1]) ?? -1) - (median(a[1]) ?? -1),
  )) {
    console.log(`${scenario.padEnd(sw)} ${fmt(median(tps)).padStart(8)}  (n=${tps.length})`);
  }
  console.log('');
}

if (basename(process.argv[1] ?? '') === 'perf-matrix.ts') main();
