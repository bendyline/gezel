import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { GezelClient } from '@bendyline/gezel-client/node';
import type { GezelApp } from './client.js';
import { GezelSdkError } from './errors.js';
import type {
  EnsureModelEngine,
  EnsureModelOptions,
  EnsureModelResult,
  EnsureProgressEvent,
} from './host-types.js';

export interface EnsureModelDeps {
  client: GezelClient;
  app: GezelApp;
  /** Whether the daemon is this app's own; only then do we pin defaults. */
  owned: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Make a model usable, whichever way this machine can get there.
 *
 * Order is deliberate: **already present → shipped bundle → download**. A
 * model the user's own Gezel installed is visible here through the read-only
 * overlay, so the common case on a machine that already runs Gezel costs
 * nothing. A bundle the app ships makes a first run work with no network. Only
 * then do we go to the network.
 */
export async function ensureModel(
  deps: EnsureModelDeps,
  opts: EnsureModelOptions,
): Promise<EnsureModelResult> {
  opts.signal?.throwIfAborted();
  const engine = resolveEngine(
    opts.engine,
    deps.platform ?? process.platform,
    deps.arch ?? process.arch,
  );
  const emit = (event: EnsureProgressEvent): void => {
    try {
      opts.onEvent?.(event);
    } catch {
      /* Observers cannot change installation outcome. */
    }
  };

  await ensureEngineBinary(deps, engine, emit, opts.signal);
  opts.signal?.throwIfAborted();

  let source: EnsureModelResult['source'] = 'present';
  if (!(await isInstalled(deps.client, engine, opts.model))) {
    if (opts.bundle) {
      await importBundle(deps.client, opts.bundle, emit, opts.signal);
      source = 'bundle';
    } else if (opts.allowWeightDownload === false) {
      throw new GezelSdkError(
        `Model "${opts.model}" is not installed. Download it from an explicit user action, or ship it as a .gezmodel bundle.`,
        { code: 'model_download_required' },
      );
    } else {
      await downloadModel(deps.app, engine, opts.model, emit, opts.signal);
      source = 'download';
    }
  }

  opts.signal?.throwIfAborted();
  if (source !== 'present' && !(await isInstalled(deps.client, engine, opts.model))) {
    throw new GezelSdkError('Preparation finished without installing the requested model', {
      code: 'model_not_ready',
    });
  }
  opts.signal?.throwIfAborted();
  const pinned = await maybePin(deps, engine, opts);
  emit({ phase: 'ready', model: opts.model, engine, source });
  return { model: opts.model, engine, source, pinned };
}

/**
 * MLX on Apple Silicon, llama.cpp everywhere else — the same rule the daemon's
 * own first-run bootstrap uses, so an app's choice and the daemon's default
 * cannot disagree.
 */
export function resolveEngine(
  requested: EnsureModelOptions['engine'],
  platform: NodeJS.Platform,
  arch: string,
): EnsureModelEngine {
  if (requested && requested !== 'auto') return requested;
  return platform === 'darwin' && arch === 'arm64' ? 'mlx' : 'llama-cpp';
}

/**
 * Fetch the engine binary before the weights.
 *
 * A turn that starts without one fails with "the engine is downloading, try
 * again" — true, but useless to an app that has just told its user everything
 * is ready.
 */
async function ensureEngineBinary(
  deps: EnsureModelDeps,
  engine: EnsureModelEngine,
  emit: (event: EnsureProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const binary = engine === 'mlx' ? 'uv' : engine === 'ds4' ? 'ds4-server' : 'llama-server';
  const status = await deps.client.getNativeEngineStatus().catch(() => null);
  if (!status) return;
  if (!status.pinned) {
    emit({
      phase: 'engine',
      engine: binary,
      message: 'this build has no pinned native engines; skipping the engine download',
    });
    return;
  }
  if (status.engines.some((entry) => entry.name === binary && entry.installed)) return;

  emit({ phase: 'engine', engine: binary, message: `downloading the ${binary} engine` });
  await deps.client.ensureNativeEngine(
    binary,
    (event) => {
      if (event.type === 'error')
        throw new GezelSdkError(event.error, { code: 'engine_download_failed' });
      if (event.type === 'progress' && event.totalBytes > 0) {
        emit({
          phase: 'engine',
          engine: binary,
          message: `downloading the ${binary} engine`,
          percent: Math.round((event.bytesWritten / event.totalBytes) * 100),
        });
      }
    },
    engine === 'mlx' ? undefined : status.llamaBackend,
    signal,
  );
}

async function isInstalled(
  client: GezelClient,
  engine: EnsureModelEngine,
  model: string,
): Promise<boolean> {
  const listing =
    engine === 'mlx'
      ? await client.listMlxModels()
      : engine === 'ds4'
        ? await client.listDs4Models()
        : await client.listLlamaCppModels();
  return (listing?.models ?? []).some((entry) => entry.id === model);
}

/**
 * Install a `.gezmodel` the app ships. This is the daemon's ordinary import
 * path — streamed, checksum-verified, staged, then published — not a shortcut
 * around it: bytes an app ships are still bytes the daemon did not produce.
 */
async function importBundle(
  client: GezelClient,
  bundlePath: string,
  emit: (event: EnsureProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const size = await stat(bundlePath)
    .then((info) => info.size)
    .catch(() => undefined);
  emit({ phase: 'bundle', message: 'installing the bundled model', bytesTotal: size });
  const stream = Readable.toWeb(createReadStream(bundlePath)) as ReadableStream<Uint8Array>;
  const review = await client.scanModelBundle(stream, {
    signal,
    ...(size === undefined ? {} : { totalBytes: size }),
    onProgress: (progress) => {
      // Only the byte-moving phases carry counts; the inspection phases are a
      // label and nothing else.
      const counted = 'bytesCompleted' in progress ? progress : undefined;
      emit({
        phase: 'bundle',
        message: `installing the bundled model (${progress.phase})`,
        ...(counted ? { bytesCompleted: counted.bytesCompleted } : {}),
        ...(counted && 'bytesTotal' in counted && counted.bytesTotal !== undefined
          ? { bytesTotal: counted.bytesTotal }
          : {}),
      });
    },
  });
  try {
    signal?.throwIfAborted();
    await client.confirmModelBundleImport(review.importId);
  } catch (err) {
    // Another window, or a previous run, already published these bytes.
    if (err instanceof Error && /already installed/i.test(err.message)) return;
    await client.cancelModelBundleImport(review.importId).catch(() => {});
    throw err;
  }
}

async function downloadModel(
  app: GezelApp,
  engine: EnsureModelEngine,
  model: string,
  emit: (event: EnsureProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const qualified = `${engine}:${model}`;
  const ensure = await app.ensureModel({ model: qualified }, { signal }).catch((err: unknown) => {
    if (err instanceof GezelSdkError && err.code === 'model_not_found') {
      throw new GezelSdkError(
        `Gezel's catalog has no model "${model}" for ${engine}. Ship it as a .gezmodel bundle, or use a catalog id.`,
        { code: 'model_not_found', cause: err },
      );
    }
    throw err;
  });
  signal?.throwIfAborted();
  if (ensure.model_id !== qualified)
    throw new GezelSdkError('Preparation returned another model', { code: 'invalid_response' });
  if (ensure.status === 'ready') return;
  if (!ensure.job_id)
    throw new GezelSdkError('Preparation returned no job', { code: 'invalid_response' });
  let complete = false;

  emit({ phase: 'weights', message: `downloading ${model}` });
  for await (const event of app.streamEnsureEvents(ensure.job_id, { signal })) {
    if (signal?.aborted) throw new GezelSdkError('model download cancelled', { code: 'aborted' });
    if (event.modelId !== qualified || event.jobId !== ensure.job_id)
      throw new GezelSdkError('Preparation event identity changed', { code: 'invalid_response' });
    if (event.type === 'done') {
      complete = true;
      break;
    }
    if (event.type === 'progress') {
      emit({
        phase: 'weights',
        message: `downloading ${model}`,
        bytesWritten: event.bytesWritten,
        totalBytes: event.totalBytes,
      });
    } else if (event.type === 'error') {
      throw new GezelSdkError(`downloading ${model} failed: ${event.error}`, {
        code: 'model_download_failed',
      });
    }
  }
  signal?.throwIfAborted();
  if (!complete)
    throw new GezelSdkError('Model preparation stream ended before completion', {
      code: 'incomplete_stream',
    });
}

/**
 * Pin the model as the daemon's default.
 *
 * Default on for a daemon this app hosts (nothing else uses it, and hosting
 * skips the daemon's own first-run pin), default **off** against the user's
 * Gezel, where their chosen provider and model are theirs to set.
 */
async function maybePin(
  deps: EnsureModelDeps,
  engine: EnsureModelEngine,
  opts: EnsureModelOptions,
): Promise<boolean> {
  const shouldPin = opts.pinAsDefault ?? deps.owned;
  if (!shouldPin) return false;
  const config = await deps.client.getConfig();
  opts.signal?.throwIfAborted();
  await deps.client.updateConfig({
    provider: engine,
    defaultModel: { ...(config?.defaultModel ?? {}), [engine]: opts.model },
    firstRunCompleted: true,
  });
  return true;
}
