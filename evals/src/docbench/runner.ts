/**
 * Generate one model's docbench outcomes: stand up a trial `gezeld` with the
 * model, then run the task pack against the daemon's own
 * `/v1/chat/completions`, the route DocBlocks' hosted mode uses, with the
 * catalog's sampling and thinking tuning applied as the product applies it.
 *
 * Three kinds of contestant share the trial loop:
 *
 * - a catalog model on llama.cpp (the default): weights linked into the
 *   trial home, the 32K launch context;
 * - `apple-foundation-models`, the model macOS runs: the trial daemon's
 *   Apple provider through the `gezel-apple-fm` helper, at the context and
 *   reply cap Apple sets;
 * - a frontier reference (`claude-<model>`, `codex-<model>`): the pack talks
 *   to an OpenAI-compatible endpoint in front of that CLI
 *   (`cli-endpoint.ts`). DocBlocks never routes to these; they are a ceiling.
 *
 * What it deliberately does not do, unlike the decode benchmark it borrows
 * its setup from (`bin/ab-decode-levers.ts`): send requests straight to the
 * supervised llama-server, or override `modelTuning`. Either would measure a
 * model the product never runs.
 */

import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import type { BenchEvent, BenchPackManifest } from '@bendyline/gezel/eval';
import {
  cloneModelDirIntoTrial,
  defaultCacheRoot,
  ensureWarmModel,
  findReadOnlyModelDir,
  isModelInstalled,
  linkModelIntoTrial,
} from '../model-cache.ts';
import { chatModelInstallIdentity } from '../model-sources.ts';
import { appleFmHelperPath } from '../providers.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';
import { type ReferenceModel, referenceModel, startCliEndpoint } from './cli-endpoint.ts';
import { type PackCommand, readOutcomes, runPackTrial } from './pack.ts';

/** The launch context: what a constrained laptop gets (`model-fit.ts`'s 32K floor). */
export const DOCBENCH_LAUNCH_CONTEXT = 32_768;

/** The id of the model macOS runs, as Gezel's Apple provider names it. */
export const APPLE_MODEL_ID = 'apple-foundation-models';

export type Contestant =
  | { readonly kind: 'llama-cpp' }
  | { readonly kind: 'apple' }
  | { readonly kind: 'reference'; readonly reference: ReferenceModel };

/** What runs a docbench model id. */
export function contestantFor(modelId: string): Contestant {
  if (modelId === APPLE_MODEL_ID) return { kind: 'apple' };
  const reference = referenceModel(modelId);
  return reference ? { kind: 'reference', reference } : { kind: 'llama-cpp' };
}

/** Runs on this machine's accelerator, so generation holds the eval device lock. */
export function runsOnDevice(modelId: string): boolean {
  return contestantFor(modelId).kind !== 'reference';
}

export interface GenerateOptions {
  readonly pack: PackCommand;
  readonly manifest: BenchPackManifest;
  readonly modelId: string;
  /** `<runDir>/<modelId>`: cases go under `cases/`, logs beside them. */
  readonly modelDir: string;
  /** The llama-server binary; required for llama.cpp models only. */
  readonly llamaBin?: string;
  /** The Claude and Codex CLIs, for reference models. */
  readonly claudeBin?: string;
  readonly codexBin?: string;
  /** Tasks to run; all when empty. */
  readonly tasks: readonly string[];
  readonly cases: readonly string[];
  /** The frozen "today" every prompt states. */
  readonly now: string;
  readonly seedBase: number;
  /** Clone weights read-only from this home when the eval cache lacks them. */
  readonly sourceHome?: string;
  /** Download weights the cache lacks; otherwise a missing model is an error. */
  readonly allowDownload: boolean;
  readonly keepHome: boolean;
  readonly log: (line: string) => void;
}

export interface GenerateResult {
  readonly outcomes: number;
  readonly infraRetried: number;
  readonly launchContext: number;
  /** The context window the endpoint reported, which the pack sized its budgets from. */
  readonly contextWindow?: number | null;
  readonly seconds: number;
  /**
   * The catalog version of the build that was measured. A published score
   * is fresh only while the catalog still serves this version, so the
   * publish step stamps it rather than whatever the catalog says later.
   */
  readonly catalogVersion?: string;
}

/** Trials each task asks for, so trial `n` runs only the tasks that want an n-th sample. */
export function tasksForTrial(
  manifest: BenchPackManifest,
  selected: readonly string[],
  trial: number,
): string[] {
  return manifest.tasks
    .filter((task) => selected.length === 0 || selected.includes(task.id))
    .filter((task) => task.trials > trial)
    .map((task) => task.id);
}

async function materializeModel(
  options: GenerateOptions & { readonly llamaBin: string },
  home: string,
): Promise<void> {
  const cacheRoot = defaultCacheRoot();
  const engine = 'llama-cpp';
  if (await isModelInstalled(cacheRoot, engine, options.modelId)) {
    // Present: still checked against the catalog, and refreshed only if allowed.
    await ensureWarmModel({
      cacheRoot,
      engine,
      modelId: options.modelId,
      llamaBin: options.llamaBin,
      offline: !options.allowDownload,
      log: options.log,
    });
    await linkModelIntoTrial({ cacheRoot, trialHome: home, engine, modelId: options.modelId });
    return;
  }
  const sourceDir = options.sourceHome
    ? await findReadOnlyModelDir({
        sourceHome: options.sourceHome,
        engine,
        modelId: options.modelId,
      })
    : null;
  if (sourceDir) {
    options.log(`[docbench] ${options.modelId}: cloning read-only from ${sourceDir}`);
    await cloneModelDirIntoTrial({ sourceDir, trialHome: home, engine, modelId: options.modelId });
    return;
  }
  if (!options.allowDownload) {
    throw new Error(
      `${options.modelId} is not in the eval cache (${cacheRoot})${options.sourceHome ? ` or ${options.sourceHome}` : ''}. Pass --allow-download to fetch it, or --source-home <home> to borrow an installed copy.`,
    );
  }
  await ensureWarmModel({
    cacheRoot,
    engine,
    modelId: options.modelId,
    llamaBin: options.llamaBin,
    log: options.log,
  });
  await linkModelIntoTrial({ cacheRoot, trialHome: home, engine, modelId: options.modelId });
}

function describeEvent(event: BenchEvent): string | null {
  if (event.type === 'start') {
    return `start: ${String(event.cases)} cases, context window ${String(event.contextWindow)}`;
  }
  if (event.type === 'case-done') {
    const status = event.error ? `${event.error} failure` : event.usable ? 'usable' : 'not usable';
    return `${event.taskId}/${event.caseId}: ${status} (${String(Math.round(event.ms / 100) / 10)}s)`;
  }
  return null;
}

interface TrialEndpoint {
  readonly endpoint: string;
  readonly model: string;
  readonly token?: string;
  readonly caFile?: string;
}

/** Every trial each task asks for, then once more for any case the endpoint failed. */
async function runTrials(
  options: GenerateOptions,
  target: TrialEndpoint,
  log: (line: string) => void,
): Promise<{ infraRetried: number; contextWindow: number | null }> {
  const casesDir = join(options.modelDir, 'cases');
  const maxTrials = Math.max(...options.manifest.tasks.map((task) => task.trials));
  let infraRetried = 0;
  let contextWindow: number | null = null;
  const request = (trial: number, tasks: readonly string[], cases: readonly string[]) => ({
    endpoint: target.endpoint,
    model: target.model,
    ...(target.token ? { token: target.token } : {}),
    ...(target.caFile ? { caFile: target.caFile } : {}),
    trial,
    seed: options.seedBase + trial,
    now: options.now,
    tasks,
    cases,
    outDir: casesDir,
    stderrPath: join(options.modelDir, 'pack.log'),
  });
  for (let trial = 0; trial < maxTrials; trial += 1) {
    const tasks = tasksForTrial(options.manifest, options.tasks, trial);
    if (tasks.length === 0) continue;
    await runPackTrial(options.pack, {
      ...request(trial, tasks, options.cases),
      onEvent: (event) => {
        if (event.type === 'start') contextWindow = event.contextWindow ?? null;
        const line = describeEvent(event);
        if (line) log(`t${String(trial)} ${line}`);
      },
    });
    // An endpoint failure says nothing about the model: run those cases once more.
    const infra = (await readOutcomes(casesDir)).filter(
      ({ outcome }) =>
        outcome.trial === trial &&
        tasks.includes(outcome.taskId) &&
        outcome.error?.class === 'infra',
    );
    for (const taskId of new Set(infra.map(({ outcome }) => outcome.taskId))) {
      const cases = infra
        .filter(({ outcome }) => outcome.taskId === taskId)
        .map(({ outcome }) => outcome.caseId);
      log(
        `t${String(trial)} retrying ${String(cases.length)} ${taskId} cases after endpoint failures`,
      );
      infraRetried += cases.length;
      await runPackTrial(options.pack, request(trial, [taskId], cases));
    }
  }
  return { infraRetried, contextWindow };
}

/** Stand up a trial daemon serving one model, warm it, and run the trials against it. */
async function generateOnDaemon(
  options: GenerateOptions,
  home: string,
  log: (line: string) => void,
  engine: { readonly provider: 'llama-cpp' | 'apple-foundation-models'; readonly modelId: string },
): Promise<{ infraRetried: number; contextWindow: number | null }> {
  let spawned: Awaited<ReturnType<typeof spawnTrialDaemon>> | null = null;
  try {
    const daemon = await spawnTrialDaemon({
      home,
      ...(options.llamaBin ? { llamaBin: options.llamaBin } : {}),
      stderrLogPath: join(options.modelDir, 'daemon.log'),
      extraEnv: {
        GEZEL_LLAMA_NUM_CTX: String(DOCBENCH_LAUNCH_CONTEXT),
        // Routing would move work off the model under test.
        GEZEL_DISABLE_MODEL_ROUTING: '1',
        ...(engine.provider === 'apple-foundation-models'
          ? { GEZEL_APPLE_FM_BIN: appleFmHelperPath() ?? '' }
          : {}),
      },
    });
    spawned = daemon;
    await daemon.client.updateConfig({
      provider: engine.provider,
      defaultModel: { [engine.provider]: engine.modelId },
      firstRunCompleted: true,
      // One request at a time: what a laptop does, and what makes a seed reproducible.
      providerConcurrency: { [engine.provider]: 1 },
      // The daemon installs a Meester oversight task at boot, and inside the
      // night window the night shift runs it on the model under test, taking
      // engine turns between the pack's requests (as `runner.ts` notes for
      // every trial). A benchmark round must not depend on the wall clock.
      nightShift: { enabled: false },
    });

    const endpoint = `${daemon.baseUrl}/v1`;
    const model = `${engine.provider}:${engine.modelId}`;
    const caFile = daemon.cert ? join(home, 'daemon-ca.pem') : undefined;
    if (caFile && daemon.cert) writeFileSync(caFile, daemon.cert);

    // Load the model before the clock starts on any case, and fail fast if it cannot load.
    const doFetch = daemon.cert ? createTrustingFetch({ cert: daemon.cert }) : fetch;
    const warmup = await doFetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoning_effort: 'none',
        max_tokens: 8,
        stream: false,
      }),
    });
    if (!warmup.ok) {
      throw new Error(
        `the model did not load: HTTP ${String(warmup.status)} ${(await warmup.text()).slice(0, 300)}`,
      );
    }
    log('loaded');
    return await runTrials(
      options,
      { endpoint, model, token: daemon.token, ...(caFile ? { caFile } : {}) },
      log,
    );
  } finally {
    if (spawned) await shutdownTrialDaemon(spawned);
  }
}

/** Run the trials against a frontier model's CLI, behind a local OpenAI-compatible endpoint. */
async function generateOnCli(
  options: GenerateOptions,
  reference: ReferenceModel,
  log: (line: string) => void,
): Promise<{ infraRetried: number; contextWindow: number | null }> {
  const bin = reference.cli === 'claude' ? options.claudeBin : options.codexBin;
  if (!bin) throw new Error(`no ${reference.cli} CLI to run ${options.modelId} on`);
  const endpoint = await startCliEndpoint({
    modelId: options.modelId,
    reference,
    // The local field's budgets, so the requests differ only in the model.
    contextWindow: DOCBENCH_LAUNCH_CONTEXT,
    claudeBin: options.claudeBin ?? 'claude',
    codexBin: options.codexBin ?? 'codex',
    callLog: join(options.modelDir, 'cli-calls.jsonl'),
    log,
  });
  log(`${reference.cli} CLI (${reference.model}) at ${endpoint.baseUrl}`);
  try {
    return await runTrials(options, { endpoint: endpoint.baseUrl, model: options.modelId }, log);
  } finally {
    await endpoint.close();
  }
}

export async function generateModel(options: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();
  const contestant = contestantFor(options.modelId);
  const catalogVersion =
    contestant.kind === 'llama-cpp'
      ? chatModelInstallIdentity(options.modelId, 'llama-cpp')?.catalogVersion
      : undefined;
  await mkdir(join(options.modelDir, 'cases'), { recursive: true });
  const log = (line: string) => options.log(`[docbench] ${options.modelId}: ${line}`);
  let home: string | null = null;
  try {
    let run: { infraRetried: number; contextWindow: number | null };
    if (contestant.kind === 'reference') {
      run = await generateOnCli(options, contestant.reference, log);
    } else {
      home = await mkdtemp(join(tmpdir(), `gezel-docbench-${options.modelId}-`));
      if (contestant.kind === 'apple') {
        if (!appleFmHelperPath()) {
          throw new Error(
            'Apple on-device AI needs the gezel-apple-fm helper: run native/helpers/apple-fm/build.sh or set GEZEL_APPLE_FM_BIN.',
          );
        }
        run = await generateOnDaemon(options, home, log, {
          provider: 'apple-foundation-models',
          modelId: APPLE_MODEL_ID,
        });
      } else {
        const llamaBin = options.llamaBin;
        if (!llamaBin) throw new Error(`no llama-server binary to run ${options.modelId} on`);
        await materializeModel({ ...options, llamaBin }, home);
        run = await generateOnDaemon(options, home, log, {
          provider: 'llama-cpp',
          modelId: options.modelId,
        });
      }
    }
    const outcomes = (await readOutcomes(join(options.modelDir, 'cases'))).length;
    return {
      outcomes,
      infraRetried: run.infraRetried,
      launchContext: DOCBENCH_LAUNCH_CONTEXT,
      contextWindow: run.contextWindow,
      seconds: Math.round((Date.now() - started) / 1000),
      ...(catalogVersion ? { catalogVersion } : {}),
    };
  } finally {
    if (home) {
      if (options.keepHome) log(`trial home kept at ${home}`);
      else await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
