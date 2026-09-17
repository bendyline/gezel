/**
 * Shared cache-dir pinning for every `@huggingface/transformers` consumer
 * in the service (kokoro TTS + memory embeddings).
 *
 * transformers.js v3 derives its model cache dir from the transformers
 * module's OWN on-disk location (`<module>/../.cache/`) and has NO env-var
 * override — it ignores `TRANSFORMERS_CACHE`. In a packaged/bundled runtime
 * that directory isn't writable, so a downloaded model never lands as a
 * cached file and the Node ONNX path-resolver throws "Unable to get model
 * file path or buffer". Pinning `env.cacheDir` to a writable, gezel-managed
 * dir before the first `from_pretrained` / `pipeline` call fixes it.
 *
 * Both consumers import the same ESM-node transformers build
 * (`transformers.node.mjs`), so the `env` object we mutate here is the one
 * the model loader reads `cacheDir` from at download time.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('service');

/**
 * Env var carrying the resolved cache dir to processes that don't otherwise
 * know the gezel home — notably the embed worker thread, which inherits
 * `process.env` at spawn. Set once at service boot.
 */
export const HF_CACHE_DIR_ENV = 'GEZEL_HF_CACHE_DIR';

/** Shared writable HF/transformers cache root for on-device model files. */
export function transformersCacheDir(home: string): string {
  return join(home, 'engines', 'hf-cache');
}

/** The optional peer both TTS and memory embeddings load lazily. */
export const TRANSFORMERS_MODULE = '@huggingface/transformers';

const DEFAULT_MODEL_LOCK_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MODEL_LOCK_STALE_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_MODEL_LOCK_POLL_MS = 100;

export interface TransformersModelCacheLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
}

function modelLockDir(cacheDir: string, modelId: string): string {
  const key = createHash('sha256').update(modelId, 'utf8').digest('hex').slice(0, 24);
  return join(cacheDir, '.gezel-locks', `${key}.lock`);
}

function cacheModelDir(cacheDir: string, modelId: string): string {
  const parts = modelId.split('/');
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
  ) {
    throw new Error(`refusing unsafe transformers model id: ${modelId}`);
  }
  const root = resolve(cacheDir);
  const target = resolve(root, ...parts);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing transformers cache path outside ${root}: ${modelId}`);
  }
  return target;
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null | undefined)?.code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function staleOrMissing(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > staleMs;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return true;
    throw err;
  }
}

/**
 * Serialize first-use model downloads across service/Vitest processes sharing
 * one transformers cache. `pipelinePromise` prevents duplicate loads inside a
 * process; this directory lock closes the remaining cross-process race where
 * two fetches could replace the same ONNX file and leave one worker parsing a
 * partial protobuf.
 */
export async function withTransformersModelCacheLock<T>(
  cacheDir: string,
  modelId: string,
  run: () => Promise<T>,
  options: TransformersModelCacheLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_MODEL_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_MODEL_LOCK_POLL_MS;
  const lockDir = modelLockDir(cacheDir, modelId);
  await mkdir(dirname(lockDir), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (await staleOrMissing(lockDir, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for transformers cache lock for ${modelId}`);
      }
      await delay(pollMs);
    }
  }

  try {
    await writeFile(
      join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, modelId, acquiredAt: new Date().toISOString() })}\n`,
    );
    return await run();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/** Remove only the named repository directory after a proven cache parse failure. */
export async function removeTransformersModelCache(
  cacheDir: string,
  modelId: string,
): Promise<void> {
  await rm(cacheModelDir(cacheDir, modelId), { recursive: true, force: true });
}

/** Failures that mean retrying against the same cached bytes cannot succeed. */
export function isCorruptTransformersCacheFailure(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return /(?:protobuf parsing failed|failed to parse protobuf|invalid protobuf|unexpected end of (?:file|data)|failed to load model|load model .* failed|invalid wire type)/i.test(
    messages.join(' '),
  );
}

/**
 * Load a model under its cross-process lock, replacing only its repository
 * cache and retrying once when the first load proves those bytes corrupt.
 */
export async function loadTransformersModelWithCacheRecovery<T>(
  cacheDir: string,
  modelId: string,
  load: () => Promise<T>,
  onCorrupt?: () => void | Promise<void>,
): Promise<T> {
  return withTransformersModelCacheLock(cacheDir, modelId, async () => {
    try {
      return await load();
    } catch (err) {
      if (!isCorruptTransformersCacheFailure(err)) throw err;
      await onCorrupt?.();
      await removeTransformersModelCache(cacheDir, modelId);
      return await load();
    }
  });
}

/**
 * True when Node is reporting that `specifier` itself is not installed, rather
 * than the package being present and failing to load.
 *
 * `@huggingface/transformers` and `kokoro-js` are optional peers that an
 * ordinary npm install omits, so absence is a supported configuration and must
 * be distinguishable from breakage before anything picks a log level. Matched
 * on the resolver's error code plus the specifier it names, not on a substring
 * of the message: a genuine failure *inside* transformers also mentions the
 * package, and used to be misreported as "not installed".
 */
export function isMissingModule(err: unknown, specifier: string): boolean {
  if (!(err instanceof Error)) return false;
  const { code } = err as NodeJS.ErrnoException;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`Cannot find (?:package|module) '${escaped}'`).test(err.message);
}

/** The mutable subset of transformers' `env` we touch. */
export interface TransformersEnv {
  cacheDir: string;
  useFSCache: boolean;
  allowRemoteModels: boolean;
}

export type LoadTransformersEnv = () => Promise<TransformersEnv>;

async function defaultLoadEnv(): Promise<TransformersEnv> {
  const mod = (await import('@huggingface/transformers')) as unknown as { env: TransformersEnv };
  return mod.env;
}

const pinned = new Set<string>();
let globalsAligned = false;

/**
 * transformers.js decides whether to WRITE a downloaded file to its FS cache
 * with `response instanceof Response`, reading the *global* `Response`. In the
 * bundled daemon, some dependency leaves `globalThis.fetch` and
 * `globalThis.Response` sourced from different realms — so a real fetch's
 * response fails `instanceof Response`, transformers caches NOTHING, and the
 * ONNX load (which resolves by cached file path) throws "Unable to get model
 * file path or buffer". Re-sourcing `fetch` + `Response` + friends from one
 * `undici` restores the invariant, so caching (and offline reuse) works.
 *
 * `undici` IS Node's own fetch implementation, so this is a functional no-op
 * for callers — it only realigns the class identities. Best-effort.
 */
async function alignFetchGlobals(): Promise<void> {
  if (globalsAligned) return;
  try {
    const u = (await import('undici')) as unknown as Record<string, unknown>;
    const g = globalThis as unknown as Record<string, unknown>;
    for (const k of ['fetch', 'Response', 'Headers', 'Request', 'FormData', 'File', 'Blob']) {
      if (typeof u[k] !== 'undefined') g[k] = u[k];
    }
    globalsAligned = true;
  } catch (err) {
    log.warn(`could not align fetch globals: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Point transformers.js at `cacheDir` (and repair the fetch/Response global
 * mismatch that otherwise defeats its cache). Idempotent per dir, and
 * best-effort: on failure we log and let the caller proceed on the upstream
 * default rather than hard-failing (worst case the original bug resurfaces,
 * which is no worse than not calling this).
 */
export async function pinTransformersCacheDir(
  cacheDir: string,
  loadEnv: LoadTransformersEnv = defaultLoadEnv,
): Promise<void> {
  await alignFetchGlobals();
  if (pinned.has(cacheDir)) return;
  try {
    await mkdir(cacheDir, { recursive: true });
    const env = await loadEnv();
    env.cacheDir = cacheDir;
    env.useFSCache = true;
    env.allowRemoteModels = true;
    pinned.add(cacheDir);
  } catch (err) {
    if (isMissingModule(err, TRANSFORMERS_MODULE)) {
      // Optional peer absent — nothing to pin, and nothing wrong. The caller
      // that actually needs the model surfaces the actionable install message.
      log.debug(`skipped transformers cache pin: ${TRANSFORMERS_MODULE} is not installed`);
      return;
    }
    log.warn(
      `could not pin transformers cache dir "${cacheDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
