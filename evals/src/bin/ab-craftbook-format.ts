/**
 * `pnpm --filter @bendyline/gezel-evals run ab-craftbook-format [...flags]`
 *
 * A/B harness for the Craftbooks V2 whole-document format: runs the four
 * craftbook AUTHORING scenarios twice per model — once with the daemon's
 * document codec forced to `json`, once forced to `md` — and diffs them.
 * The entire toggle is `GEZEL_CRAFTBOOK_DOC_FORMAT`, threaded through
 * `TrialOptions.craftbookDocFormat` (see `evalDaemonEnvForTrial`); it
 * picks the default codec AND the format the `craftbook_write` /
 * `craftbook_read` tool descriptions advertise. The scenario prompts are
 * format-blind, so any pass-rate delta is the codec's.
 *
 * Flags:
 *   --model <id[,id...]>  chat model catalog id(s) (default `qwen3.5-4b-q4`)
 *   --provider <p>        engine (default `llama-cpp`)
 *   --count <N>           trials per scenario per arm (default 5)
 *   --timeout <dur>       per-trial timeout override, e.g. `30m`
 *   --scenarios <a,b>     subset of the authoring scenario ids
 *   --runs-dir <path>     override the output root
 *   --list                list the authoring scenarios and exit
 *
 * Output: `evals/runs/ab-craftbook-format-<ts>/<model>/{json,md}/` (per-arm
 * matrices; arms are interleaved per model — json then md for model 1,
 * then model 2 — so a machine-level drift hits both arms of a model
 * equally). After each arm the daemon logs are scanned for the service's
 * stable rejection marker (`[craftbook-doc] validation rejected`) so the
 * summary shows not just WHETHER a format wins but how often the model's
 * documents bounced off validation. `ab-summary.json` holds per-cell
 * (format × model × scenario) pass rate, malformed-rejection counts, and
 * mean duration, plus arm rollups.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { runMatrix } from '../batch.ts';
import { CRAFTBOOK_AUTHORING_SCENARIOS } from '../craftbooks/authoring/index.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { slugifyForDirName } from '../runner.ts';
import type { BatchOptions, BatchSummary, EvalScenario } from '../types.ts';
import { parseArgs, parseDuration, printScenarios, resolveProviderFlag } from './args.ts';

/** The service's stable one-line marker for a rejected craftbook document. */
const REJECTION_MARKER = '[craftbook-doc] validation rejected';

type DocFormat = 'json' | 'md';
const FORMATS: DocFormat[] = ['json', 'md'];

function installSignalHandlers(): AbortController {
  const ac = new AbortController();
  let firstHit = false;
  const handler = (sig: NodeJS.Signals) => {
    if (!firstHit) {
      firstHit = true;
      console.error(`\n[ab] ${sig} received — aborting gracefully (Ctrl+C again to force-exit)`);
      ac.abort();
    } else {
      console.error('[ab] second signal — forcing exit');
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return ac;
}

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return n;
}

/**
 * Per-trial rejection-marker counts across every daemon.log under an arm
 * dir. Keys are `<scenarioId>/<trialId>` (the daemon.log's parent path
 * relative to the arm root), so counts roll up per scenario cell.
 */
async function scanRejections(armDir: string): Promise<Record<string, number>> {
  const perTrial: Record<string, number> = {};
  let entries: string[] = [];
  try {
    entries = await readdir(armDir, { recursive: true });
  } catch {
    return perTrial;
  }
  for (const rel of entries) {
    if (!rel.endsWith('daemon.log')) continue;
    let text = '';
    try {
      text = await readFile(join(armDir, rel), 'utf8');
    } catch {
      continue;
    }
    perTrial[dirname(rel)] = countOccurrences(text, REJECTION_MARKER);
  }
  return perTrial;
}

/** Sum the rejection counts whose trial path lives under `<scenarioId>/`. */
function rejectionsForScenario(perTrial: Record<string, number>, scenarioId: string): number {
  return Object.entries(perTrial)
    .filter(([trialPath]) => trialPath === scenarioId || trialPath.startsWith(`${scenarioId}/`))
    .reduce((acc, [, count]) => acc + count, 0);
}

async function readBatchSummary(armDir: string, scenarioId: string): Promise<BatchSummary | null> {
  try {
    const raw = await readFile(join(armDir, scenarioId, 'summary.json'), 'utf8');
    return JSON.parse(raw) as BatchSummary;
  } catch {
    return null;
  }
}

function meanDurationMs(batch: BatchSummary | null): number {
  if (!batch || batch.perTrial.length === 0) return 0;
  const total = batch.perTrial.reduce((acc, trial) => acc + trial.durationMs, 0);
  return Math.round(total / batch.perTrial.length);
}

interface CellSummary {
  modelId: string;
  format: DocFormat;
  scenarioId: string;
  trials: number;
  successes: number;
  passRate: number;
  malformedRejections: number;
  meanDurationMs: number;
}

interface ArmSummary {
  modelId: string;
  format: DocFormat;
  runsDir: string;
  totalTrials: number;
  totalSuccesses: number;
  passRate: number;
  malformedRejections: number;
  /** `<scenarioId>/<trialId>` → rejection-marker count in that trial's daemon.log. */
  rejectionsPerTrial: Record<string, number>;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allScenarios = Object.values(CRAFTBOOK_AUTHORING_SCENARIOS);
  if (args.flags.list) {
    printScenarios(allScenarios);
    return;
  }

  const scenarioFilter =
    typeof args.flags.scenarios === 'string'
      ? args.flags.scenarios
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
  const scenarios: EvalScenario[] = (
    scenarioFilter
      ? scenarioFilter.map((id) => {
          const scenario = CRAFTBOOK_AUTHORING_SCENARIOS[id];
          if (!scenario) {
            const known = Object.keys(CRAFTBOOK_AUTHORING_SCENARIOS).join(', ');
            throw new Error(`unknown authoring scenario "${id}". Known: ${known}`);
          }
          return scenario;
        })
      : allScenarios
  ).map((scenario) => {
    // The authoring scenarios declare `suggestedTrials: 1` so an ad-hoc
    // matrix run treats them as cost-capped canaries — but THIS bin is
    // the deliberate deep-dive, so strip the cap and honor `--count`.
    const { suggestedTrials: _suggestedTrials, ...rest } = scenario;
    return rest;
  });

  const models = ((args.flags.model as string) || 'qwen3.5-4b-q4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const engine = resolveProviderFlag(args.flags) ?? 'llama-cpp';
  const count = args.flags.count ? Number(args.flags.count) : 5;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-craftbook-format-${ts}`);
  await mkdir(root, { recursive: true });

  const ac = installSignalHandlers();
  console.log(
    `[ab] models=[${models.join(', ')}] engine=${engine} count=${count} ` +
      `scenarios=${scenarios.length}\n[ab] root=${root}`,
  );

  const cells: CellSummary[] = [];
  const arms: ArmSummary[] = [];

  // Interleaved per model: json arm then md arm for model 1, then model 2.
  // Arms are sequential — two local engines at once would cross-saturate
  // RAM/VRAM and the pass rates would lie.
  for (const modelId of models) {
    for (const format of FORMATS) {
      if (ac.signal.aborted) break;
      const armDir = join(root, slugifyForDirName(modelId), format);
      console.log(`\n[ab] ===== ${modelId} / format=${format} =====`);
      const baseOpts: BatchOptions = {
        modelId,
        engine,
        count,
        timeoutMs,
        signal: ac.signal,
        craftbookDocFormat: format,
        runsDir: armDir,
      };
      const matrix = await runMatrix(scenarios, baseOpts);
      const rejectionsPerTrial = await scanRejections(armDir);

      for (const scenario of scenarios) {
        const row = matrix.scenarios.find((s) => s.scenarioId === scenario.id);
        const batch = await readBatchSummary(armDir, scenario.id);
        cells.push({
          modelId,
          format,
          scenarioId: scenario.id,
          trials: row?.trials ?? 0,
          successes: row?.successes ?? 0,
          passRate: row?.successRate ?? 0,
          malformedRejections: rejectionsForScenario(rejectionsPerTrial, scenario.id),
          meanDurationMs: meanDurationMs(batch),
        });
      }
      arms.push({
        modelId,
        format,
        runsDir: armDir,
        totalTrials: matrix.totalTrials,
        totalSuccesses: matrix.totalSuccesses,
        passRate: matrix.overallSuccessRate,
        malformedRejections: Object.values(rejectionsPerTrial).reduce((a, b) => a + b, 0),
        rejectionsPerTrial,
      });
    }
    if (ac.signal.aborted) break;
  }

  // Per-format rollup across all models.
  const byFormat = FORMATS.map((format) => {
    const formatArms = arms.filter((arm) => arm.format === format);
    const totalTrials = formatArms.reduce((acc, arm) => acc + arm.totalTrials, 0);
    const totalSuccesses = formatArms.reduce((acc, arm) => acc + arm.totalSuccesses, 0);
    return {
      format,
      totalTrials,
      totalSuccesses,
      passRate: totalTrials === 0 ? 0 : totalSuccesses / totalTrials,
      malformedRejections: formatArms.reduce((acc, arm) => acc + arm.malformedRejections, 0),
    };
  });

  const jsonRollup = byFormat.find((f) => f.format === 'json');
  const mdRollup = byFormat.find((f) => f.format === 'md');
  const summary = {
    models,
    engine,
    count,
    scenarios: scenarios.map((s) => s.id),
    rejectionMarker: REJECTION_MARKER,
    startedAt: ts,
    finishedAt: new Date().toISOString(),
    aborted: ac.signal.aborted,
    cells,
    arms,
    byFormat,
    overallDelta: (mdRollup?.passRate ?? 0) - (jsonRollup?.passRate ?? 0),
  };
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify(summary, null, 2));

  // Report.
  console.log('\n[ab] ===== CRAFTBOOK FORMAT A/B RESULT =====');
  console.log(
    `  ${'model'.padEnd(24)} ${'scenario'.padEnd(28)} ${'json'.padStart(8)} ${'md'.padStart(8)} ${'Δ(md-json)'.padStart(11)} ${'rej j/m'.padStart(9)}`,
  );
  for (const modelId of models) {
    for (const scenario of scenarios) {
      const jsonCell = cells.find(
        (c) => c.modelId === modelId && c.format === 'json' && c.scenarioId === scenario.id,
      );
      const mdCell = cells.find(
        (c) => c.modelId === modelId && c.format === 'md' && c.scenarioId === scenario.id,
      );
      const delta = (mdCell?.passRate ?? 0) - (jsonCell?.passRate ?? 0);
      const d = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
      console.log(
        `  ${modelId.padEnd(24)} ${scenario.id.padEnd(28)} ${pct(jsonCell?.passRate ?? 0).padStart(8)} ${pct(mdCell?.passRate ?? 0).padStart(8)} ${d.padStart(11)} ${`${jsonCell?.malformedRejections ?? 0}/${mdCell?.malformedRejections ?? 0}`.padStart(9)}`,
      );
    }
  }
  console.log(
    `  ${'OVERALL'.padEnd(24)} ${''.padEnd(28)} ${pct(jsonRollup?.passRate ?? 0).padStart(8)} ${pct(mdRollup?.passRate ?? 0).padStart(8)} ${`${summary.overallDelta >= 0 ? '+' : ''}${(summary.overallDelta * 100).toFixed(1)}%`.padStart(11)} ${`${jsonRollup?.malformedRejections ?? 0}/${mdRollup?.malformedRejections ?? 0}`.padStart(9)}`,
  );
  console.log(`\n[ab] wrote ${join(root, 'ab-summary.json')}`);
  deviceLock?.release();
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('[ab] fatal:', err);
  process.exit(1);
});
