import { readFile, writeFile } from 'node:fs/promises';
import { ensureDir } from './fs-utils.js';

/**
 * Persistent state for incremental sync. Two files:
 *
 *   - `import-watermark.json` (committed): the most recent
 *     `_meta.publishedAt` we've successfully imported. Subsequent
 *     runs pass this as `updated_since` to the registry's list
 *     endpoint, so the cost of staying fresh is proportional to
 *     upstream churn rather than total catalog size.
 *
 *   - `import-slug-map.json` (committed): a stable map from upstream
 *     reverse-DNS name → assigned gezel slug. Persisting it ensures
 *     a re-run never reshuffles ids — once an entry is at, say,
 *     `fastly-mcp`, it stays there even if alphabetically-earlier
 *     entries appear later that would otherwise have claimed the
 *     base slug.
 *
 * Both files live under `packages/catalog/scripts/.import-state/`.
 */

export interface WatermarkState {
  /** Most recent `publishedAt` we've fully processed (RFC3339). */
  lastUpdatedAt?: string;
  /** ISO timestamp of when the last full run completed. */
  lastRunAt?: string;
  /** Schema version we last saw on upstream entries. */
  schemaSeen?: string;
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readWatermark(path: string): Promise<WatermarkState> {
  const data = await readJson<WatermarkState>(path);
  return data ?? {};
}

export async function readSlugMap(path: string): Promise<Record<string, string>> {
  const data = await readJson<Record<string, string>>(path);
  return data ?? {};
}
