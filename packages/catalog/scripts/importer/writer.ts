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
 *     preserve `name`/`description`/`tags` (editorial fields a human
 *     may have curated). License is overwritten when the new value
 *     is permissive and disagrees with the stored one. `yankedVersions`
 *     is unioned across runs so a once-deprecated version stays
 *     yanked.
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
 * Merge an existing identity with a freshly-computed one. Editorial
 * fields a human may have curated (`name`, `description`, `tags`,
 * `logo`) win over the imported value. License is treated as a fact:
 * if the new value differs from the stored one, the new one wins.
 * `yankedVersions` is unioned.
 */
function mergeIdentity(existing: ToolsetIdentity, next: ToolsetIdentity): ToolsetIdentity {
  return {
    ...existing,
    // Always advance these — they're the import's responsibility, not
    // the human's.
    license: next.license ?? existing.license,
    maintainer: next.maintainer ?? existing.maintainer,
    yankedVersions: unionArr(existing.yankedVersions, next.yankedVersions),
    // Identity invariants — never change after first import.
    schemaVersion: 1,
    kind: 'toolset',
    id: existing.id,
    // Editorial — preserve existing if non-empty.
    name: existing.name?.trim() ? existing.name : next.name,
    description: existing.description?.trim() ? existing.description : next.description,
    tags: existing.tags && existing.tags.length > 0 ? existing.tags : next.tags,
    ...(existing.logo !== undefined
      ? { logo: existing.logo }
      : next.logo !== undefined
        ? { logo: next.logo }
        : {}),
    ...(existing.minSupportedVersion !== undefined
      ? { minSupportedVersion: existing.minSupportedVersion }
      : {}),
    // Category — keep existing when set (human override wins), else
    // adopt the freshly-computed one from the importer.
    ...(existing.category !== undefined
      ? { category: existing.category }
      : next.category !== undefined
        ? { category: next.category }
        : {}),
  };
}

function diffIdentityFields(a: ToolsetIdentity, b: ToolsetIdentity): string[] {
  const out: string[] = [];
  if (a.license !== b.license) out.push('license');
  if (JSON.stringify(a.maintainer) !== JSON.stringify(b.maintainer)) out.push('maintainer');
  if (JSON.stringify(a.yankedVersions) !== JSON.stringify(b.yankedVersions))
    out.push('yankedVersions');
  return out;
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
