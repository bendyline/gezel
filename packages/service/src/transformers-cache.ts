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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
