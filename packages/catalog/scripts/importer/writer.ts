import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ToolsetIdentity,
  ToolsetIdentitySchema,
  type ToolsetVersionManifest,
  ToolsetVersionManifestSchema,
} from '@bendyline/gezel';
import { writeJsonAtomic } from './fs-utils.js';

export type WriteOutcome =
  | { kind: 'created'; identityPath: string; versionPath: string }
  | { kind: 'updated'; identityPath: string; versionPath: string; mergedFields: string[] }
  | { kind: 'noop'; identityPath: string; versionPath: string }
  | {
      kind: 'integrity-violation';
      identityPath: string;
      versionPath: string;
      detail: string;
    };

export interface WriteOptions {
  /** Root for community catalog data, e.g. the gilde checkout's `data/community/`. */
  root: string;
  /** When true, computes the outcome but doesn't touch disk. */
  dryRun?: boolean;
}

/**
 * Persist a (identity, version) pair to disk under
 * `{root}/toolsets/{shard}/{slug}/`. Merging rules:
 *
 *   - Identity manifest: if it already exists with the same slug,
 *     refresh registry-owned metadata such as `name`, `description`,
 *     `tags`, maintainer, license, and derived category. Community
 *     manifests are bot-managed, so preserving an earlier imported
 *     description would leave stale upstream facts in the catalog.
 *     Local-only fields absent from the imported identity (for example
 *     `logo` or `minSupportedVersion`) survive via the merge. The
 *     `yankedVersions` arrays are unioned across runs so a
 *     once-deprecated version stays yanked.
 *
 *   - Version manifest: if a manifest at the same `versions/{ver}/`
 *     already exists, compare the stored `runtime.sha256` with the
 *     new one (npm-package only). Match → no-op. Mismatch → return
 *     an `integrity-violation` outcome and refuse to overwrite. Same
 *     filename existing for `http-mcp` → no-op (no integrity field).
 */
export async function writeToolset(
  identity: ToolsetIdentity,
  version: ToolsetVersionManifest,
  opts: WriteOptions,
): Promise<WriteOutcome> {
  ToolsetIdentitySchema.parse(identity);
  ToolsetVersionManifestSchema.parse(version);

  const itemDir = join(opts.root, 'toolsets', shardOf(identity.id), identity.id);
  const identityPath = join(itemDir, 'manifest.json');
  const versionPath = join(itemDir, 'versions', version.version, 'manifest.json');

  const existingIdentity = await readJson<ToolsetIdentity>(identityPath);
  const existingVersion = await readJson<ToolsetVersionManifest>(versionPath);

  if (existingVersion) {
    const conflict = detectIntegrityConflict(existingVersion, version);
    if (conflict) {
      return { kind: 'integrity-violation', identityPath, versionPath, detail: conflict };
    }
  }

  const mergedIdentity = existingIdentity ? mergeIdentity(existingIdentity, identity) : identity;
  const mergedFields = existingIdentity ? diffIdentityFields(existingIdentity, mergedIdentity) : [];

  const identityChanged = existingIdentity ? mergedFields.length > 0 : true;
  const versionChanged = !existingVersion || !shallowEqual(existingVersion, version);

  if (!identityChanged && !versionChanged) {
    return { kind: 'noop', identityPath, versionPath };
  }

  if (!opts.dryRun) {
    if (identityChanged) await writeJsonAtomic(identityPath, mergedIdentity);
    if (versionChanged) await writeJsonAtomic(versionPath, version);
  }

  if (existingIdentity || existingVersion) {
    return { kind: 'updated', identityPath, versionPath, mergedFields };
  }
  return { kind: 'created', identityPath, versionPath };
}

function detectIntegrityConflict(
  existing: ToolsetVersionManifest,
  next: ToolsetVersionManifest,
): string | null {
  if (existing.runtime.kind === 'npm-package' && next.runtime.kind === 'npm-package') {
    if (existing.runtime.sha256 !== next.runtime.sha256) {
      return `npm sha256 changed for ${existing.runtime.package}@${existing.runtime.version}: ${existing.runtime.sha256} → ${next.runtime.sha256}`;
    }
  }
  return null;
}

/**
 * Merge an existing identity with a freshly-computed one. Community
 * identities are bot-managed: fields present in the freshly-computed
 * identity are registry-owned and advance with upstream. Existing
 * local-only fields that the mapper does not emit survive the spread.
 * `yankedVersions` is unioned rather than replaced.
 */
function mergeIdentity(existing: ToolsetIdentity, next: ToolsetIdentity): ToolsetIdentity {
  return {
    ...existing,
    ...next,
    yankedVersions: unionArr(existing.yankedVersions, next.yankedVersions),
    // Identity invariants — never change after first import.
    schemaVersion: 1,
    kind: 'toolset',
    id: existing.id,
  };
}

function diffIdentityFields(a: ToolsetIdentity, b: ToolsetIdentity): string[] {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

function unionArr<T>(a: T[] | undefined, b: T[] | undefined): T[] {
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shardOf(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
