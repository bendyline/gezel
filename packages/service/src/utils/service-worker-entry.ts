import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Worker entries emitted beside the service bundles by tsup.
 *
 * Keep these paths relative to `dist/`: the resolver below deliberately
 * supports both service entrypoints (`dist/index.js` and
 * `dist/bin/gezeld.js`) plus raw-source development. Centralizing the list
 * prevents one worker from quietly reintroducing a bundle-shape assumption.
 */
export const SERVICE_WORKER_ENTRIES = {
  embeddings: { built: 'memory/embed-worker.js' },
  'image-embeddings': { built: 'memory/image-embed-worker.js' },
  'static-index': { built: 'index-store/static-index-worker.js' },
  'document-convert': {
    built: 'index-store/convert-worker.js',
    source: 'index-store/convert-worker.ts',
  },
  'gguf-metadata': { built: 'providers/llama-cpp/gguf-metadata-worker.js' },
} as const;

export type ServiceWorkerEntry = keyof typeof SERVICE_WORKER_ENTRIES;

const MAX_ANCESTOR_DEPTH = 8;

/**
 * Find a service runtime resource without assuming which tsup entry bundled
 * the calling module.
 *
 * `import.meta.url` points at `dist/index.js` in embedded mode and at
 * `dist/bin/gezeld.js` in every spawned/package mode. Walking upward and
 * probing both an ancestor itself and its `dist/` child also covers raw-source
 * development with a previously-built dist tree. All candidates are fixed,
 * repository-authored relative paths; no user input reaches this resolver.
 */
export function findServiceBundleResource(
  moduleUrl: string,
  relativePaths: readonly string[],
): string | null {
  let dir = dirname(fileURLToPath(moduleUrl));
  const visited = new Set<string>();

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    for (const root of [dir, join(dir, 'dist')]) {
      for (const relativePath of relativePaths) {
        const candidate = resolve(root, relativePath);
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        if (existsSync(candidate)) return candidate;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Resolve one of the service's separately-emitted worker entrypoints. */
export function findServiceWorkerEntry(
  moduleUrl: string,
  worker: ServiceWorkerEntry,
): string | null {
  const entry = SERVICE_WORKER_ENTRIES[worker];
  return findServiceBundleResource(moduleUrl, [
    entry.built,
    ...('source' in entry ? [entry.source] : []),
  ]);
}
