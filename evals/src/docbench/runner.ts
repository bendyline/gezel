/**
 * Generate one model's docbench outcomes: stand up a trial `gezeld` with the
 * model, then run the task pack against the daemon's own
 * `/v1/chat/completions`, the route DocBlocks' hosted mode uses, with the
 * catalog's sampling and thinking tuning applied as the product applies it.
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
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';
import { type PackCommand, readOutcomes, runPackTrial } from './pack.ts';

/** The launch context: what a constrained laptop gets (`model-fit.ts`'s 32K floor). */
export const DOCBENCH_LAUNCH_CONTEXT = 32_768;

export interface GenerateOptions {
  readonly pack: PackCommand;
  readonly manifest: BenchPackManifest;
  readonly modelId: string;
  /** `<runDir>/<modelId>`: cases go under `cases/`, logs beside them. */
  readonly modelDir: string;
  readonly llamaBin: string;
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

async function materializeModel(options: GenerateOptions, home: string): Promise<void> {
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

export async function generateModel(options: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();
  const catalogVersion = chatModelInstallIdentity(options.modelId, 'llama-cpp')?.catalogVersion;
  const home = await mkdtemp(join(tmpdir(), `gezel-docbench-${options.modelId}-`));
  const casesDir = join(options.modelDir, 'cases');
  await mkdir(casesDir, { recursive: true });
  const log = (line: string) => options.log(`[docbench] ${options.modelId}: ${line}`);
  let spawned: Awaited<ReturnType<typeof spawnTrialDaemon>> | null = null;
  try {
    await materializeModel(options, home);
    const daemon = await spawnTrialDaemon({
      home,
      llamaBin: options.llamaBin,
      stderrLogPath: join(options.modelDir, 'daemon.log'),
      extraEnv: {
        GEZEL_LLAMA_NUM_CTX: String(DOCBENCH_LAUNCH_CONTEXT),
        // Routing would move work off the model under test.
        GEZEL_DISABLE_MODEL_ROUTING: '1',
      },
    });
    spawned = daemon;
    await daemon.client.updateConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': options.modelId },
      firstRunCompleted: true,
      // One request at a time: what a laptop does, and what makes a seed reproducible.
      providerConcurrency: { 'llama-cpp': 1 },
      // The daemon installs a Meester oversight task at boot, and inside the
      // night window the night shift runs it on the model under test, taking
      // engine turns between the pack's requests (as `runner.ts` notes for
      // every trial). A benchmark round must not depend on the wall clock.
      nightShift: { enabled: false },
    });

    const endpoint = `${daemon.baseUrl}/v1`;
    const model = `llama-cpp:${options.modelId}`;
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

    const maxTrials = Math.max(...options.manifest.tasks.map((task) => task.trials));
    let infraRetried = 0;
    for (let trial = 0; trial < maxTrials; trial += 1) {
      const tasks = tasksForTrial(options.manifest, options.tasks, trial);
      if (tasks.length === 0) continue;
      const run = (cases: readonly string[]) =>
        runPackTrial(options.pack, {
          endpoint,
          model,
          token: daemon.token,
          ...(caFile ? { caFile } : {}),
          trial,
          seed: options.seedBase + trial,
          now: options.now,
          tasks,
          cases,
          outDir: casesDir,
          stderrPath: join(options.modelDir, 'pack.log'),
          onEvent: (event) => {
            const line = describeEvent(event);
            if (line) log(`t${String(trial)} ${line}`);
          },
        });
      await run(options.cases);
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
        await runPackTrial(options.pack, {
          endpoint,
          model,
          token: daemon.token,
          ...(caFile ? { caFile } : {}),
          trial,
          seed: options.seedBase + trial,
          now: options.now,
          tasks: [taskId],
          cases,
          outDir: casesDir,
          stderrPath: join(options.modelDir, 'pack.log'),
        });
      }
    }
    const outcomes = (await readOutcomes(casesDir)).length;
    return {
      outcomes,
      infraRetried,
      launchContext: DOCBENCH_LAUNCH_CONTEXT,
      seconds: Math.round((Date.now() - started) / 1000),
      ...(catalogVersion ? { catalogVersion } : {}),
    };
  } finally {
    if (spawned) await shutdownTrialDaemon(spawned);
    if (options.keepHome) log(`trial home kept at ${home}`);
    else await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
