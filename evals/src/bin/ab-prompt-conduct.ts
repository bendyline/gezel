/**
 * `pnpm --filter @bendyline/gezel-evals run ab-prompt-conduct [...flags]`
 *
 * A/B harness for standing conduct-prompt content (docs/prompt-stack.md,
 * "Open questions"). Runs the named common-task scenarios twice per
 * model — a CONTROL arm on the profile's default behaviors and a
 * TREATMENT arm with behaviors forced on/off via
 * `GEZEL_FORCE_BEHAVIORS` / `GEZEL_REMOVE_BEHAVIORS` (threaded through
 * `TrialOptions.forceBehaviors` / `removeBehaviors`) — and diffs pass
 * rate, stall-nudge firings, post-turn detector hits, and stall-class
 * failures. The scenario prompts are behavior-blind, so any delta is
 * the prompt content's.
 *
 * Mind the manifest: tier-default behaviors only apply to models whose
 * manifest declares NO `behaviors` array. Bundled models declare
 * explicitly — qwen3.6-27b-q4 already carries
 * `prompt.tool-cookbook-condensed` — so the interesting direction for
 * cataloged models is usually REMOVAL (`--remove <id>`: does the block
 * still earn its tokens?), and force-adding a declared behavior is a
 * no-op that silently converges the arms (the bin refuses this; see
 * `assertTreatmentNotVacuous`). Round-1 noise floor (
 * control-vs-control by accident, 18 scenarios x 1 trial): pass rate
 * identical, stall nudges 7 vs 3, wall-clock 126 vs 132 min — nudge
 * deltas under ~2x at this n are noise.
 *
 * Flags:
 *   --model <id[,id...]>  chat model catalog id(s) (default `qwen3.6-27b-q4`)
 *   --force <id[,id...]>  behavior ids the treatment arm forces ON
 *   --remove <id[,id...]> behavior ids the treatment arm forces OFF
 *   --skip-manifest-check run even if the manifest says an arm is inert
 *   --provider <p>        engine (default `llama-cpp`)
 *   --mlx-source-home <p> MLX weights source home (default `~/.gezel-dev`)
 *   --count <N>           trials per scenario per arm (default 1 — breadth-first;
 *                         extend disputed cells rather than starting wide)
 *   --timeout <dur>       per-trial timeout override, e.g. `30m`
 *   --scenarios <a,b>     subset of scenario ids (default: every named
 *                         registry scenario except the exclusions below)
 *   --runs-dir <path>     override the output root
 *   --list                list the default scenario set and exit
 *
 * Default scenario set = the named `SCENARIOS` registry minus:
 *   - generated `craftbook-*` gallery scenarios (198 of them — a corpus
 *     sweep, not the common-task matrix)
 *   - `arcade-deluxe` (deliberately-hard headroom probe; at n<=3 its
 *     noise swamps a conduct signal)
 *   - `squisq-review`, `fix-squisq-bugs` (external-repo fixtures with
 *     their own long-horizon failure modes)
 *
 * Output: `evals/runs/ab-prompt-conduct-<ts>/<model>/{control,treatment}/`.
 * After each arm the daemon logs are scanned for two stable service
 * markers (see chat/manager.ts):
 *   - `response looks stalled (`        — a continuation/closing/voorman
 *     nudge fired (the model needed a shove after the fact)
 *   - `post-turn detector fired id=`    — a fabrication/etc. detector
 *     caught a bad turn
 * A standing conduct block that WORKS should move these counts down
 * (prevented) faster than it moves pass rate up — same power argument
 * as the craftbook A/B's rejection metric.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { gildeDataDir } from '@bendyline/gezel-catalog';
import { runMatrix } from '../batch.ts';
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { repoRoot } from '../native-bin.ts';
import { slugifyForDirName } from '../runner.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import type { BatchOptions, BatchSummary, EvalScenario } from '../types.ts';
import { parseArgs, parseDuration, printScenarios, resolveProviderFlag } from './args.ts';

const STALL_NUDGE_MARKER = 'response looks stalled (';
const DETECTOR_MARKER = 'post-turn detector fired id=';

/** Failure modes that read as "the model petered out" rather than "it built the wrong thing". */
const STALL_FAILURE_MODES = new Set(['model-stuck', 'chat-stalled', 'no-progress']);

const EXCLUDED_BY_DEFAULT = new Set(['arcade-deluxe', 'squisq-review', 'fix-squisq-bugs']);

type Arm = 'control' | 'treatment';
const ARMS: Arm[] = ['control', 'treatment'];

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

interface TrialMarkers {
  stallNudges: number;
  detectorHits: number;
}

/**
 * Per-trial marker counts across every daemon.log under an arm dir.
 * Keys are `<scenarioId>/<trialId>` so counts roll up per scenario cell.
 */
async function scanMarkers(armDir: string): Promise<Record<string, TrialMarkers>> {
  const perTrial: Record<string, TrialMarkers> = {};
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
    perTrial[dirname(rel)] = {
      stallNudges: countOccurrences(text, STALL_NUDGE_MARKER),
      detectorHits: countOccurrences(text, DETECTOR_MARKER),
    };
  }
  return perTrial;
}

function markersForScenario(
  perTrial: Record<string, TrialMarkers>,
  scenarioId: string,
): TrialMarkers {
  return Object.entries(perTrial)
    .filter(([trialPath]) => trialPath === scenarioId || trialPath.startsWith(`${scenarioId}/`))
    .reduce(
      (acc, [, m]) => ({
        stallNudges: acc.stallNudges + m.stallNudges,
        detectorHits: acc.detectorHits + m.detectorHits,
      }),
      { stallNudges: 0, detectorHits: 0 },
    );
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

function stallFailures(batch: BatchSummary | null): number {
  if (!batch) return 0;
  return batch.perTrial.filter((t) => t.failureMode && STALL_FAILURE_MODES.has(t.failureMode))
    .length;
}

interface CellSummary {
  modelId: string;
  arm: Arm;
  scenarioId: string;
  trials: number;
  successes: number;
  passRate: number;
  stallNudges: number;
  detectorHits: number;
  stallFailures: number;
  meanDurationMs: number;
}

interface ArmSummary {
  modelId: string;
  arm: Arm;
  runsDir: string;
  totalTrials: number;
  totalSuccesses: number;
  passRate: number;
  stallNudges: number;
  detectorHits: number;
  stallFailures: number;
  markersPerTrial: Record<string, TrialMarkers>;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function parseIdList(flag: unknown): string[] {
  return typeof flag === 'string'
    ? flag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function defaultScenarios(): EvalScenario[] {
  return Object.values(SCENARIOS).filter(
    (s) => !s.id.startsWith('craftbook-') && !EXCLUDED_BY_DEFAULT.has(s.id),
  );
}

/**
 * Behavior ids the model's bundled root manifest declares, or null when
 * the model isn't in the bundled catalog (third-party import — can't
 * check). Entries may be `string | { id, config }`.
 */
async function declaredBehaviorIds(modelId: string): Promise<string[] | null> {
  const manifestPath = join(
    gildeDataDir(),
    'chat-models',
    modelId.slice(0, 2),
    modelId,
    'manifest.json',
  );
  try {
    const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      behaviors?: Array<string | { id?: string }>;
    };
    if (!Array.isArray(raw.behaviors)) return [];
    return raw.behaviors
      .map((b) => (typeof b === 'string' ? b : (b?.id ?? '')))
      .filter((id) => id.length > 0);
  } catch {
    return null;
  }
}

/**
 * Refuse arms that provably converge. Wild-caught: forcing
 * `prompt.tool-cookbook-condensed` on qwen3.6-27b-q4 was a no-op because
 * the manifest already declares it — tier defaults only apply to
 * manifest-less models — so 36 trials ran control-vs-control. Forcing a
 * declared behavior is always inert (`applyBehaviorEnvOverrides` skips
 * already-present ids); removing an undeclared one is inert unless the
 * behavior arrives via universal/tier defaults, so that direction only
 * warns. `--skip-manifest-check` bypasses (e.g. deliberately targeting
 * a universal default).
 */
async function assertTreatmentNotVacuous(
  models: string[],
  forceBehaviors: string[],
  removeBehaviors: string[],
): Promise<void> {
  for (const modelId of models) {
    const declared = await declaredBehaviorIds(modelId);
    if (declared === null) {
      console.log(`[ab] ${modelId}: not in the bundled catalog — manifest check skipped`);
      continue;
    }
    const inertForce = forceBehaviors.filter((id) => declared.includes(id));
    if (inertForce.length > 0) {
      throw new Error(
        `treatment arm is inert for ${modelId}: --force [${inertForce.join(', ')}] already declared by its manifest (behaviors: [${declared.join(', ')}]). Forcing a declared behavior is a no-op — the arms would converge. Did you mean --remove? (--skip-manifest-check to override)`,
      );
    }
    const unmatchedRemove = removeBehaviors.filter((id) => !declared.includes(id));
    for (const id of unmatchedRemove) {
      console.warn(
        `[ab] WARNING ${modelId}: --remove ${id} is not in the manifest — only effective if the behavior arrives via universal/tier defaults; check the daemon log for the "[model-profile] GEZEL_REMOVE_BEHAVIORS" no-op warning after the first treatment trial.`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.list) {
    printScenarios(defaultScenarios());
    return;
  }

  const scenarioFilter = parseIdList(args.flags.scenarios);
  const scenarios: EvalScenario[] = (
    scenarioFilter.length > 0
      ? scenarioFilter.map((id) => {
          const scenario = SCENARIOS[id];
          if (!scenario) {
            const known = Object.keys(SCENARIOS)
              .filter((k) => !k.startsWith('craftbook-'))
              .join(', ');
            throw new Error(`unknown scenario "${id}". Known (named): ${known}`);
          }
          return scenario;
        })
      : defaultScenarios()
  ).map((scenario) => {
    // Some scenarios declare `suggestedTrials: 1` as a matrix-cost cap —
    // this bin is the deliberate experiment, so `--count` wins.
    const { suggestedTrials: _suggestedTrials, ...rest } = scenario;
    return rest;
  });

  const forceBehaviors = parseIdList(args.flags.force);
  const removeBehaviors = parseIdList(args.flags.remove);
  if (forceBehaviors.length === 0 && removeBehaviors.length === 0) {
    throw new Error(
      'the treatment arm needs at least one of --force <behavior-ids> / --remove <behavior-ids> ' +
        '(e.g. --force prompt.tool-cookbook-condensed)',
    );
  }

  const models = ((args.flags.model as string) || 'qwen3.6-27b-q4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!args.flags['skip-manifest-check']) {
    await assertTreatmentNotVacuous(models, forceBehaviors, removeBehaviors);
  }
  const engine = resolveProviderFlag(args.flags) ?? 'llama-cpp';
  const count = args.flags.count ? Number(args.flags.count) : 1;
  const timeoutMs = args.flags.timeout ? parseDuration(String(args.flags.timeout)) : undefined;
  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine, scenarios });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rootFlag = args.flags['runs-dir'] as string | undefined;
  const root = rootFlag
    ? isAbsolute(rootFlag)
      ? rootFlag
      : join(repoRoot(), rootFlag)
    : join(repoRoot(), 'evals', 'runs', `ab-prompt-conduct-${ts}`);
  await mkdir(root, { recursive: true });

  const ac = installSignalHandlers();
  console.log(
    `[ab] models=[${models.join(', ')}] engine=${engine} count=${count} ` +
      `scenarios=${scenarios.length}\n` +
      `[ab] treatment: force=[${forceBehaviors.join(', ')}] remove=[${removeBehaviors.join(', ')}]\n` +
      `[ab] root=${root}`,
  );

  const cells: CellSummary[] = [];
  const arms: ArmSummary[] = [];

  // Arms are sequential and interleaved per model (control then treatment
  // for model 1, then model 2) so machine-level drift hits both arms of a
  // model equally. Two local engines at once would cross-saturate
  // RAM/VRAM and the pass rates would lie.
  for (const modelId of models) {
    for (const arm of ARMS) {
      if (ac.signal.aborted) break;
      const armDir = join(root, slugifyForDirName(modelId), arm);
      console.log(`\n[ab] ===== ${modelId} / arm=${arm} =====`);
      const baseOpts: BatchOptions = {
        modelId,
        engine,
        count,
        timeoutMs,
        signal: ac.signal,
        runsDir: armDir,
        ...(args.flags['mlx-source-home']
          ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
          : {}),
        ...(arm === 'treatment'
          ? {
              ...(forceBehaviors.length > 0 ? { forceBehaviors } : {}),
              ...(removeBehaviors.length > 0 ? { removeBehaviors } : {}),
            }
          : {}),
      };
      const matrix = await runMatrix(scenarios, baseOpts);
      const markersPerTrial = await scanMarkers(armDir);

      let armStallFailures = 0;
      for (const scenario of scenarios) {
        const row = matrix.scenarios.find((s) => s.scenarioId === scenario.id);
        const batch = await readBatchSummary(armDir, scenario.id);
        const markers = markersForScenario(markersPerTrial, scenario.id);
        const cellStallFailures = stallFailures(batch);
        armStallFailures += cellStallFailures;
        cells.push({
          modelId,
          arm,
          scenarioId: scenario.id,
          trials: row?.trials ?? 0,
          successes: row?.successes ?? 0,
          passRate: row?.successRate ?? 0,
          stallNudges: markers.stallNudges,
          detectorHits: markers.detectorHits,
          stallFailures: cellStallFailures,
          meanDurationMs: meanDurationMs(batch),
        });
      }
      const armMarkers = Object.values(markersPerTrial).reduce(
        (acc, m) => ({
          stallNudges: acc.stallNudges + m.stallNudges,
          detectorHits: acc.detectorHits + m.detectorHits,
        }),
        { stallNudges: 0, detectorHits: 0 },
      );
      arms.push({
        modelId,
        arm,
        runsDir: armDir,
        totalTrials: matrix.totalTrials,
        totalSuccesses: matrix.totalSuccesses,
        passRate: matrix.overallSuccessRate,
        stallNudges: armMarkers.stallNudges,
        detectorHits: armMarkers.detectorHits,
        stallFailures: armStallFailures,
        markersPerTrial,
      });
    }
    if (ac.signal.aborted) break;
  }

  const byArm = ARMS.map((arm) => {
    const armRows = arms.filter((a) => a.arm === arm);
    const totalTrials = armRows.reduce((acc, a) => acc + a.totalTrials, 0);
    const totalSuccesses = armRows.reduce((acc, a) => acc + a.totalSuccesses, 0);
    return {
      arm,
      totalTrials,
      totalSuccesses,
      passRate: totalTrials === 0 ? 0 : totalSuccesses / totalTrials,
      stallNudges: armRows.reduce((acc, a) => acc + a.stallNudges, 0),
      detectorHits: armRows.reduce((acc, a) => acc + a.detectorHits, 0),
      stallFailures: armRows.reduce((acc, a) => acc + a.stallFailures, 0),
    };
  });

  const control = byArm.find((a) => a.arm === 'control');
  const treatment = byArm.find((a) => a.arm === 'treatment');
  const summary = {
    models,
    engine,
    count,
    forceBehaviors,
    removeBehaviors,
    scenarios: scenarios.map((s) => s.id),
    markers: { stallNudge: STALL_NUDGE_MARKER, detector: DETECTOR_MARKER },
    startedAt: ts,
    finishedAt: new Date().toISOString(),
    aborted: ac.signal.aborted,
    cells,
    arms,
    byArm,
    overallDelta: (treatment?.passRate ?? 0) - (control?.passRate ?? 0),
  };
  await writeFile(join(root, 'ab-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n[ab] ===== PROMPT CONDUCT A/B RESULT =====');
  console.log(
    `  ${'model'.padEnd(20)} ${'scenario'.padEnd(26)} ${'ctrl'.padStart(7)} ${'treat'.padStart(7)} ${'Δ(t-c)'.padStart(8)} ${'nudge c/t'.padStart(10)} ${'detect c/t'.padStart(11)} ${'stallF c/t'.padStart(11)}`,
  );
  for (const modelId of models) {
    for (const scenario of scenarios) {
      const c = cells.find(
        (x) => x.modelId === modelId && x.arm === 'control' && x.scenarioId === scenario.id,
      );
      const t = cells.find(
        (x) => x.modelId === modelId && x.arm === 'treatment' && x.scenarioId === scenario.id,
      );
      const delta = (t?.passRate ?? 0) - (c?.passRate ?? 0);
      const d = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}%`;
      console.log(
        `  ${modelId.padEnd(20)} ${scenario.id.padEnd(26)} ${pct(c?.passRate ?? 0).padStart(7)} ${pct(t?.passRate ?? 0).padStart(7)} ${d.padStart(8)} ${`${c?.stallNudges ?? 0}/${t?.stallNudges ?? 0}`.padStart(10)} ${`${c?.detectorHits ?? 0}/${t?.detectorHits ?? 0}`.padStart(11)} ${`${c?.stallFailures ?? 0}/${t?.stallFailures ?? 0}`.padStart(11)}`,
      );
    }
  }
  console.log(
    `  ${'OVERALL'.padEnd(20)} ${''.padEnd(26)} ${pct(control?.passRate ?? 0).padStart(7)} ${pct(treatment?.passRate ?? 0).padStart(7)} ${`${summary.overallDelta >= 0 ? '+' : ''}${(summary.overallDelta * 100).toFixed(0)}%`.padStart(8)} ${`${control?.stallNudges ?? 0}/${treatment?.stallNudges ?? 0}`.padStart(10)} ${`${control?.detectorHits ?? 0}/${treatment?.detectorHits ?? 0}`.padStart(11)} ${`${control?.stallFailures ?? 0}/${treatment?.stallFailures ?? 0}`.padStart(11)}`,
  );
  console.log(`\n[ab] wrote ${join(root, 'ab-summary.json')}`);
  deviceLock?.release();
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('[ab] fatal:', err);
  process.exit(1);
});
