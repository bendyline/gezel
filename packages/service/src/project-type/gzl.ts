import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type CatalogKind,
  type GzelBundleItem,
  type GzelBundleManifest,
  GzelBundleManifestSchema,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import AdmZip from 'adm-zip';
import { safeJoin } from '../fs/safe-paths.js';

const log = createLogger('gzl');

/**
 * `.gzl` share bundles — a renamed zip carrying a root `manifest.json` plus an
 * `items/` tree in the catalog on-disk layout. See docs/project-types.md.
 *
 * v1 packs/imports **project types** and the **gezel templates** they
 * reference. Toolsets are never embedded (a type references them by catalog id
 * + sha pin); scripts ride inline in the project-type manifest (sandboxed SDK
 * code). Nothing executes at import — import validates + copies into the local
 * catalog home, and the review step lists everything before anything lands.
 */

/** Singular kind → plural on-disk dir, for the two kinds `.gzl` carries. */
const KIND_DIR: Partial<Record<CatalogKind, string>> = {
  'project-type': 'project-types',
  'gezel-template': 'gezel-templates',
};

/** Kinds a `.gzl` may carry (D3: no toolset/model code embedded). */
const IMPORT_KINDS: ReadonlySet<CatalogKind> = new Set(['project-type', 'gezel-template']);

function shard(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

/** Hash an item's files (sorted) → hex. Path-delimited so a rename changes the hash. */
function hashItemFiles(files: Array<{ rel: string; content: Buffer }>): string {
  const hash = createHash('sha256');
  for (const { rel, content } of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

export interface PackBundleResult {
  buffer: Buffer;
  manifest: GzelBundleManifest;
}

/**
 * Pack a project type (and the gezel templates it references) into a `.gzl`
 * buffer. Every file under each item's catalog folder is included verbatim —
 * pages, seeds, and assets, not just the ones the manifest names.
 */
export async function packProjectTypeBundle(
  deps: { catalog: CatalogService },
  opts: {
    typeId: string;
    name?: string;
    description?: string;
    creator?: string;
    createdAt?: string;
    exportedFromProject?: string;
  },
): Promise<PackBundleResult> {
  const { catalog } = deps;
  const typeDetail = await catalog.get('project-type', opts.typeId);
  if (!typeDetail || typeDetail.manifest.kind !== 'project-type') {
    throw new Error(`project type ${opts.typeId} not found`);
  }

  // The type, plus each referenced gezel template (deduped).
  const targets: Array<{ kind: CatalogKind; id: string; version: string; sourceId: string }> = [
    {
      kind: 'project-type',
      id: opts.typeId,
      version: typeDetail.manifest.version,
      sourceId: typeDetail.sourceId,
    },
  ];
  const seen = new Set<string>([`project-type:${opts.typeId}`]);
  for (const g of typeDetail.manifest.gezels) {
    const key = `gezel-template:${g.templateId}`;
    if (seen.has(key)) continue;
    const gd = await catalog.get('gezel-template', g.templateId);
    if (!gd || gd.manifest.kind !== 'gezel-template') {
      log.warn(`[pack] gezel template ${g.templateId} not found — skipping`);
      continue;
    }
    seen.add(key);
    targets.push({
      kind: 'gezel-template',
      id: g.templateId,
      version: gd.manifest.version,
      sourceId: gd.sourceId,
    });
  }

  const zip = new AdmZip();
  const items: GzelBundleItem[] = [];
  for (const t of targets) {
    const dir = KIND_DIR[t.kind];
    if (!dir) continue;
    const itemPath = `${dir}/${shard(t.id)}/${t.id}`;
    const rels = await catalog.listItemFiles(t.kind, t.id, t.sourceId);
    const collected: Array<{ rel: string; content: Buffer }> = [];
    for (const rel of rels) {
      const buf = await catalog.readItemFile(t.kind, t.id, rel, t.sourceId);
      if (!buf) continue;
      collected.push({ rel, content: buf });
      zip.addFile(`items/${itemPath}/${rel}`, buf);
    }
    items.push({
      kind: t.kind,
      id: t.id,
      version: t.version,
      path: itemPath,
      sha256: hashItemFiles(collected),
    });
  }

  const manifest: GzelBundleManifest = {
    schemaVersion: 1,
    name: opts.name ?? typeDetail.manifest.name,
    description: opts.description ?? typeDetail.manifest.description,
    ...(opts.creator ? { creator: opts.creator } : {}),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    items,
    ...(opts.exportedFromProject
      ? { provenance: { exportedFromProject: opts.exportedFromProject } }
      : {}),
  };
  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { buffer: zip.toBuffer(), manifest };
}

export interface ReadBundleResult {
  manifest: GzelBundleManifest;
  /** Bundle-relative path (`items/…`) → file content. */
  files: Map<string, Buffer>;
}

/** Parse a `.gzl` buffer: validate the root manifest, collect item files. */
export function readGzlBundle(buffer: Buffer): ReadBundleResult {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`not a readable .gzl (zip) file: ${err instanceof Error ? err.message : err}`);
  }
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('not a .gzl bundle — no root manifest.json');
  const manifest = GzelBundleManifestSchema.parse(
    JSON.parse(manifestEntry.getData().toString('utf8')),
  );
  const files = new Map<string, Buffer>();
  for (const e of zip.getEntries()) {
    if (e.isDirectory || e.entryName === 'manifest.json') continue;
    if (!e.entryName.startsWith('items/')) continue;
    files.set(e.entryName, e.getData());
  }
  return { manifest, files };
}

/** Verify a parsed bundle: allowed kinds only, and each item's sha256 matches. */
export function verifyGzlBundle(result: ReadBundleResult): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const item of result.manifest.items) {
    if (!IMPORT_KINDS.has(item.kind)) {
      errors.push(`unsupported item kind "${item.kind}" (only project types + gezel roles)`);
      continue;
    }
    const prefix = `items/${item.path}/`;
    const collected: Array<{ rel: string; content: Buffer }> = [];
    for (const [k, content] of result.files) {
      if (k.startsWith(prefix)) collected.push({ rel: k.slice(prefix.length), content });
    }
    if (collected.length === 0) {
      errors.push(`item ${item.kind}/${item.id} has no files in the bundle`);
      continue;
    }
    if (hashItemFiles(collected) !== item.sha256) {
      errors.push(
        `sha256 mismatch for ${item.kind}/${item.id} — bundle may be corrupt or tampered`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface ImportBundleResult {
  manifest: GzelBundleManifest;
  /** Items the bundle wants to install — always returned (the review list). */
  items: Array<{ kind: CatalogKind; id: string; version: string }>;
  /** Set only when `confirm` was true and installation ran. */
  installed?: Array<{ kind: CatalogKind; id: string; version: string }>;
}

/**
 * Import a `.gzl`. Always validates schema + kinds + per-item sha256 first
 * (throws on failure — nothing is written). With `confirm: false` (the
 * default) it returns the review list without touching disk; with
 * `confirm: true` it copies each item into the local catalog home
 * (`{home}/{kindDir}/{shard}/{id}/…`), where the LocalCatalogSource picks it up.
 */
export async function importGzlBundle(
  deps: { home: string },
  buffer: Buffer,
  opts: { confirm?: boolean } = {},
): Promise<ImportBundleResult> {
  const parsed = readGzlBundle(buffer);
  const { ok, errors } = verifyGzlBundle(parsed);
  if (!ok) throw new Error(`bundle failed verification: ${errors.join('; ')}`);

  const items = parsed.manifest.items.map((i) => ({ kind: i.kind, id: i.id, version: i.version }));
  if (!opts.confirm) return { manifest: parsed.manifest, items };

  const installed: ImportBundleResult['installed'] = [];
  for (const item of parsed.manifest.items) {
    const base = safeJoin(deps.home, item.path);
    if (!base) {
      throw new Error(`unsafe item path in bundle: ${item.path}`);
    }
    const prefix = `items/${item.path}/`;
    for (const [k, content] of parsed.files) {
      if (!k.startsWith(prefix)) continue;
      const dest = safeJoin(base, k.slice(prefix.length));
      if (!dest) {
        throw new Error(`unsafe file path in bundle: ${k}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
    }
    installed.push({ kind: item.kind, id: item.id, version: item.version });
  }
  log.info(`[import] installed ${installed.length} item(s) from "${parsed.manifest.name}"`);
  return { manifest: parsed.manifest, items, installed };
}
