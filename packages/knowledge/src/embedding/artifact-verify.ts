/**
 * Verifies the model files an embedder loaded against the digests its
 * profile pins. transformers.js caches every fetched file under a key that
 * mirrors the repo path — `<repo>/<file>` for `main`, `<repo>/<revision>/<file>`
 * for a pinned revision — so after a load the exact bytes are on disk and
 * can be hashed. That turns "same repo and revision" from a convention into
 * a checked fact: a profile that declares digests is served only by weights
 * whose sha256 matches them, and a mismatch is reported as a different
 * vector space rather than silently producing slightly different vectors.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type KnowledgeEmbeddingProfile, embeddingProfileArtifacts } from '@bendyline/gezk';

export type ArtifactRole = 'onnx' | 'tokenizer';

export interface ArtifactCheck {
  role: ArtifactRole;
  /** Repo-relative file the profile pins. */
  file: string;
  /** Where the loaded copy was looked for. */
  path: string;
  expected: string;
  /** `null` when no file was found at `path`. */
  actual: string | null;
}

export interface VerifiedArtifacts {
  /** `unpinned` when the profile declares no digests, so nothing was checked. */
  status: 'verified' | 'unpinned';
  checks: ArtifactCheck[];
}

export class EmbedderArtifactError extends Error {
  readonly isActionable = true;
  constructor(
    readonly reason: 'missing' | 'mismatch',
    readonly profileId: string,
    readonly checks: ArtifactCheck[],
  ) {
    super(describeFailure(reason, profileId, checks));
    this.name = 'EmbedderArtifactError';
  }
}

function describeFailure(
  reason: 'missing' | 'mismatch',
  profileId: string,
  checks: ArtifactCheck[],
): string {
  const detail = checks
    .filter((c) => c.actual !== c.expected)
    .map((c) =>
      c.actual === null
        ? `${c.file} not found at ${c.path}`
        : `${c.file} is ${c.actual}, profile pins ${c.expected}`,
    )
    .join('; ');
  return reason === 'missing'
    ? `cannot verify the model files for profile ${profileId}: ${detail}`
    : `the model files loaded for profile ${profileId} differ from the ones it pins: ${detail}`;
}

/** The transformers.js FileCache key for one repo file. */
export function transformersCachePath(
  cacheDir: string,
  repo: string,
  revision: string,
  file: string,
): string {
  return revision === 'main' ? join(cacheDir, repo, file) : join(cacheDir, repo, revision, file);
}

// Digests are memoized per (path, size, mtime): the daemon rebuilds an idle
// embedder every ten minutes, and re-hashing a 470 MB graph each time would
// be pure cost. A changed file changes its key and is hashed afresh.
const digestMemo = new Map<string, string>();
const DIGEST_MEMO_MAX = 32;

async function fileDigest(path: string): Promise<string | null> {
  let size: number;
  let mtimeMs: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    size = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return null;
  }
  const key = `${path} ${size} ${mtimeMs}`;
  const memo = digestMemo.get(key);
  if (memo) return memo;
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
  if (digestMemo.size >= DIGEST_MEMO_MAX) {
    const oldest = digestMemo.keys().next().value;
    if (oldest !== undefined) digestMemo.delete(oldest);
  }
  digestMemo.set(key, digest);
  return digest;
}

/**
 * Hash the profile's pinned files in a transformers.js cache and compare.
 * `revision` names the cache key the files were fetched under; it defaults
 * to the profile's own revision and is `main` for a pipeline loaded
 * unpinned. Throws `EmbedderArtifactError` on a missing or differing file.
 */
export async function verifyProfileArtifacts(
  profile: KnowledgeEmbeddingProfile,
  opts: { cacheDir: string; revision?: string },
): Promise<VerifiedArtifacts> {
  const artifacts = embeddingProfileArtifacts(profile);
  const revision = opts.revision ?? profile.model.revision;
  const pinned: Array<{ role: ArtifactRole; file: string; expected: string }> = [];
  if (artifacts.onnxDigest) {
    pinned.push({ role: 'onnx', file: artifacts.onnxFile, expected: artifacts.onnxDigest });
  }
  if (artifacts.tokenizerDigest) {
    pinned.push({
      role: 'tokenizer',
      file: artifacts.tokenizerFile,
      expected: artifacts.tokenizerDigest,
    });
  }
  if (pinned.length === 0) return { status: 'unpinned', checks: [] };

  const checks: ArtifactCheck[] = [];
  for (const { role, file, expected } of pinned) {
    const path = transformersCachePath(opts.cacheDir, profile.model.repo, revision, file);
    checks.push({ role, file, path, expected, actual: await fileDigest(path) });
  }
  if (checks.some((c) => c.actual === null)) {
    throw new EmbedderArtifactError('missing', profile.id, checks);
  }
  if (checks.some((c) => c.actual !== c.expected)) {
    throw new EmbedderArtifactError('mismatch', profile.id, checks);
  }
  return { status: 'verified', checks };
}
