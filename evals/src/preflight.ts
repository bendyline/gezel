/**
 * Per-model preflight admission gate.
 *
 * Before a batch/matrix spends hours of trials on a model, run ONE cheap
 * probe trial and verify the plumbing the multi-day debugging sagas
 * each traced back to:
 *
 *   - spawn/capacity — the capacity broker admits the model at all
 *     (nemotron-super burned full trial windows on denials misread as
 *     "engine hung").
 *   - tool round-trip — one structured tool call parses and lands a real
 *     workspace file (deepseek-r1 emitted nothing visible for 19 trials).
 *   - tuning-profile resolution — a requested profile actually resolves
 *     (`profile=none(req=...)` means the chain silently fell through:
 *     stale dist, missing manifest profiles, or the gemma4-26b-q4
 *     deleted-tuning-block regression).
 *   - reasoning budget is finite — `budget=2147483647` is the unbounded
 *     sentinel that made deepseek-r1 reason forever and abort every turn.
 *   - throughput floor — measured gen tok/s must clear a floor; a dense
 *     128B at ~1.2 t/s cannot finish any agentic scenario and should be
 *     excluded up front, not after 19 burned trials.
 *
 * The probe reuses `runTrial` end-to-end (warm cache, daemon spawn, perf
 * collection, failure classification), so a preflight trial dir looks
 * like any other trial dir — postmortem-able with the same tools.
 * Passing reports are cached under `evals/runs/preflight/` and reused
 * across the scenarios of a matrix run; failures always re-probe.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { readDaemonLogTailSync } from './failure-class.ts';
import { type HostStateSnapshot, readHostStateSnapshot } from './host-state.ts';
import { repoRoot, resolveLlamaBinary } from './native-bin.ts';
import {
  ds4EvalLaunchOverridesForModel,
  llamaCppEvalLaunchOverridesForModel,
  runTrial,
} from './runner.ts';
import type { EvalScenario, SuccessCheckResult, TrialOptions, TrialResult } from './types.ts';

const PROBE_PROJECT_NAME = 'Preflight Probe';
const PROBE_DEVELOPER_NAME = 'Probe';
const PROBE_FILE = 'preflight.txt';

/** Default floor for measured generation throughput. 3 t/s keeps the
 * known-slow-but-capable q8 variants (~3.6 t/s) admitted while excluding
 * dense-128B-class decode (~1.2-1.6 t/s) that cannot finish any agentic
 * scenario. Override per-call or via GEZEL_EVAL_PREFLIGHT_MIN_TPS. */
export const DEFAULT_PREFLIGHT_MIN_TPS = 3;

/** Unbounded-thinking sentinel guard: any logged reasoning budget at or
 * above this is "effectively infinite" (the wild-caught value was
 * 2147483647 — i32 max). */
const UNBOUNDED_REASONING_THRESHOLD = 2 ** 30;

const PASSING_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PreflightCheck {
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  modelId: string;
  engine: string;
  /**
   * Digest of the effective admission policy. A cached pass is reusable only
   * when this exactly matches the policy the next probe would run with.
   */
  policyFingerprint: string;
  trialId: string;
  runDir: string;
  createdAt: string;
  admitted: boolean;
  genTokensPerSec: number | null;
  /**
   * Prefill throughput from the same probe. Not an admission criterion — it is
   * recorded as a corroborating signal for the decode rate, which now scales
   * every scenario's hard ceiling (`throughputScaledMaxDurationMs`).
   *
   * The two move together with the host's state: across four probes of the
   * identical model+binary+host, decode spanned 3.94-7.89 tok/s and prefill
   * 169.8-703.4 tok/s, correlating at r=0.996. That is real host variance, not
   * a sampling artifact — so a future probe where the two DIVERGE is the
   * signature of a measurement problem rather than a slow day, and without
   * this field that distinction is unrecoverable after the fact.
   */
  promptTokensPerSec: number | null;
  /**
   * Machine state at probe time. Recorded because the probe's rate varied
   * 2-4x on an identical model+binary+host, tracking machine **uptime**
   * (<1 day fast, >2 days slow) with a reboot sitting exactly on the
   * boundary. The mechanism is unproven — see [host-state.ts](./host-state.ts).
   */
  hostState?: HostStateSnapshot;
  checks: {
    spawn: PreflightCheck;
    toolRoundTrip: PreflightCheck;
    profileResolution: PreflightCheck;
    reasoningBudget: PreflightCheck;
    throughput: PreflightCheck;
  };
}

async function findProbeProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROBE_PROJECT_NAME)?.id ?? null;
}

/**
 * The probe scenario: a pre-recruited solo developer is told, in the
 * most direct terms a small model can follow, to make exactly one
 * write_file tool call. Success = the file exists with the marker text —
 * which can only happen via a parsed, executed tool call.
 */
export const preflightScenario: EvalScenario = {
  id: 'preflight',
  description:
    'One-turn admission probe: a pre-recruited developer must land a single write_file tool call.',
  prompt: '(unused — setup messages the probe developer directly)',
  skipInitialPrompt: true,
  // Generous ceiling so cold loads of 100B+ models still fit; the
  // soft/hard watchdogs are the real terminators.
  timeoutMs: 15 * 60_000,
  setup: async ({ client, log }) => {
    let projectId = await findProbeProjectId(client);
    if (!projectId) {
      const created = await client.createProject({
        name: PROBE_PROJECT_NAME,
        // `about` ≥ 60 chars and `missionObjectives` ≥ 40 chars per the
        // CreateProjectRequest schema; solo mode strips team-management
        // tools so the probe exercises exactly one specialist turn.
        about:
          'Preflight admission probe project for the eval harness. The only work in scope is a ' +
          'single tool-driven file write; everything else is out of scope.',
        missionObjectives: `- ${PROBE_FILE} exists in the workspace, written via the write_file tool, containing "PREFLIGHT OK".`,
        mode: 'solo',
      });
      projectId = created.id;
    }
    if (!projectId) throw new Error('preflight setup: failed to resolve project id');
    let devId: string;
    try {
      const created = await client.createGezel({
        name: PROBE_DEVELOPER_NAME,
        role: 'Developer',
        about: `You are a developer on the "${PROBE_PROJECT_NAME}" project. When asked, call the write_file tool exactly once and stop. Do not plan, do not ask questions.`,
      });
      devId = created.id;
    } catch {
      const { gezels } = await client.listGezels();
      const existing = gezels.find((g) => g.name === PROBE_DEVELOPER_NAME);
      if (!existing) throw new Error('preflight setup: failed to create probe developer');
      devId = existing.id;
    }
    await client.addGezelToProject(projectId, devId);
    await client.sendChatMessage(devId, {
      message: `Call the write_file tool now to create the file \`${PROBE_FILE}\` with the content \`PREFLIGHT OK\`. Make exactly that one tool call. Do not ask questions, do not reply with prose, do not create anything else.`,
      projectId,
    });
    log('[scenario:setup] preflight probe dispatched');
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProbeProjectId(client);
    if (!projectId) return { done: false };
    let files: Array<{ path: string; isDirectory: boolean }> = [];
    try {
      const listing = await client.listProjectWorkspace(projectId, undefined, true);
      files = listing.files;
    } catch {
      return { done: false };
    }
    const hit = files.find(
      (f) => !f.isDirectory && f.path.split('/').pop()?.toLowerCase() === PROBE_FILE,
    );
    if (!hit) {
      recordSniff?.({ key: 'preflight', score: 0, bytes: 0 });
      return { done: false };
    }
    let text = '';
    try {
      const blob = await client.fetchProjectWorkspaceBlob(projectId, hit.path);
      text = await blob.text();
    } catch {
      return { done: false };
    }
    recordSniff?.({ key: 'preflight', score: /preflight/i.test(text) ? 1 : 0, bytes: text.length });
    if (/preflight/i.test(text)) {
      logChanged('sniff', `[scenario] preflight probe file landed (${text.length} bytes)`);
      return {
        done: true,
        success: true,
        reason: `tool round-trip OK: ${hit.path} written via write_file (${text.length} bytes)`,
      };
    }
    return { done: false };
  },
};

/** Inputs `buildPreflightChecks` needs — separated from the trial run so
 * the verdict logic is unit-testable without spawning anything. */
export interface PreflightEvidence {
  result: Pick<TrialResult, 'success' | 'reason' | 'failureMode' | 'failureClass'>;
  daemonLog: string | null;
  genTokensPerSec: number | null;
  /** Whether the model's catalog manifest authors `tuning.profiles`. A
   * profile request falling through is a HARD failure only when the
   * manifest says profiles exist — otherwise it's the (linted) known
   * manifest gap, reported but not gating. */
  manifestHasProfiles: boolean | null;
  minGenTokensPerSec: number;
}

export function buildPreflightChecks(ev: PreflightEvidence): {
  checks: PreflightReport['checks'];
  admitted: boolean;
} {
  const log = ev.daemonLog ?? '';

  // Spawn/capacity: the trial-level classifier already recognizes these
  // terminal shapes; surface them as the admission-blocking check.
  // Line shape is a contract with capacityDenialLogLine in
  // packages/service/src/providers/native/provider-pool.ts.
  const capacityDenied = /capacity broker denied [^\n]*budget exhausted/.exec(log);
  const spawnFailed = ev.result.failureMode === 'spawn-error' || capacityDenied !== null;
  const spawn: PreflightCheck = spawnFailed
    ? {
        ok: false,
        detail: capacityDenied?.[0] ?? `spawn failed: ${ev.result.reason}`,
      }
    : { ok: true, detail: 'daemon + engine spawned' };

  const toolRoundTrip: PreflightCheck = ev.result.success
    ? { ok: true, detail: ev.result.reason }
    : {
        ok: false,
        detail: `probe did not land a parsed tool call: ${ev.result.reason}`,
      };

  // Tuning trace lines: `tuning gezel=<id> profile=<resolved>(req=<id>@<src>) ...`.
  // `(req=` present with `none` resolved means a request fell through.
  const profileLines = [...log.matchAll(/tuning gezel=\S+ profile=(\S+)/g)].map((m) => m[1] ?? '');
  const fallthrough = profileLines.find((p) => p.startsWith('none(req='));
  const resolved = profileLines.find((p) => p !== 'none' && !p.startsWith('none(req='));
  let profileResolution: PreflightCheck;
  if (fallthrough && ev.manifestHasProfiles !== false) {
    profileResolution = {
      ok: false,
      detail: `profile request fell through to base tuning: profile=${fallthrough} (manifest authors profiles — stale dist or broken resolution chain)`,
    };
  } else if (fallthrough) {
    profileResolution = {
      ok: true,
      detail: `profile=${fallthrough} — expected fall-through: manifest authors no tuning.profiles (see manifest lint)`,
    };
  } else if (resolved) {
    profileResolution = { ok: true, detail: `profile resolved: ${resolved}` };
  } else if (profileLines.length > 0) {
    profileResolution = {
      ok: true,
      detail: 'no profile requested by probe gezels (bare profile=none) — base tuning in effect',
    };
  } else {
    profileResolution = { ok: true, detail: 'no tuning trace lines found (non-gating)' };
  }

  // Reasoning budget: inspect both runtime transition traces and the launch
  // diagnostic. A bounded budget may never emit an "activated" transition
  // during a short probe, which previously made a thinking model look like
  // reasoning was disabled even though the correct launch flag was present.
  const budgets = [
    ...log.matchAll(/reasoning-budget[^\n]*?budget=(\d+)/g),
    ...log.matchAll(/"reasoningBudgetTokens":(\d+)/g),
  ]
    .map((m) => Number.parseInt(m[1] ?? '0', 10))
    .filter((n) => Number.isFinite(n));
  const worstBudget = budgets.length > 0 ? Math.max(...budgets) : null;
  const thinkingEnabled = /tuning gezel=\S+[^\n]*thinking=yes/.test(log);
  const launchReportsUnbounded = /"reasoningBudgetTokens":"unbounded"/.test(log);
  const reasoningBudget: PreflightCheck =
    (worstBudget !== null && worstBudget >= UNBOUNDED_REASONING_THRESHOLD) ||
    (thinkingEnabled && launchReportsUnbounded)
      ? {
          ok: false,
          detail: `unbounded reasoning budget in effect${worstBudget !== null ? ` (budget=${worstBudget})` : ''} — set tuning.reasoning.thinkingBudget in the manifest`,
        }
      : {
          ok: true,
          detail:
            worstBudget !== null
              ? `reasoning budget bounded (budget=${worstBudget})`
              : thinkingEnabled
                ? 'thinking enabled; no reasoning-budget launch/runtime trace found (budget not verifiable)'
                : 'no reasoning-budget trace (non-thinking model or thinking disabled)',
        };

  const throughput: PreflightCheck =
    ev.genTokensPerSec === null
      ? { ok: true, detail: 'throughput not measured (no usage metrics) — non-gating' }
      : ev.genTokensPerSec >= ev.minGenTokensPerSec
        ? {
            ok: true,
            detail: `${ev.genTokensPerSec} gen tok/s ≥ floor ${ev.minGenTokensPerSec}`,
          }
        : {
            ok: false,
            detail: `${ev.genTokensPerSec} gen tok/s < floor ${ev.minGenTokensPerSec} — too slow to finish agentic scenarios (the mistral-medium class); raise the floor knowingly or exclude the model`,
          };

  const checks = { spawn, toolRoundTrip, profileResolution, reasoningBudget, throughput };
  const admitted =
    spawn.ok && toolRoundTrip.ok && profileResolution.ok && reasoningBudget.ok && throughput.ok;
  return { checks, admitted };
}

function defaultPreflightRunsDir(): string {
  return join(repoRoot(), 'evals', 'runs', 'preflight');
}

/** Best-effort: does the model's bundled manifest author tuning.profiles?
 * Returns null when the manifest can't be located (unknown/alias ids). */
export function manifestHasProfilesSync(modelId: string): boolean | null {
  try {
    const root = join(gildeDataDir(), 'chat-models');
    for (const prefix of readdirNamesSync(root)) {
      for (const dir of readdirNamesSync(join(root, prefix))) {
        try {
          const manifest = JSON.parse(
            readFileSync(join(root, prefix, dir, 'manifest.json'), 'utf8'),
          ) as { id?: string; tuning?: { profiles?: Record<string, unknown> } };
          if (manifest.id === modelId) {
            return Object.keys(manifest.tuning?.profiles ?? {}).length > 0;
          }
        } catch {
          // skip unreadable manifest
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readdirNamesSync(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export interface PreflightOptions
  extends Pick<TrialOptions, 'modelId' | 'engine' | 'mlxSourceHome' | 'cacheRoot' | 'llamaBin'> {
  /** Where preflight trial dirs + cached reports live. */
  preflightRunsDir?: string;
  minGenTokensPerSec?: number;
}

const PREFLIGHT_POLICY_VERSION = 1;

const PREFLIGHT_LAUNCH_ENV_KEYS = [
  'GEZEL_CAPACITY_BUDGET_GB',
  'GEZEL_DS4_MODEL',
  'GEZEL_DS4_SERVER_BIN',
  'GEZEL_EVAL_SOFT_PROGRESS_TIMEOUT_MS',
  'GEZEL_LLAMA_NUM_CTX',
  'GEZEL_LLAMA_PRE_FIRST_BYTE_TIMEOUT_MS',
  'GEZEL_LLAMA_REASONING_PRESERVE',
  'GEZEL_LLAMA_SERVER_BIN',
  'GEZEL_LLAMA_STARTUP_TIMEOUT_MS',
] as const;

function effectiveMinGenTokensPerSec(opts: PreflightOptions): number {
  return (
    opts.minGenTokensPerSec ??
    (Number.parseFloat(process.env.GEZEL_EVAL_PREFLIGHT_MIN_TPS ?? '') || DEFAULT_PREFLIGHT_MIN_TPS)
  );
}

function bundledManifestDigestSync(modelId: string): string | null {
  const root = join(gildeDataDir(), 'chat-models');
  const direct = join(root, modelId.slice(0, 2).toLowerCase(), modelId, 'manifest.json');
  try {
    return createHash('sha256').update(readFileSync(direct)).digest('hex');
  } catch {
    // Unknown aliases and older catalog layouts fall back to the same id scan
    // used by manifestHasProfilesSync.
  }
  try {
    for (const prefix of readdirNamesSync(root)) {
      for (const dir of readdirNamesSync(join(root, prefix))) {
        const path = join(root, prefix, dir, 'manifest.json');
        try {
          const raw = readFileSync(path);
          const manifest = JSON.parse(raw.toString('utf8')) as { id?: string };
          if (manifest.id === modelId) {
            return createHash('sha256').update(raw).digest('hex');
          }
        } catch {
          // Skip unreadable manifests.
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function binaryIdentity(path: string | undefined): object | null {
  if (!path) return null;
  try {
    const stat = statSync(path);
    return { path, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch {
    return { path, missing: true };
  }
}

function effectiveLlamaBinaryPath(opts: PreflightOptions, engine: string): string | undefined {
  if (engine !== 'llama-cpp') return undefined;
  if (opts.llamaBin) return opts.llamaBin;
  try {
    return resolveLlamaBinary().path;
  } catch {
    // A missing binary is still probed (and rejected) by runTrial. Keep the
    // fingerprint computable so the cache path cannot mask that failure.
    return process.env.GEZEL_LLAMA_SERVER_BIN;
  }
}

function packageEntryIdentity(specifier: string): object | null {
  try {
    const path = createRequire(import.meta.url).resolve(specifier);
    return binaryIdentity(path);
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Identify every input that can materially change preflight admission while
 * retaining the same model + engine cache filename. The report stores only
 * this digest, never raw environment values.
 */
export function preflightPolicyFingerprint(opts: PreflightOptions): string {
  const engine = opts.engine ?? 'llama-cpp';
  const launch =
    engine === 'llama-cpp'
      ? llamaCppEvalLaunchOverridesForModel(opts.modelId)
      : engine === 'ds4'
        ? ds4EvalLaunchOverridesForModel(opts.modelId)
        : undefined;
  const launchEnv = Object.fromEntries(
    PREFLIGHT_LAUNCH_ENV_KEYS.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  const payload = {
    version: PREFLIGHT_POLICY_VERSION,
    modelId: opts.modelId,
    engine,
    minGenTokensPerSec: effectiveMinGenTokensPerSec(opts),
    launch: launch ?? null,
    launchEnv,
    cacheRoot: opts.cacheRoot ?? null,
    mlxSourceHome: opts.mlxSourceHome ?? null,
    llamaBinary: binaryIdentity(effectiveLlamaBinaryPath(opts, engine)),
    runtimeEntries: {
      daemon: packageEntryIdentity('@bendyline/gezel-service/dist/bin/gezeld.js'),
      mcp: packageEntryIdentity('@bendyline/gezel-mcp/dist/server.js'),
    },
    manifestDigest: bundledManifestDigestSync(opts.modelId),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function isReusablePassingPreflightReport(
  report: Partial<PreflightReport>,
  expectedPolicyFingerprint: string,
  nowMs = Date.now(),
): boolean {
  const ageMs = nowMs - Date.parse(report.createdAt ?? '');
  return (
    report.admitted === true &&
    report.policyFingerprint === expectedPolicyFingerprint &&
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs < PASSING_REPORT_MAX_AGE_MS
  );
}

function reportPath(runsDir: string, modelId: string, engine: string): string {
  return join(runsDir, `report-${engine}-${modelId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const engine = opts.engine ?? 'llama-cpp';
  const runsDir = opts.preflightRunsDir ?? defaultPreflightRunsDir();
  const minTps = effectiveMinGenTokensPerSec(opts);
  const policyFingerprint = preflightPolicyFingerprint(opts);

  const result = await runTrial(preflightScenario, {
    modelId: opts.modelId,
    engine,
    runsDir,
    ...(opts.mlxSourceHome ? { mlxSourceHome: opts.mlxSourceHome } : {}),
    ...(opts.cacheRoot ? { cacheRoot: opts.cacheRoot } : {}),
    ...(opts.llamaBin ? { llamaBin: opts.llamaBin } : {}),
  });

  // Captured after the probe, so the memory figures reflect the state the
  // probe actually ran against rather than a pre-load snapshot.
  const hostState = await readHostStateSnapshot();
  const daemonLog = readDaemonLogTailSync(join(result.runDir, 'daemon.log'));
  let genTokensPerSec: number | null = null;
  let promptTokensPerSec: number | null = null;
  try {
    const metrics = JSON.parse(await readFile(join(result.runDir, 'metrics.json'), 'utf8')) as {
      derived?: {
        genTokensPerSec?: number;
        meanTokensPerSec?: number;
        promptTokensPerSec?: number | null;
      };
    };
    genTokensPerSec = metrics.derived?.genTokensPerSec ?? metrics.derived?.meanTokensPerSec ?? null;
    promptTokensPerSec = metrics.derived?.promptTokensPerSec ?? null;
  } catch {
    genTokensPerSec = null;
    promptTokensPerSec = null;
  }

  const { checks, admitted } = buildPreflightChecks({
    result,
    daemonLog,
    genTokensPerSec,
    manifestHasProfiles: manifestHasProfilesSync(opts.modelId),
    minGenTokensPerSec: minTps,
  });

  const report: PreflightReport = {
    modelId: opts.modelId,
    engine,
    policyFingerprint,
    trialId: result.trialId,
    runDir: result.runDir,
    createdAt: new Date().toISOString(),
    admitted,
    genTokensPerSec,
    promptTokensPerSec,
    ...(Object.keys(hostState).length > 0 ? { hostState } : {}),
    checks,
  };
  await writeFile(
    join(result.runDir, 'preflight-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    reportPath(runsDir, opts.modelId, engine),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}

/**
 * Cached admission: reuse a PASSING report newer than 24h (a matrix run
 * preflights once, not once per scenario); failed reports always
 * re-probe so a manifest fix takes effect immediately.
 */
export async function ensurePreflightAdmission(
  opts: PreflightOptions & { log?: (line: string) => void },
): Promise<PreflightReport> {
  const engine = opts.engine ?? 'llama-cpp';
  const runsDir = opts.preflightRunsDir ?? defaultPreflightRunsDir();
  const log = opts.log ?? (() => {});
  const policyFingerprint = preflightPolicyFingerprint(opts);
  try {
    const cached = JSON.parse(
      await readFile(reportPath(runsDir, opts.modelId, engine), 'utf8'),
    ) as Partial<PreflightReport>;
    if (isReusablePassingPreflightReport(cached, policyFingerprint)) {
      const ageMs = Date.now() - Date.parse(cached.createdAt!);
      log(
        `[preflight] reusing passing report for ${opts.modelId} (${Math.round(ageMs / 60000)}m old, ${cached.genTokensPerSec ?? '?'} t/s)`,
      );
      return cached as PreflightReport;
    }
  } catch {
    // No cached report — probe.
  }
  log(`[preflight] probing ${opts.modelId} (${engine})…`);
  const report = await runPreflight(opts);
  const failed = Object.entries(report.checks)
    .filter(([, c]) => !c.ok)
    .map(([name, c]) => `${name}: ${c.detail}`);
  log(
    `[preflight] ${opts.modelId} ${report.admitted ? 'ADMITTED' : 'EXCLUDED'}${failed.length > 0 ? ` — ${failed.join('; ')}` : ''}`,
  );
  return report;
}

export function formatPreflightFailure(report: PreflightReport): string {
  const failed = Object.entries(report.checks)
    .filter(([, c]) => !c.ok)
    .map(([name, c]) => `  ${name}: ${c.detail}`);
  return `preflight EXCLUDED ${report.modelId} (${report.engine}):\n${failed.join('\n')}\n  probe trial: ${report.runDir}\n  Fix the manifest/config and re-run, or pass --skip-preflight to override.`;
}
