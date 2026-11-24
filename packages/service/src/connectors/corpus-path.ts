/**
 * How a path is compared with a connector's corpus folder. Decide on the file
 * a read will open, not on the path a model wrote: the first camera check
 * compared the raw string, and the readers then normalized it, so
 * `data/./mud-room/…`, `data//…`, `x/../data/…`, another letter case, or on
 * Windows a trailing dot or an 8.3 short name reached the corpus unseen
 * (1.26299.99 audit).
 */

import { realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import type { ProjectConnectorBinding } from '@bendyline/gezel';
import { slug } from './writer.js';

/**
 * An artifact path as the readers will resolve it, case-folded. Folding on
 * every platform withholds, at worst, a same-named file on a case-sensitive
 * volume; Windows' trailing dots and spaces are dropped for the same reason.
 */
export function artifactKey(raw: string): string {
  const normalized = posix
    .normalize(raw.replace(/\\/g, '/'))
    .split('/')
    .map((segment) =>
      segment === '.' || segment === '..' ? segment : segment.replace(/[. ]+$/, ''),
    )
    .join('/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/^artifacts(?:\/|$)/i, '')
    .replace(/\/+$/, '');
  return normalized.toLowerCase();
}

/** A file or folder's real path, folded where the filesystem folds case. */
export async function canonicalPath(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path));
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/**
 * Corpus root for a binding: `data/<slug(displayName || type)>`, suffixed
 * `-2`/`-3`… on collision with another binding's persisted root. Resolved once
 * (at bind time, or lazily for pre-corpusDir bindings) and persisted — never
 * recomputed, so renames don't strand corpora.
 */
export function resolveCorpusDir(
  existing: Pick<ProjectConnectorBinding, 'corpusDir'>[],
  type: string,
  displayName?: string,
): string {
  const taken = new Set(existing.map((b) => b.corpusDir).filter(Boolean));
  const base = `data/${displayName?.trim() ? slug(displayName) : slug(type)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The corpus root to use for a binding right now: the persisted `corpusDir`,
 * or the deterministic resolution a future sync will persist. Shared with the
 * action manager so drafts and records always land in the same corpus.
 */
export function corpusDirFor(
  bindings: ProjectConnectorBinding[],
  binding: ProjectConnectorBinding,
): string {
  if (binding.corpusDir) return binding.corpusDir;
  return resolveCorpusDir(
    bindings.filter((b) => b.id !== binding.id),
    binding.type,
    binding.displayName,
  );
}
