/**
 * Why `import('@huggingface/transformers')` failed. Two causes need different
 * messages: the package itself is absent (an optional peer that an npm
 * install omits, which is a supported configuration), or it is installed but
 * cannot load because something it imports is missing. The second used to be
 * reported as the first: a workspace whose hoisted `onnxruntime-common` link
 * had disappeared said "the embedding runtime is not installed" while
 * transformers sat in node_modules.
 *
 * Internal: deliberately not re-exported from the package index.
 */

export const TRANSFORMERS_MODULE = '@huggingface/transformers';

/**
 * Keep ONNX Runtime's telemetry off before transformers loads it. A copy of
 * `disableOnnxRuntimeTelemetry` in core's `native/onnx-telemetry.ts`, which
 * says why; this package must not depend on core. Effective only on the main
 * thread, where a library caller building a catalog runs it.
 */
export function disableOnnxRuntimeTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.ORT_DISABLE_TELEMETRY) env.ORT_DISABLE_TELEMETRY = '1';
}

/**
 * The specifier Node could not resolve, or null when `err` is not a
 * resolution failure. Matched on the resolver's error code, then read from
 * its message, because a failure *inside* a package also mentions that
 * package's name.
 */
export function unresolvedSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const { code } = err as { code?: unknown };
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return null;
  return /Cannot find (?:package|module) '([^']+)'/.exec(err.message)?.[1] ?? null;
}

/** `@huggingface/transformers` is installed, but `missing`, which it imports, is not. */
export class TransformersDependencyMissingError extends Error {
  readonly isActionable = true;
  readonly missing: string;
  constructor(missing: string, peerRange: string, cause: unknown) {
    super(
      `${TRANSFORMERS_MODULE} is installed but cannot load: Node cannot find '${missing}', which it imports. Reinstall ${TRANSFORMERS_MODULE}@${peerRange} together with its dependencies`,
      { cause },
    );
    this.name = 'TransformersDependencyMissingError';
    this.missing = missing;
  }
}
