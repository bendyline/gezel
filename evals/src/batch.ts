import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DeviceHealthGate, createSystemDeviceHealthProbe } from '@bendyline/gezel/native';
import { repoRoot } from './native-bin.ts';
import { ensurePreflightAdmission, formatPreflightFailure } from './preflight.ts';
import { isLocalEngine } from './providers.ts';
import { runTrial } from './runner.ts';
import { formatPassClaim } from './stats-discipline.ts';
import { detectTriageCluster, trialSignature } from './trial-signature.ts';
import type {
  BatchOptions,
  BatchPreflight,
  BatchSummary,
  EvalScenario,
  MatrixSummary,
  TrialOptions,
  TrialResult,
} from './types.ts';

/**
 * A daemon-boot spawn timeout is unambiguously infrastructure, never a
 * model result: `runTrial` finalizes it with `failureMode: 'spawn-error'`
 * and a `daemon spawn failed:` reason (and no daemon.log — the daemon
 * never booted). The usual cause is a native image server (`sd-server`,
 * Metal/RAM) from the *previous* trial still draining past the next
 * daemon's boot window (wild-caught: `tankcombat` spawn-timed
 * out immediately after `petshop`'s SDXL run, then PASSed standalone).
 *
 * Other `spawn-error` reasons — auth probe, missing binary, warm-cache —
 * are deterministic, so they're left alone (retrying just burns a second
 * trial / cloud quota to fail again).
 */
function isRetriableSpawnTimeout(result: TrialResult): boolean {
  return result.failureMode === 'spawn-error' && result.reason.startsWith('daemon spawn failed:');
}

/**
 * Settle delay before a spawn-timeout retry, to let the prior trial's
 * native servers finish draining Metal/RAM. Overridable via
 * `GEZEL_EVAL_SPAWN_RETRY_SETTLE_MS` (tests set it to 0).
 */
function spawnRetrySettleMs(): number {
  const raw = Number(process.env.GEZEL_EVAL_SPAWN_RETRY_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

/**
 * Auto-triage threshold k (Theme E / E2): stop a cell once this many
 * *consecutive* trials fail with an identical `trialSignature`. `0`
 * disables. Precedence: explicit `opts.triageK` (flag/test) ›
 * `GEZEL_EVAL_TRIAGE_K` env › default 3. k=3 because two consecutive
 * fails is normal model variance, but three *identical deterministic*
 * failures is a plateau — and trials cost minutes-to-hours, so cut sooner
 * than the product's in-trial `score≥4` repair ladder.
 */
const DEFAULT_TRIAGE_K = 3;
function resolveTriageK(opts: BatchOptions): number {
  if (typeof opts.triageK === 'number' && Number.isFinite(opts.triageK)) {
    return Math.max(0, Math.floor(opts.triageK));
  }
  const raw = Number(process.env.GEZEL_EVAL_TRIAGE_K);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_TRIAGE_K;
}

/**
 * Run one trial, retrying exactly once if it dies on a daemon-boot spawn
 * timeout (see {@link isRetriableSpawnTimeout}). A brief settle precedes
 * the retry so the previous trial's native servers have time to release
 * Metal/RAM. Honors `signal` — an abort between attempts returns the first
 * (failed) result rather than starting a second trial.
 */
async function runTrialWithSpawnRetry(
  scenario: EvalScenario,
  opts: TrialOptions,
): Promise<TrialResult> {
  const first = await runTrial(scenario, opts);
  if (!isRetriableSpawnTimeout(first) || opts.signal?.aborted) return first;
  const settleMs = spawnRetrySettleMs();
  // eslint-disable-next-line no-console
  console.log(
    `[batch] trial ${first.trialId} hit a daemon-spawn timeout (infra — daemon never booted, no model involvement); settling ${settleMs}ms then retrying once`,
  );
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  if (opts.signal?.aborted) return first;
  const second = await runTrial(scenario, opts);
  // eslint-disable-next-line no-console
  console.log(
    isRetriableSpawnTimeout(second)
      ? '[batch] spawn-timeout retry also failed to boot the daemon — recording the failure'
      : `[batch] spawn-timeout retry booted cleanly (${second.success ? 'PASS' : 'FAIL'})`,
  );
  return second;
}

function batchDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(repoRoot(), 'evals', 'runs', `batch-${ts}`);
}

function matrixDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(repoRoot(), 'evals', 'runs', `matrix-${ts}`);
}

/**
 * Resolve a caller-supplied `--runs-dir`. An absolute path is used
 * verbatim; a RELATIVE path is resolved against the repo root, NOT the
 * process cwd. The bins run under the `evals/` package dir (pnpm
 * --filter), so a natural `--runs-dir evals/runs/foo` would otherwise
 * land at `evals/evals/runs/foo`. Falls back to the default dir factory
 * when unset.
 */
function resolveRunsDir(runsDir: string | undefined, fallback: () => string): string {
  if (!runsDir) return fallback();
  return isAbsolute(runsDir) ? runsDir : join(repoRoot(), runsDir);
}

/**
 * Run N trials of `scenario`. Trials are sequential by default — each
 * trial spawns its own llama-server, and running >1 large model
 * concurrently saturates RAM/VRAM on most dev boxes. Set `parallel: K`
 * to opt in.
 *
 * Always returns a summary with whatever trials completed before a
 * fatal error in the orchestrator itself; per-trial failures (timeout,
 * sniff fail, crash) are recorded in `perTrial` rather than aborting
 * the batch.
 */
export async function runBatch(scenario: EvalScenario, opts: BatchOptions): Promise<BatchSummary> {
  const startedAt = new Date();
  const runsDir = resolveRunsDir(opts.runsDir, batchDir);
  await mkdir(runsDir, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`[batch] scenario=${scenario.id} count=${opts.count} runsDir=${runsDir}`);

  // Per-model admission gate (local engines only — cloud providers have
  // the auth probe in runTrial). One probe trial, cached 24h on pass, so
  // a matrix run pays it once. A model that can't clear capacity /
  // tool-call / profile / reasoning-budget / throughput checks fails THE
  // BATCH here in minutes instead of burning `count` full trials — the
  // deepseek-r1 (19 trials), mistral-medium (19), and nemotron-super
  // sagas were each exactly this class.
  const engine = opts.engine ?? 'llama-cpp';
  // Record preflight provenance (Theme E / E4) so the summary shows whether
  // this sweep was admission-checked and, when not, why. A non-admitted
  // local preflight still throws (the loudest possible signal).
  let preflight: BatchPreflight;
  if (opts.skipPreflight) {
    preflight = { ran: false, skippedReason: 'flag' };
  } else if (!isLocalEngine(engine)) {
    // Cloud/CLI engines lean on the per-trial auth probe in runTrial.
    preflight = { ran: false, skippedReason: 'non-local-engine' };
  } else {
    const report = await ensurePreflightAdmission({
      modelId: opts.modelId,
      engine,
      ...(opts.mlxSourceHome ? { mlxSourceHome: opts.mlxSourceHome } : {}),
      ...(opts.cacheRoot ? { cacheRoot: opts.cacheRoot } : {}),
      ...(opts.llamaBin ? { llamaBin: opts.llamaBin } : {}),
      // eslint-disable-next-line no-console
      log: (line) => console.log(line),
    });
    if (!report.admitted) {
      throw new Error(formatPreflightFailure(report));
    }
    preflight = { ran: true, admitted: report.admitted, genTokensPerSec: report.genTokensPerSec };
  }

  // The probe's measured throughput scales each scenario's authored hard
  // ceiling for this model/host pair, so a slow model isn't failed on wall
  // clock while making real progress. An explicit `--timeout` still wins;
  // see `throughputScaledMaxDurationMs`. Caller-supplied rates (A/B drivers
  // that skip preflight) are respected over the probe's.
  const measuredDecodeRate =
    opts.decodeRateTokensPerSec === undefined && preflight.genTokensPerSec != null
      ? { decodeRateTokensPerSec: preflight.genTokensPerSec }
      : {};

  const parallel = Math.max(1, opts.parallel ?? 1);
  const results: TrialResult[] = [];

  // Auto-triage streak (Theme E / E2): the running length of consecutive
  // trials that failed with the same `trialSignature`. Maintained only at
  // parallel===1, where "consecutive" is well-defined — at higher
  // parallelism the chunk's trials overlap in time and can't be cleanly
  // stopped mid-flight, so we report the cluster post-hoc but never skip.
  const triageK = resolveTriageK(opts);
  const triageActive = parallel === 1 && triageK > 0;
  let streakSig: string | null = null;
  let streakLen = 0;

  // Sequential parallel-batched: process trials in chunks of size `parallel`.
  // For parallel === 1 this collapses to a normal sequential loop.
  for (let i = 0; i < opts.count; i += parallel) {
    if (opts.signal?.aborted) {
      // eslint-disable-next-line no-console
      console.log(`[batch] aborted before trial ${i + 1}/${opts.count}; no more trials will start`);
      break;
    }
    const chunk = Array.from({ length: Math.min(parallel, opts.count - i) }, (_, k) => i + k);
    const settled = await Promise.allSettled(
      chunk.map((idx) => {
        const perTrialOpts = { ...opts, runsDir, ...measuredDecodeRate };
        // eslint-disable-next-line no-console
        console.log(`[batch] starting trial ${idx + 1}/${opts.count}`);
        return runTrialWithSpawnRetry(scenario, perTrialOpts);
      }),
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
        // Update the triage streak on push (not from results[last]): a
        // rejected promise never pushes, so it can't spuriously extend a
        // streak. Signature is read from the post-spawn-retry result, so
        // each trial index contributes exactly one entry.
        if (triageActive) {
          const sig = trialSignature(s.value);
          if (sig === null) {
            streakSig = null;
            streakLen = 0;
          } else if (sig === streakSig) {
            streakLen += 1;
          } else {
            streakSig = sig;
            streakLen = 1;
          }
        }
      } else {
        // runTrial is supposed to return a result rather than throw, but
        // catch the unexpected here so a single rejected promise can't
        // poison the whole batch.
        // eslint-disable-next-line no-console
        console.error('[batch] trial promise rejected:', s.reason);
      }
    }
    if (opts.signal?.aborted) {
      // eslint-disable-next-line no-console
      console.log('[batch] abort observed after trial completion; stopping batch');
      break;
    }
    // Auto-triage break (Theme E / E2) — strictly AFTER the abort check so
    // an operator Ctrl-C always wins. k identical consecutive failures =
    // a deterministic plateau (or a deterministically broken box, for
    // repeated infra); skip the rest of THIS cell and surface the cluster.
    // `runMatrix` keeps going to the next scenario.
    if (triageActive && streakSig !== null && streakLen >= triageK) {
      // eslint-disable-next-line no-console
      console.log(
        `[batch] AUTO-TRIAGE: ${streakLen} consecutive trials of ${scenario.id}×${opts.modelId} died with identical signature "${streakSig}" (k=${triageK}); skipping remaining ${opts.count - results.length} trial(s)`,
      );
      break;
    }
  }

  const finishedAt = new Date();
  const successes = results.filter((r) => r.success).length;
  // A parallel>1 cell never early-stops, so a cluster there is
  // reported-only (stopped:false, skipped:0). At parallel===1 the streak
  // that broke the loop and the post-hoc scan agree by construction.
  const triage = detectTriageCluster(results, triageK, {
    stopped: triageActive && streakSig !== null && streakLen >= triageK,
    requestedCount: opts.count,
  });
  const hasFullCoverage = results.length === opts.count || triage?.stopped === true;
  const status: BatchSummary['status'] = opts.signal?.aborted
    ? 'interrupted'
    : results.length === 0 || !hasFullCoverage
      ? 'incomplete'
      : 'complete';
  const summary: BatchSummary = {
    scenarioId: scenario.id,
    modelId: opts.modelId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    status,
    requestedTrials: opts.count,
    trials: results.length,
    successes,
    successRate: results.length === 0 ? 0 : successes / results.length,
    trialIds: results.map((r) => r.trialId),
    perTrial: results.map((r) => ({
      trialId: r.trialId,
      success: r.success,
      durationMs: r.durationMs,
      reason: r.reason,
      ...(r.failureMode ? { failureMode: r.failureMode } : {}),
    })),
    preflight,
    ...(triage ? { triage } : {}),
  };

  await writeFile(join(runsDir, 'summary.json'), JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `[batch] ${status} — ${formatPassClaim(successes, results.length)}${results.length === opts.count ? '' : `; ${results.length}/${opts.count} requested trials recorded`}`,
  );
  if (triage) {
    // eslint-disable-next-line no-console
    console.log(
      `[batch] TRIAGE ${scenario.id}×${opts.modelId} signature="${triage.signature}" count=${triage.count} k=${triage.k} skipped=${triage.skipped} stopped=${triage.stopped} trials=${triage.trialIds.join(',')} reason=${JSON.stringify(triage.representativeReason)}`,
    );
  }
  return summary;
}

/**
 * A green batch requires complete requested coverage, at least one observed
 * trial, and no failures. The status check prevents both `0 === 0` and a
 * passing prefix from an aborted/rejected run from producing exit code 0.
 */
export function isSuccessfulBatch(batch: BatchSummary): boolean {
  return batch.status === 'complete' && batch.trials > 0 && batch.successes === batch.trials;
}

/**
 * Run `count` trials of every scenario in `scenarios`. Each scenario
 * gets its own per-batch sub-directory under the matrix root, with the
 * familiar `summary.json` + per-trial dirs that single-scenario tooling
 * already understands. The matrix root holds an aggregate summary on
 * top — one number per scenario plus a cross-scenario success rate.
 *
 * Layout:
 *
 *   evals/runs/matrix-<ts>/
 *   ├── summary.json                    ← MatrixSummary
 *   ├── tictactoe/
 *   │   ├── summary.json                ← BatchSummary
 *   │   ├── tictactoe-<ts>-aaaa/        ← per-trial output (log.txt, etc.)
 *   │   └── tictactoe-<ts>-bbbb/
 *   └── petshop/
 *       ├── summary.json
 *       └── petshop-<ts>-cccc/
 *
 * Scenarios run sequentially — even when `parallel: K` is set on a
 * single batch, two scenarios concurrently would still cross-saturate
 * VRAM and the per-scenario success rate would lie. `parallel` only
 * applies *within* a single scenario's batch.
 */
export async function runMatrix(
  scenarios: EvalScenario[],
  opts: BatchOptions,
): Promise<MatrixSummary> {
  if (scenarios.length === 0) {
    throw new Error('runMatrix requires at least one scenario');
  }
  const startedAt = new Date();
  const root = resolveRunsDir(opts.runsDir, matrixDir);
  await mkdir(root, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(
    `[matrix] scenarios=${scenarios.map((s) => s.id).join(',')} count=${opts.count} runsDir=${root}`,
  );

  const capTrials = (scenario: EvalScenario): number =>
    opts.countStrict ? opts.count : Math.min(opts.count, scenario.suggestedTrials ?? opts.count);
  const requestedScenarios = scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    trials: capTrials(scenario),
  }));
  const perScenario: MatrixSummary['scenarios'] = [];
  // All scenarios in a matrix run the same model, so preflight is checked
  // once (cached) and represents the whole matrix.
  let matrixPreflight: BatchPreflight | undefined;
  let scenarioIndex = 0;
  for (const scenario of scenarios) {
    if (opts.signal?.aborted) {
      // eslint-disable-next-line no-console
      console.log(
        `[matrix] aborted before scenario ${scenarioIndex + 1}/${scenarios.length}; no more scenarios will start`,
      );
      break;
    }
    scenarioIndex++;
    const scenarioDir = join(root, scenario.id);
    const scenarioCount = capTrials(scenario);
    // eslint-disable-next-line no-console
    console.log(
      `\n[matrix] === ${scenario.id} (${scenarioIndex}/${scenarios.length}) ===${scenarioCount < opts.count ? ` (canary: ${scenarioCount} trial${scenarioCount === 1 ? '' : 's'} — scenario is saturated; suggestedTrials caps it)` : ''}`,
    );
    // Between-scenario GPU memory settle. The previous trial's
    // llama-server child shut down 10s ago; the CUDA driver may
    // still be reclaiming the 81 GB CUDA0 buffer. Without waiting,
    // the next trial's `ggml_cuda_init` can OOM and the daemon
    // SIGABRTs before becoming ready. Wild-caught (nemotron-super v6
    // matrix): tankcombat crashed with
    // `CUDA error: out of memory ... cudaSetDevice(id)` because
    // tictactoe's GPU state hadn't fully cleared.
    if (scenarioIndex > 1 && shouldWaitForGpuMemorySettle(opts)) {
      await waitForGpuMemoryToSettle();
    }
    const batch = await runBatch(scenario, { ...opts, count: scenarioCount, runsDir: scenarioDir });
    matrixPreflight ??= batch.preflight;
    perScenario.push({
      scenarioId: scenario.id,
      trials: batch.trials,
      successes: batch.successes,
      successRate: batch.successRate,
      summaryPath: `${scenario.id}/summary.json`,
      ...(batch.triage ? { triage: batch.triage } : {}),
    });
    if (opts.signal?.aborted) {
      // eslint-disable-next-line no-console
      console.log('[matrix] abort observed after scenario completion; stopping matrix');
      break;
    }
  }

  const totalTrials = perScenario.reduce((acc, s) => acc + s.trials, 0);
  const totalSuccesses = perScenario.reduce((acc, s) => acc + s.successes, 0);
  const hasFullCoverage =
    perScenario.length === requestedScenarios.length &&
    requestedScenarios.every((requested, index) => {
      const completed = perScenario[index];
      if (!completed || completed.scenarioId !== requested.scenarioId) return false;
      // Auto-triage is a deliberate terminal state for a cell: it records the
      // skipped count and lets the matrix proceed. Other short cells mean the
      // runner lost requested coverage and must not be reported as complete.
      return completed.trials === requested.trials || completed.triage?.stopped === true;
    });
  const status: MatrixSummary['status'] = opts.signal?.aborted
    ? 'interrupted'
    : totalTrials === 0 || !hasFullCoverage
      ? 'incomplete'
      : 'complete';
  const matrix: MatrixSummary = {
    modelId: opts.modelId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status,
    requestedScenarios,
    count: opts.count,
    scenarios: perScenario,
    totalTrials,
    totalSuccesses,
    overallSuccessRate: totalTrials === 0 ? 0 : totalSuccesses / totalTrials,
    ...(matrixPreflight ? { preflight: matrixPreflight } : {}),
  };
  await writeFile(join(root, 'summary.json'), JSON.stringify(matrix, null, 2));

  // eslint-disable-next-line no-console
  console.log(
    `\n[matrix] ${status} — ${perScenario.length}/${requestedScenarios.length} requested scenarios recorded`,
  );
  for (const s of perScenario) {
    // eslint-disable-next-line no-console
    console.log(`  ${s.scenarioId.padEnd(20)} ${formatPassClaim(s.successes, s.trials)}`);
    if (s.triage) {
      // eslint-disable-next-line no-console
      console.log(
        `  [matrix] TRIAGE ${s.scenarioId} signature="${s.triage.signature}" count=${s.triage.count} skipped=${s.triage.skipped}`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  ${'OVERALL'.padEnd(20)} ${formatPassClaim(totalSuccesses, totalTrials)}`);
  return matrix;
}

/**
 * A green matrix requires both complete requested coverage and at least one
 * passing trial. Keeping this predicate next to the summary construction
 * prevents CLI entry points from reintroducing the `0 === 0` / partial-pass
 * false positive.
 */
export function isSuccessfulMatrix(matrix: MatrixSummary): boolean {
  return (
    matrix.status === 'complete' &&
    matrix.totalTrials > 0 &&
    matrix.totalSuccesses === matrix.totalTrials
  );
}

export function shouldWaitForGpuMemorySettle(opts: Pick<BatchOptions, 'engine'>): boolean {
  return isLocalEngine(opts.engine ?? 'llama-cpp');
}

interface GpuComputeApp {
  pid: string;
  processName: string;
}

export function parseGpuComputeApps(stdout: string): GpuComputeApp[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidPart, ...nameParts] = line.split(',');
      return {
        pid: (pidPart ?? '').trim(),
        processName: nameParts.join(',').trim(),
      };
    })
    .filter((app) => /^\d+$/.test(app.pid));
}

export function isEvalNativeGpuProcessText(text: string): boolean {
  return /(?:^|[/\\\s])(?:(?:gezel-)?(?:llama-server|sd-server|ds4-server)|gezel_video_server|mlx_lm\.server)(?:$|[\s.])/i.test(
    text,
  );
}

async function gpuProcessText(app: GpuComputeApp): Promise<string> {
  try {
    const cmdline = await readFile(`/proc/${app.pid}/cmdline`, 'utf8');
    const normalized = cmdline.replace(/\0/g, ' ').trim();
    if (normalized) return normalized;
  } catch {
    // Non-Linux hosts and short-lived processes fall back to nvidia-smi's name.
  }
  return app.processName;
}

/**
 * Wait for compute processes to drain off the GPU before launching the
 * next trial. The previous trial's native engine has just been stopped with
 * its owning daemon; the CUDA driver may still be reclaiming its 81 GB CUDA0
 * buffer. Without
 * waiting, the next trial's `ggml_cuda_init` can OOM and the daemon
 * SIGABRTs before becoming ready. Wild-caught (nemotron-super
 * v6 matrix): tankcombat crashed with `CUDA error: out of memory ...
 * cudaSetDevice(id)` because tictactoe's GPU state hadn't fully cleared.
 *
 * Uses `nvidia-smi --query-compute-apps=pid` because the DGX Spark's
 * `nvidia-smi --query-gpu=memory.free` returns `[N/A]` on unified-memory
 * hardware. Waits until no compute apps remain, then a brief settle
 * delay so the driver has time to actually release the allocation.
 * Up to 60s total; bounded so a stuck driver doesn't block the matrix.
 *
 * No-op when `nvidia-smi` isn't on PATH or returns unparseable output
 * (Apple silicon, CPU-only hosts).
 */
let evalDeviceHealthGate: DeviceHealthGate | undefined;

function getEvalDeviceHealthGate(): DeviceHealthGate {
  if (evalDeviceHealthGate) return evalDeviceHealthGate;
  const rawMode = process.env.GEZEL_EVAL_DEVICE_SAFETY?.trim().toLowerCase();
  const mode =
    rawMode === 'off' || rawMode === 'observe' || rawMode === 'guard' ? rawMode : 'guard';
  evalDeviceHealthGate = new DeviceHealthGate({
    probe: createSystemDeviceHealthProbe(),
    policy: {
      mode,
      onTelemetryFailure:
        process.env.GEZEL_EVAL_DEVICE_SAFETY_TELEMETRY_FAILURE?.trim().toLowerCase() === 'block'
          ? 'block'
          : 'allow',
    },
    // eslint-disable-next-line no-console
    log: (message) => console.log(`[matrix] ${message}`),
  });
  return evalDeviceHealthGate;
}

async function waitForGpuMemoryToSettle(): Promise<void> {
  await waitForEvalGpuProcessesToDrain();
  await getEvalDeviceHealthGate().admit('next eval scenario');
}

async function waitForEvalGpuProcessesToDrain(): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const deadline = Date.now() + 60_000;
  let waitedMs = 0;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec(
        'nvidia-smi',
        ['--query-compute-apps=pid,process_name', '--format=csv,noheader'],
        { timeout: 5000 },
      );
      const activeApps = parseGpuComputeApps(stdout);
      if (activeApps.length === 0) {
        // No compute apps. Brief settle to let the driver finish
        // releasing the CUDA buffer — empirically the OOM on the next
        // spawn happens within the first 1-2s of the new
        // ggml_cuda_init, so 3s of headroom is plenty.
        await new Promise((r) => setTimeout(r, 3000));
        // eslint-disable-next-line no-console
        console.log(
          `[matrix] GPU compute apps drained after ${waitedMs}ms wait (+3s settle); next scenario clear to spawn`,
        );
        return;
      }
      const activeEvalApps: GpuComputeApp[] = [];
      const ignoredApps: Array<GpuComputeApp & { text: string }> = [];
      for (const app of activeApps) {
        const text = await gpuProcessText(app);
        if (isEvalNativeGpuProcessText(text)) {
          activeEvalApps.push(app);
        } else {
          ignoredApps.push({ ...app, text });
        }
      }
      if (activeEvalApps.length === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[matrix] GPU compute apps active but none are eval-native; skipping settle wait (${ignoredApps.map((app) => `${app.pid}:${app.processName || app.text}`).join(', ')})`,
        );
        return;
      }
    } catch {
      return; // no nvidia-smi or query failed — proceed
    }
    await new Promise((r) => setTimeout(r, 2000));
    waitedMs += 2000;
  }
  // eslint-disable-next-line no-console
  console.log(
    '[matrix] GPU memory wait timed out after 60s — proceeding anyway (next trial may OOM on ggml_cuda_init)',
  );
}
