import { join } from 'node:path';
import {
  CRAFTBOOK_TEST_FILENAME,
  type CatalogItemDetail,
  type CatalogItemIdentity,
  CatalogItemIdentitySchema,
  type CatalogItemManifest,
  CatalogItemManifestSchema,
  type CatalogItemSummary,
  type CatalogItemVersionInfo,
  type CatalogKind,
  ChatModelVersionManifestSchema,
  ConnectorTypeVersionManifestSchema,
  type CraftbookDoc,
  CraftbookTemplateVersionManifestSchema,
  type CraftbookTestSpec,
  GEZEL_CONTENT_COMPAT,
  GezelTemplateVersionManifestSchema,
  ImageModelVersionManifestSchema,
  KnowledgeCatalogVersionManifestSchema,
  ProjectTypeVersionManifestSchema,
  ToolsetVersionManifestSchema,
  VideoModelVersionManifestSchema,
  compareSemver,
  createLogger,
  expandStepDeliverables,
  formatCraftbookDocErrors,
  isSemver,
  maxMinGezelVersion,
  parseCraftbookDoc,
  parseCraftbookDocValue,
  parseCraftbookTestSpec,
  parseTolerant,
  satisfiesMinGezelVersion,
} from '@bendyline/gezel';
import { sanitizePresentationSvg } from '@bendyline/gezel/svg';
import { z } from 'zod';
import { categorizeToolset } from './categorize.js';
import { type ContentTree, openContentTree } from './content-tree.js';
import { gildeDataDir } from './gilde-data.js';

// Through the core logger, not console: a library that writes straight to
// stderr cannot be silenced by GEZEL_LOG_LEVEL or routed by its host.
const log = createLogger('catalog');

/**
 * Parse content with this build's schema, tolerantly (see `parseTolerant`):
 * gilde ships on its own schedule, so values written for a newer gezel are
 * dropped rather than failing the item. Throws the strict issues when the
 * content is structurally incompatible, so callers keep the catch they had.
 */
function readContent<S extends z.ZodType>(schema: S, raw: unknown, where: string): z.output<S> {
  const result = parseTolerant(schema, raw);
  if (!result.ok) throw new z.ZodError(result.issues);
  noteIgnored(where, result.ignored);
  return result.data;
}

const notedIgnored = new Set<string>();

/**
 * Once per file per process: content ahead of this build is a steady state,
 * not an error, but a value that quietly disappears is how three craftbooks
 * shipped without their artifact flags, so it is never silent either.
 */
function noteIgnored(where: string, ignored: string[]): void {
  if (ignored.length === 0 || notedIgnored.has(where)) return;
  notedIgnored.add(where);
  const shown = ignored.slice(0, 5).join(', ');
  const more = ignored.length > 5 ? ` (+${ignored.length - 5} more)` : '';
  log.info(`${where}: ignored what this build does not understand — ${shown}${more}`);
}

/**
 * gilde's file-bundle index, one per kind directory beside the legacy
 * `index.json`. Each entry snapshots an item's own files as raw JSON — the
 * identity manifest, every version's stamp, and the newest version's
 * payload — so gilde needs no schema, no version policy, and no copy of the
 * merge below to write it, and this build turns it into manifests with the
 * same resolver it runs over the item folders.
 */
export const FILE_INDEX_FILENAME = 'raw-index.json';

/** A version folder as discovery sees it: its payload's own stamp. */
interface VersionStamp {
  version: string;
  releasedAt: string;
  minGezelVersion?: string;
}

/**
 * An item's own files, as the resolver reads them: from the item folder, or
 * from the file-bundle index. One resolver over both is what keeps a listing
 * from disagreeing with a detail read.
 */
interface ItemFiles {
  /** The on-disk path of an item-relative file, for messages. */
  path(rel: string): string;
  /** An item-relative JSON file: undefined when absent, throws when unparseable. */
  json(rel: string): Promise<unknown>;
  /** Every version folder whose payload stamps its own folder name. */
  versions(): Promise<VersionStamp[]>;
}

interface FileIndexEntry {
  id: string;
  identity: unknown;
  versions: VersionStamp[];
  latest?: { version: string; file: string; payload: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readVersionStamp(raw: unknown): VersionStamp | null {
  if (!isRecord(raw) || typeof raw.version !== 'string' || typeof raw.releasedAt !== 'string') {
    return null;
  }
  return {
    version: raw.version,
    releasedAt: raw.releasedAt,
    ...(typeof raw.minGezelVersion === 'string' ? { minGezelVersion: raw.minGezelVersion } : {}),
  };
}

function readFileIndexEntry(raw: unknown): FileIndexEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isRecord(raw.identity)) return null;
  const versions = Array.isArray(raw.versions)
    ? raw.versions.map(readVersionStamp).filter((v): v is VersionStamp => v !== null)
    : [];
  const latest = raw.latest;
  const hasLatest =
    isRecord(latest) &&
    typeof latest.version === 'string' &&
    typeof latest.file === 'string' &&
    isRecord(latest.payload);
  return {
    id: raw.id,
    identity: raw.identity,
    versions,
    ...(hasLatest
      ? { latest: { version: latest.version, file: latest.file, payload: latest.payload } }
      : {}),
  } as FileIndexEntry;
}

/**
 * Serves what the snapshot carries and reads everything else — an older
 * version a `minGezelVersion` floor picked — from the item folder.
 */
class IndexedItemFiles implements ItemFiles {
  constructor(
    private readonly entry: FileIndexEntry,
    private readonly folder: ItemFiles,
  ) {}

  path(rel: string): string {
    return this.folder.path(rel);
  }

  async json(rel: string): Promise<unknown> {
    if (rel === 'manifest.json') return this.entry.identity;
    const latest = this.entry.latest;
    if (latest && rel === `versions/${latest.version}/${latest.file}`) return latest.payload;
    // Discovery takes craftbook.json over manifest.json, so a snapshot of
    // the latter means the version folder has no craftbook.json.
    if (latest?.file === 'manifest.json' && rel === `versions/${latest.version}/craftbook.json`) {
      return undefined;
    }
    return this.folder.json(rel);
  }

  async versions(): Promise<VersionStamp[]> {
    return this.entry.versions;
  }
}

/**
 * ─ CatalogSource ───────────────────────────────────────────────────
 *
 * Abstracts where catalog items live. One implementation today:
 *
 *   - BundledSource:  reads the on-disk `data/` directory of the pinned
 *                     `@bendyline/gilde` content package. Always available,
 *                     zero network. Opt-in live content updates do not add
 *                     a second source: the service's GildeUpdateManager
 *                     swaps the directory this source reads.
 *
 * The CatalogService (see service.ts) composes multiple sources.
 *
 * On-disk layout under `data/`:
 *
 *   {kind-plural}/{shard}/{id}/manifest.json     ← identity layer
 *   {kind-plural}/{shard}/{id}/versions/{semver}/manifest.json  ← per-version
 *   {kind-plural}/{shard}/{id}/versions/{semver}/about.md       ← (templates) prompt
 *
 * Craftbook templates (V2) replace the per-version manifest + about.md +
 * scripts/ with ONE `versions/{semver}/craftbook.json` (a CraftbookDoc:
 * prose inlined as `description`, scripts inlined as the `scripts` map).
 * The legacy layout is still read as a fallback — user/community roots
 * may carry it.
 *
 * Any root may instead hold a single `content.pack` (see content-pack.ts)
 * carrying that same tree verbatim; packaged builds ship the community tier
 * that way. Reads go through `ContentTree`, so both forms behave identically.
 */
export interface CatalogSource {
  readonly id: string;
  readonly label: string;

  listKinds(): Promise<CatalogKind[]>;
  list(kind: CatalogKind): Promise<CatalogItemSummary[]>;
  /** When `version` is omitted, returns the auto-resolved latest. */
  get(kind: CatalogKind, id: string, version?: string): Promise<CatalogItemDetail | null>;
  /** All versions of an item, newest first. Empty when item is missing. */
  listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]>;
  /**
   * Read a file relative to an item's folder. When `version` is set, the
   * version subfolder is checked first; misses fall through to the item
   * root so shared assets (`logo.svg`) don't have to be duplicated per
   * version.
   */
  readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    version?: string,
  ): Promise<Buffer | null>;
  /**
   * Optional: every file under an item's folder as item-relative paths. Only
   * on-disk sources implement it (used by the `.gezapp` exporter); synthetic
   * sources (builtin toolsets) omit it.
   */
  listItemFiles?(kind: CatalogKind, id: string): Promise<string[]>;
  /**
   * Optional: a craftbook's eval descriptor (`versions/<v>/test.json`),
   * tolerant-parsed. Null when the book, version, or sidecar is missing
   * or unparseable. Only on-disk craftbook sources implement it.
   */
  getCraftbookTestSpec?(
    id: string,
    version?: string,
  ): Promise<{ version: string; spec: CraftbookTestSpec } | null>;
}

const KINDS: CatalogKind[] = [
  'toolset',
  'gezel-template',
  'craftbook-template',
  'project-type',
  'connector-type',
  'chat-model',
  'image-model',
  'video-model',
  'knowledge-catalog',
];

/**
 * Singular `kind` → plural directory name on disk. Plural reads more
 * naturally in a GitHub directory tree, but the wire schema (and HTTP
 * route) is singular per item.
 */
const KIND_DIR: Record<CatalogKind, string> = {
  toolset: 'toolsets',
  'gezel-template': 'gezel-templates',
  'craftbook-template': 'craftbook-templates',
  'project-type': 'project-types',
  'connector-type': 'connector-types',
  'chat-model': 'chat-models',
  'image-model': 'image-models',
  'video-model': 'video-models',
  'knowledge-catalog': 'knowledge-catalogs',
};

function shardPrefix(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

/**
 * A directory enumeration is legitimately "nothing here" only when the path
 * is absent (`ENOENT`) or is a plain file rather than a directory (`ENOTDIR`,
 * e.g. a stray file sitting in a kind dir). Every other `readdir` failure —
 * `EMFILE`/`ENFILE` (fd exhaustion under a heavy concurrent download),
 * `EACCES`, `EIO` — is a real error. Swallowing those as "empty" makes the
 * catalog silently report zero items, which surfaces to the user as models
 * that vanished. Callers must let real errors propagate so the request fails
 * loud (and the UI can retry) instead of showing a phantom-empty catalog.
 */
function isAbsentDir(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Resolve the default bundled data dir: the @bendyline/gilde package. */
function defaultBundledDataDir(): string {
  return gildeDataDir();
}

export interface BundledSourceOptions {
  /**
   * Override the on-disk root. Defaults to `data/` next to this package.
   * A function is re-read on every disk access — the live gilde update
   * mechanism uses this to flip the content root without reconstructing
   * the source (CatalogService is built once at boot and held by many
   * subsystems). A string keeps the historical freeze-at-construct
   * behavior.
   */
  dataDir?: string | (() => string);
  /** Source id surfaced via `CatalogService.listSources()`. */
  id?: string;
  /** Human-readable label. */
  label?: string;
  /**
   * When true, skip the per-kind `index.json` fast-path and always walk
   * the per-item folders. Used by the index builder itself (see
   * gilde `tools/build-index.mjs`) to avoid feeding a stale or absent index
   * back into itself, and by tests that want deterministic disk reads.
   */
  noIndex?: boolean;
  /**
   * The calendar line this build sits on, compared against content
   * `minGezelVersion` floors. Defaults to `GEZEL_CONTENT_COMPAT`; injectable so
   * tests can exercise gating against a stamped build (both constants are
   * `0.0.0` in dev checkouts, which bypasses all filtering).
   *
   * Deliberately **not** `GEZEL_VERSION`. Floors are authored as `1.YYDDD`, and
   * npm releases are semver: `0.1.0` and `1.0.0` fall below every floor while a
   * later `2.0.0` clears all of them, so gating on the published version made
   * npm builds hide floored content and would eventually have made them accept
   * content they cannot run.
   */
  gezelVersion?: string;
}

export class BundledSource implements CatalogSource {
  readonly id: string;
  readonly label: string;
  private readonly rootProvider: () => string;
  private readonly useIndex: boolean;
  private readonly gezelVersion: string;
  private tree: { root: string; tree: Promise<ContentTree> } | null = null;

  constructor(options: BundledSourceOptions | string = {}) {
    // Back-compat: old positional `root: string` signature.
    const opts: BundledSourceOptions = typeof options === 'string' ? { dataDir: options } : options;
    const dataDir = opts.dataDir;
    if (typeof dataDir === 'function') {
      this.rootProvider = dataDir;
    } else {
      const fixed = dataDir ?? defaultBundledDataDir();
      this.rootProvider = () => fixed;
    }
    this.id = opts.id ?? 'bundled';
    this.label = opts.label ?? 'Bundled';
    this.useIndex = !opts.noIndex;
    this.gezelVersion = opts.gezelVersion ?? GEZEL_CONTENT_COMPAT;
  }

  private get root(): string {
    return this.rootProvider();
  }

  /** The reader for the current root, re-resolved when the provider flips. */
  private contentTree(): Promise<ContentTree> {
    const root = this.root;
    if (this.tree?.root !== root) this.tree = { root, tree: openContentTree(root) };
    return this.tree.tree;
  }

  private async readBytes(path: string): Promise<Buffer> {
    return (await this.contentTree()).readFile(path);
  }

  private async readText(path: string): Promise<string> {
    return (await this.readBytes(path)).toString('utf8');
  }

  private async listDir(path: string): Promise<string[]> {
    return (await this.contentTree()).readdir(path);
  }

  /** True when this build satisfies a content `minGezelVersion` floor. */
  private floorSatisfied(floor: string | undefined): boolean {
    return satisfiesMinGezelVersion(floor, this.gezelVersion);
  }

  async listKinds(): Promise<CatalogKind[]> {
    return KINDS;
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (this.useIndex) {
      const bundled = await this.listFromFileIndex(kind);
      if (bundled) return bundled;
      const indexed = await this.listFromIndex(kind);
      if (indexed) return indexed;
    }
    return this.listFromDisk(kind);
  }

  private summary(kind: CatalogKind, manifest: CatalogItemManifest): CatalogItemSummary {
    return {
      sourceId: this.id,
      kind,
      manifest,
      logoUrl: this.logoUrlFor(kind, manifest.id, manifest),
    };
  }

  /**
   * Fast path over gilde's file-bundle index ({@link FILE_INDEX_FILENAME}):
   * one read instead of walking every item folder, resolved by the same
   * `loadResolvedManifest` the walk uses. Null when the file is absent or
   * unreadable, and the caller tries the legacy index, then the walk.
   */
  private async listFromFileIndex(kind: CatalogKind): Promise<CatalogItemSummary[] | null> {
    const indexPath = join(this.root, KIND_DIR[kind], FILE_INDEX_FILENAME);
    const text = await this.readOptional(indexPath);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log.warn(`failed to parse ${indexPath}:`, err);
      return null;
    }
    if (!isRecord(parsed) || parsed.kind !== kind || !Array.isArray(parsed.items)) {
      log.warn(`${indexPath}: kind/items mismatch — falling back`);
      return null;
    }
    const items: CatalogItemSummary[] = [];
    for (const raw of parsed.items) {
      const entry = readFileIndexEntry(raw);
      if (!entry) continue;
      const files = new IndexedItemFiles(entry, this.folderFiles(kind, entry.id));
      const manifest = await this.loadResolvedManifest(kind, entry.id, undefined, files);
      if (manifest) items.push(this.summary(kind, manifest));
    }
    items.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    return items;
  }

  /**
   * Legacy fast path, for a gilde that predates the file-bundle index: when
   * `{kindDir}/index.json` is present, load every
   * summary from that one file instead of walking ~3,800 per-item
   * folders. The index is generated by gilde `tools/build-index.mjs` and
   * embeds the same `CatalogItemManifest` shape this source produces
   * via the slow walk, plus a derived `category` for toolsets.
   *
   * Returns null when the index is missing or unreadable; callers fall
   * back to `listFromDisk()`. Per-entry parse failures are skipped.
   */
  private async listFromIndex(kind: CatalogKind): Promise<CatalogItemSummary[] | null> {
    const indexPath = join(this.root, KIND_DIR[kind], 'index.json');
    let raw: string;
    try {
      raw = await this.readText(indexPath);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(`failed to parse ${indexPath}:`, err);
      return null;
    }
    const obj = parsed as { kind?: unknown; entries?: unknown };
    if (obj.kind !== kind || !Array.isArray(obj.entries)) {
      log.warn(`${indexPath}: kind/entries mismatch — falling back to disk walk`);
      return null;
    }
    const items: CatalogItemSummary[] = [];
    for (const raw of obj.entries) {
      const e = raw as { manifest?: unknown; iconSvg?: unknown };
      if (!e.manifest || typeof e.manifest !== 'object') continue;
      // gilde writes the index against its own copy of the schemas, which
      // can be older or newer than this build's, so an entry is read like
      // any other content: through this build's schema, tolerantly. An entry
      // this build cannot read at all resolves from the item's own folder,
      // where an older eligible version may still be readable.
      let manifest: CatalogItemManifest | null = null;
      const read = parseTolerant(CatalogItemManifestSchema, e.manifest);
      if (read.ok && read.data.kind === kind) {
        noteIgnored(`${indexPath} → ${read.data.id}`, read.ignored);
        manifest = read.data;
      } else {
        const id = (e.manifest as { id?: unknown }).id;
        if (typeof id === 'string') manifest = await this.loadResolvedManifest(kind, id);
      }
      if (!manifest) continue;
      // The index is built without app-version context (gilde's
      // build-index.mjs always embeds the newest resolved version). When
      // that version's effective `minGezelVersion` floor is above this
      // build, re-resolve from disk — an older, floor-free version may
      // still be eligible — and drop the item when nothing is.
      if (!this.floorSatisfied(manifest.minGezelVersion)) {
        const reResolved = await this.loadResolvedManifest(kind, manifest.id);
        if (!reResolved) continue;
        manifest = reResolved;
      }
      // Re-stamp source id + logo URL — the index is source-agnostic so
      // multiple sources can share one on-disk index file with each
      // applying its own routing.
      const iconSvg = typeof e.iconSvg === 'string' ? sanitizePresentationSvg(e.iconSvg) : null;
      const item: CatalogItemSummary = {
        sourceId: this.id,
        kind,
        manifest,
        ...(iconSvg ? { iconSvg } : {}),
      };
      const logo = this.logoUrlFor(kind, manifest.id, manifest);
      if (logo) item.logoUrl = logo;
      items.push(item);
    }
    items.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    return items;
  }

  private async listFromDisk(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    const base = join(this.root, KIND_DIR[kind]);
    let shards: string[] = [];
    try {
      shards = await this.listDir(base);
    } catch (err) {
      if (isAbsentDir(err)) return [];
      throw err;
    }
    const items: CatalogItemSummary[] = [];
    for (const shard of shards) {
      // Index files live at the kind-dir root next to shard folders; skip
      // them so the walker doesn't try to descend into one.
      if (shard.endsWith('.json')) continue;
      let ids: string[] = [];
      try {
        ids = await this.listDir(join(base, shard));
      } catch (err) {
        if (isAbsentDir(err)) continue;
        throw err;
      }
      for (const id of ids) {
        const manifest = await this.loadResolvedManifest(kind, id);
        if (manifest) items.push(this.summary(kind, manifest));
      }
    }
    items.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    return items;
  }

  async get(kind: CatalogKind, id: string, version?: string): Promise<CatalogItemDetail | null> {
    const manifest = await this.loadResolvedManifest(kind, id, version);
    if (!manifest) return null;
    const itemDir = this.itemDir(kind, id);
    const versionDir = join(itemDir, 'versions', manifest.version);
    // Readme is shared across versions and lives at the item root.
    const readme = await this.readOptional(join(itemDir, 'readme.md'));
    // Gezel templates and craftbook templates store their prose inside
    // the version folder — the prompt evolves with the template.
    let about: string | undefined;
    if (
      (manifest.kind === 'gezel-template' || manifest.kind === 'craftbook-template') &&
      manifest.about
    ) {
      about = (await this.readOptional(join(versionDir, manifest.about))) ?? undefined;
    } else if (manifest.kind === 'craftbook-template') {
      // Single-document layout (Craftbooks V2): the prose is the doc's
      // `description` — no separate about.md file exists.
      about = (await this.readCraftbookDoc(versionDir))?.description;
    } else if (manifest.kind === 'project-type' && manifest.aboutTemplate) {
      // Surface the raw (still param-templated) about copy as a gallery
      // preview. The instantiation engine renders the placeholders; here
      // it's just descriptive text for the detail view.
      about = (await this.readOptional(join(versionDir, manifest.aboutTemplate))) ?? undefined;
    }
    return {
      sourceId: this.id,
      kind,
      manifest,
      logoUrl: this.logoUrlFor(kind, id, manifest),
      ...(readme ? { readme } : {}),
      ...(about ? { about } : {}),
    };
  }

  async listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]> {
    const identity = await this.loadIdentity(kind, id);
    if (!identity) return [];
    const versions = await this.discoverVersionFolders(kind, id);
    if (versions.length === 0) return [];
    const yanked = new Set(identity.yankedVersions);
    const minSupported = identity.minSupportedVersion;
    const out: CatalogItemVersionInfo[] = [];
    for (const v of versions) {
      if (minSupported && safeCompare(v.version, minSupported) < 0) continue;
      if (!this.floorSatisfied(v.minGezelVersion)) continue;
      out.push({
        version: v.version,
        releasedAt: v.releasedAt,
        yanked: yanked.has(v.version),
      });
    }
    out.sort((a, b) => safeCompare(b.version, a.version));
    return out;
  }

  async readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    version?: string,
  ): Promise<Buffer | null> {
    // Path traversal guard — reject anything that normalizes outside the
    // item's own folder.
    if (relPath.includes('..') || relPath.startsWith('/')) return null;
    const itemDir = this.itemDir(kind, id);
    if (version) {
      if (!isSemver(version)) return null;
      const versioned = join(itemDir, 'versions', version, relPath);
      try {
        return await this.readBytes(versioned);
      } catch {
        // Single-document craftbooks (V2) carry their scripts inline in
        // `craftbook.json` — serve `scripts/{name}.ts` reads from the doc
        // so pre-migration consumers (the project script installer) keep
        // working without a physical file.
        if (kind === 'craftbook-template') {
          const scriptName = /^scripts\/(.+)\.ts$/.exec(relPath)?.[1];
          if (scriptName) {
            const doc = await this.readCraftbookDoc(join(itemDir, 'versions', version));
            const source = doc?.scripts?.[scriptName];
            if (source !== undefined) return Buffer.from(source, 'utf8');
          }
        }
        // Fall through to item-root lookup for shared assets (logo, readme).
      }
    }
    try {
      return await this.readBytes(join(itemDir, relPath));
    } catch {
      return null;
    }
  }

  /**
   * Every file under an item's folder, as item-relative paths (e.g.
   * `manifest.json`, `versions/1.0.0/pages/gallery/index.html`), sorted. Used
   * by the `.gezapp` exporter to pack an item verbatim — pages, seeds, and all
   * assets, not just the ones the manifest names. Read each back with
   * `readItemFile(kind, id, relPath)` (no version → item-relative). Empty when
   * the item folder is missing.
   */
  async listItemFiles(kind: CatalogKind, id: string): Promise<string[]> {
    const dir = this.itemDir(kind, id);
    let out: string[];
    try {
      out = await (await this.contentTree()).listFiles(dir);
    } catch {
      return [];
    }
    out.sort();
    return out;
  }

  /** Parse a version folder's `craftbook.json`, or null when absent/invalid. */
  private async readCraftbookDoc(versionDir: string): Promise<CraftbookDoc | null> {
    const text = await this.readOptional(join(versionDir, 'craftbook.json'));
    if (text === null) return null;
    const parsed = parseCraftbookDoc(text, 'json', { tolerant: true });
    return parsed.ok ? parsed.doc : null;
  }

  /**
   * A craftbook's eval descriptor (`versions/<v>/test.json`), tolerant-
   * parsed so a spec written by a newer author still loads. Resolution
   * mirrors `get`: no `version` → the latest non-yanked semver. Null on
   * missing book/version/sidecar or an unparseable spec (CI's strict
   * guard is where invalid specs get surfaced loudly — runtime readers
   * degrade quietly).
   */
  async getCraftbookTestSpec(
    id: string,
    version?: string,
  ): Promise<{ version: string; spec: CraftbookTestSpec } | null> {
    const identity = await this.loadIdentity('craftbook-template', id);
    if (!identity) return null;
    const folders = await this.discoverVersionFolders('craftbook-template', id);
    const picked = this.pickVersion(folders, identity, version);
    if (!picked) return null;
    const file = join(
      this.itemDir('craftbook-template', id),
      'versions',
      picked,
      CRAFTBOOK_TEST_FILENAME,
    );
    const text = await this.readOptional(file);
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      log.warn(`${file}: test spec is not valid JSON`);
      return null;
    }
    const parsed = parseCraftbookTestSpec(raw, { mode: 'tolerant' });
    if (!parsed.ok) {
      log.warn(`${file}: invalid test spec — ${parsed.errors[0]}`);
      return null;
    }
    return { version: picked, spec: parsed.spec };
  }

  private itemDir(kind: CatalogKind, id: string): string {
    return join(this.root, KIND_DIR[kind], shardPrefix(id), id);
  }

  /** The item folder as an {@link ItemFiles}. */
  private folderFiles(kind: CatalogKind, id: string): ItemFiles {
    const dir = this.itemDir(kind, id);
    return {
      path: (rel) => join(dir, rel),
      json: async (rel) => {
        const text = await this.readOptional(join(dir, rel));
        return text === null ? undefined : JSON.parse(text);
      },
      versions: () => this.discoverVersionFolders(kind, id),
    };
  }

  /** Read + validate the identity (root) manifest for an item. */
  private async loadIdentity(
    kind: CatalogKind,
    id: string,
    files: ItemFiles = this.folderFiles(kind, id),
  ): Promise<CatalogItemIdentity | null> {
    const file = files.path('manifest.json');
    try {
      const raw = await files.json('manifest.json');
      if (raw === undefined) return null;
      const parsed = readContent(CatalogItemIdentitySchema, raw, file);
      if (parsed.kind !== kind) {
        log.warn(
          `${file}: identity kind=${parsed.kind} doesn't match directory kind=${kind}, skipping`,
        );
        return null;
      }
      if (parsed.id !== id) {
        log.warn(`${file}: identity id=${parsed.id} doesn't match directory id=${id}, skipping`);
        return null;
      }
      // An identity-level floor gates the whole item on older builds.
      // Silent by design — like tombstoned identities, this is an expected
      // steady state (content authored ahead of the next app release), not
      // an error worth spamming every listing with.
      if (!this.floorSatisfied(parsed.minGezelVersion)) return null;
      return parsed;
    } catch (err) {
      log.warn(`invalid identity manifest ${file}:`, err);
      return null;
    }
  }

  /** Enumerate `versions/{semver}/manifest.json` entries. Unsorted. */
  private async discoverVersionFolders(kind: CatalogKind, id: string): Promise<VersionStamp[]> {
    const versionsDir = join(this.itemDir(kind, id), 'versions');
    let names: string[];
    try {
      names = await this.listDir(versionsDir);
    } catch {
      return [];
    }
    const out: VersionStamp[] = [];
    for (const name of names) {
      if (!isSemver(name)) continue;
      // Craftbook templates carry a single-document `craftbook.json`
      // (canonical since the V2 migration); everything else — and legacy
      // craftbook layouts still living in user/community roots — carries
      // a per-version `manifest.json`. Either way the payload's own
      // version stamp must match the folder name (the source of truth).
      const candidates =
        kind === 'craftbook-template' ? ['craftbook.json', 'manifest.json'] : ['manifest.json'];
      for (const filename of candidates) {
        const versionFile = join(versionsDir, name, filename);
        let raw: string;
        try {
          raw = await this.readText(versionFile);
        } catch {
          continue;
        }
        try {
          const json = JSON.parse(raw) as {
            version?: unknown;
            releasedAt?: unknown;
            minGezelVersion?: unknown;
          };
          const version = typeof json.version === 'string' ? json.version : null;
          const releasedAt = typeof json.releasedAt === 'string' ? json.releasedAt : null;
          if (!version || !releasedAt) continue;
          if (version !== name) {
            log.warn(
              `${versionFile}: version=${version} doesn't match folder name=${name}, skipping`,
            );
            continue;
          }
          out.push({
            version,
            releasedAt,
            ...(typeof json.minGezelVersion === 'string'
              ? { minGezelVersion: json.minGezelVersion }
              : {}),
          });
        } catch {
          continue;
        }
        break;
      }
    }
    return out;
  }

  /**
   * Pick a target version. When `requested` is set, validate it exists —
   * an explicit pin deliberately bypasses the yank / `minSupportedVersion`
   * / `minGezelVersion` filters so installed content keeps resolving.
   * Otherwise resolve the highest non-yanked semver above
   * `minSupportedVersion` whose `minGezelVersion` floor this build
   * satisfies. Returns null when nothing satisfies.
   */
  private pickVersion(
    folders: VersionStamp[],
    identity: CatalogItemIdentity,
    requested?: string,
  ): string | null {
    if (folders.length === 0) return null;
    if (requested) {
      return folders.some((f) => f.version === requested) ? requested : null;
    }
    const yanked = new Set(identity.yankedVersions);
    const minSupported = identity.minSupportedVersion;
    const eligible = folders
      .filter((f) => {
        if (yanked.has(f.version)) return false;
        if (minSupported && safeCompare(f.version, minSupported) < 0) return false;
        if (!this.floorSatisfied(f.minGezelVersion)) return false;
        return true;
      })
      .map((f) => f.version);
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => safeCompare(b, a));
    return eligible[0] ?? null;
  }

  /**
   * Compose identity + version into the resolved (flat) manifest shape
   * that consumers expect. Returns null when identity is missing,
   * version is missing, or validation fails.
   */
  private async loadResolvedManifest(
    kind: CatalogKind,
    id: string,
    version?: string,
    files: ItemFiles = this.folderFiles(kind, id),
  ): Promise<CatalogItemManifest | null> {
    const identity = await this.loadIdentity(kind, id, files);
    if (!identity) return null;
    const folders = await files.versions();
    const chosen = this.pickVersion(folders, identity, version);
    if (!chosen) {
      if (version) {
        log.warn(`${kind}/${id}: requested version ${version} not found on disk`);
      } else {
        // Tombstoned identities — every on-disk version is in
        // `yankedVersions` — are an expected steady state for entries
        // the importer has marked fully deprecated upstream. The
        // directory is preserved so the next importer run unions the
        // yank list forward; warning on it just spams build output.
        // Likewise for items whose every version carries a
        // `minGezelVersion` floor above this build — content authored
        // ahead of the next app release, not an error.
        const yanked = new Set(identity.yankedVersions);
        const everythingIneligible =
          folders.length > 0 &&
          folders.every((f) => yanked.has(f.version) || !this.floorSatisfied(f.minGezelVersion));
        if (!everythingIneligible) {
          log.warn(`${kind}/${id}: no eligible versions on disk`);
        }
      }
      return null;
    }
    const yankedSet = new Set(identity.yankedVersions);
    const minSupportedVersion = identity.minSupportedVersion;
    const availableVersions = folders
      .filter((f) => {
        if (yankedSet.has(f.version)) return false;
        if (minSupportedVersion && safeCompare(f.version, minSupportedVersion) < 0) return false;
        if (!this.floorSatisfied(f.minGezelVersion)) return false;
        return true;
      })
      .map((f) => f.version)
      .sort((a, b) => safeCompare(b, a));
    // Craftbook templates: the single-document `craftbook.json` payload is
    // canonical (Craftbooks V2). A present-but-invalid document is a hard
    // miss — never fall back to a possibly-stale legacy manifest beside it.
    if (kind === 'craftbook-template' && identity.kind === 'craftbook-template') {
      const docRel = `versions/${chosen}/craftbook.json`;
      const docFile = files.path(docRel);
      let doc: unknown;
      try {
        doc = await files.json(docRel);
      } catch (err) {
        log.warn(`invalid craftbook document ${docFile}: not valid JSON —`, err);
        return null;
      }
      if (doc !== undefined) {
        const parsed = parseCraftbookDocValue(doc, { tolerant: true });
        if (!parsed.ok) {
          log.warn(
            `invalid craftbook document ${docFile}:\n${formatCraftbookDocErrors(parsed.errors)}`,
          );
          return null;
        }
        noteIgnored(docFile, parsed.ignored ?? []);
        return craftbookManifestFromDoc(identity, parsed.doc, chosen, availableVersions);
      }
      // No craftbook.json → legacy manifest.json + about.md + scripts/ layout
      // (user homes and community roots may still carry it).
    }
    const versionRel = `versions/${chosen}/manifest.json`;
    const versionFile = files.path(versionRel);
    let versionPayload: unknown;
    try {
      versionPayload = await files.json(versionRel);
    } catch (err) {
      log.warn(`failed to read ${versionFile}:`, err);
      return null;
    }
    if (versionPayload === undefined) {
      log.warn(`failed to read ${versionFile}: not found`);
      return null;
    }
    const parsedVersion = parseVersionPayload(kind, versionPayload, versionFile);
    if (!parsedVersion) {
      log.warn(`invalid version manifest ${versionFile}`);
      return null;
    }
    if (kind === 'chat-model') {
      const v = parsedVersion as {
        ollama?: unknown;
        llamaCpp?: unknown;
        mlx?: unknown;
        ds4?: unknown;
      };
      if (!v.ollama && !v.llamaCpp && !v.mlx && !v.ds4) {
        log.warn(
          `${versionFile}: chat-model version has no ollama / llamaCpp / mlx / ds4 source — skipping`,
        );
        return null;
      }
    }
    if (kind === 'video-model') {
      const v = parsedVersion as { source?: { files?: unknown[] } };
      if (!v.source || !Array.isArray(v.source.files) || v.source.files.length === 0) {
        log.warn(`${versionFile}: video-model version has no source files — skipping`);
        return null;
      }
    }
    return mergeIdentityAndVersion(kind, identity, parsedVersion, availableVersions);
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.readText(path);
    } catch {
      return null;
    }
  }

  private logoUrlFor(
    kind: CatalogKind,
    id: string,
    manifest: CatalogItemManifest,
  ): string | undefined {
    if (!manifest.logo) return undefined;
    // Absolute URLs pass through; otherwise serve via the HTTP route.
    if (/^https?:\/\//.test(manifest.logo)) return manifest.logo;
    return `/api/catalog/${kind}/${encodeURIComponent(id)}/file/${encodeURIComponent(
      manifest.logo,
    )}?source=${encodeURIComponent(this.id)}`;
  }
}

/**
 * Resolve a craftbook-template manifest from the single-document
 * `craftbook.json` payload (Craftbooks V2): identity fields from the root
 * manifest, everything else from the doc. Step blueprints are expanded
 * (`deliverable` sugar → enforced gate) so consumers see the same
 * `CraftbookStep[]` shape the legacy version manifest carried. Inline
 * `scripts` also project a derived `bundledScripts` filename list so
 * script-installer consumers keep working for one release.
 */
function craftbookManifestFromDoc(
  identity: Extract<CatalogItemIdentity, { kind: 'craftbook-template' }>,
  doc: CraftbookDoc,
  version: string,
  availableVersions: string[],
): CatalogItemManifest | null {
  if (!doc.releasedAt) {
    log.warn(`craftbook-template/${identity.id}@${version}: doc has no releasedAt`);
    return null;
  }
  const steps = expandStepDeliverables(doc.steps);
  const entryStepId = doc.entryStepId ?? steps[0]!.id;
  const scriptNames = Object.keys(doc.scripts ?? {});
  const minGezelVersion = maxMinGezelVersion(identity.minGezelVersion, doc.minGezelVersion);
  return {
    schemaVersion: 1,
    kind: 'craftbook-template',
    id: identity.id,
    name: identity.name,
    description: identity.description,
    tags: identity.tags,
    maintainer: identity.maintainer,
    ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
    ...(identity.license !== undefined ? { license: identity.license } : {}),
    ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
    version,
    releasedAt: doc.releasedAt,
    role: identity.role,
    ...(identity.category ? { category: identity.category } : {}),
    ...(identity.workflow ? { workflow: identity.workflow } : {}),
    // The prose lives inline on the doc (`description`) — there is no
    // separate about.md file to point at. `get()` surfaces it directly.
    about: '',
    steps,
    entryStepId,
    ...(doc.defaultAssignee ? { defaultAssignee: doc.defaultAssignee } : {}),
    ...(doc.basedOn ? { basedOn: doc.basedOn } : {}),
    ...(doc.plan !== undefined ? { plan: doc.plan } : {}),
    ...(doc.triggers ? { triggers: doc.triggers } : {}),
    ...(doc.scripts ? { scripts: doc.scripts } : {}),
    ...(scriptNames.length > 0 ? { bundledScripts: scriptNames.map((n) => `${n}.ts`) } : {}),
    ...(doc.paramSchema ? { paramSchema: doc.paramSchema } : {}),
    ...(doc.command ? { command: doc.command } : {}),
    ...(doc.requirements ? { requirements: doc.requirements } : {}),
    ...(doc.recommends ? { recommends: doc.recommends } : {}),
    ...(doc.runModes ? { runModes: doc.runModes } : {}),
    ...(doc.toolsets ? { toolsets: doc.toolsets } : {}),
    ...(doc.commands ? { commands: doc.commands } : {}),
    ...(doc.connectors ? { connectors: doc.connectors } : {}),
    ...(doc.models ? { models: doc.models } : {}),
    ...(doc.services ? { services: doc.services } : {}),
    ...(doc.hooks ? { hooks: doc.hooks } : {}),
    ...(doc.spawn ? { spawn: doc.spawn } : {}),
    ...(doc.diffpackCapable ? { diffpackCapable: true } : {}),
    ...(doc.capabilityFloor ? { capabilityFloor: doc.capabilityFloor } : {}),
    availableVersions,
  };
}

/** Compare two semver strings, swallowing parse errors as "equal". */
function safeCompare(a: string, b: string): number {
  try {
    return compareSemver(a, b);
  } catch {
    return 0;
  }
}

/**
 * Type-narrowing helper. We can't inline the per-kind schema picks
 * because each schema has a different inferred type.
 */
type AnyVersionPayload =
  | (ReturnType<typeof ToolsetVersionManifestSchema.parse> & { __kind: 'toolset' })
  | (ReturnType<typeof GezelTemplateVersionManifestSchema.parse> & { __kind: 'gezel-template' })
  | (ReturnType<typeof CraftbookTemplateVersionManifestSchema.parse> & {
      __kind: 'craftbook-template';
    })
  | (ReturnType<typeof ProjectTypeVersionManifestSchema.parse> & { __kind: 'project-type' })
  | (ReturnType<typeof ConnectorTypeVersionManifestSchema.parse> & { __kind: 'connector-type' })
  | (ReturnType<typeof ChatModelVersionManifestSchema.parse> & { __kind: 'chat-model' })
  | (ReturnType<typeof ImageModelVersionManifestSchema.parse> & { __kind: 'image-model' })
  | (ReturnType<typeof VideoModelVersionManifestSchema.parse> & { __kind: 'video-model' })
  | (ReturnType<typeof KnowledgeCatalogVersionManifestSchema.parse> & {
      __kind: 'knowledge-catalog';
    });

function parseVersionPayload(
  kind: CatalogKind,
  raw: unknown,
  where: string,
): AnyVersionPayload | null {
  try {
    if (kind === 'toolset') {
      const p = readContent(ToolsetVersionManifestSchema, raw, where);
      return { ...p, __kind: 'toolset' } as AnyVersionPayload;
    }
    if (kind === 'gezel-template') {
      const p = readContent(GezelTemplateVersionManifestSchema, raw, where);
      return { ...p, __kind: 'gezel-template' } as AnyVersionPayload;
    }
    if (kind === 'craftbook-template') {
      const p = readContent(CraftbookTemplateVersionManifestSchema, raw, where);
      return { ...p, __kind: 'craftbook-template' } as AnyVersionPayload;
    }
    if (kind === 'project-type') {
      const p = readContent(ProjectTypeVersionManifestSchema, raw, where);
      return { ...p, __kind: 'project-type' } as AnyVersionPayload;
    }
    if (kind === 'connector-type') {
      const p = readContent(ConnectorTypeVersionManifestSchema, raw, where);
      return { ...p, __kind: 'connector-type' } as AnyVersionPayload;
    }
    if (kind === 'chat-model') {
      const p = readContent(ChatModelVersionManifestSchema, raw, where);
      return { ...p, __kind: 'chat-model' } as AnyVersionPayload;
    }
    if (kind === 'video-model') {
      const p = readContent(VideoModelVersionManifestSchema, raw, where);
      return { ...p, __kind: 'video-model' } as AnyVersionPayload;
    }
    if (kind === 'knowledge-catalog') {
      const p = readContent(KnowledgeCatalogVersionManifestSchema, raw, where);
      return { ...p, __kind: 'knowledge-catalog' } as AnyVersionPayload;
    }
    const p = readContent(ImageModelVersionManifestSchema, raw, where);
    return { ...p, __kind: 'image-model' } as AnyVersionPayload;
  } catch {
    return null;
  }
}

function mergeIdentityAndVersion(
  kind: CatalogKind,
  identity: CatalogItemIdentity,
  version: AnyVersionPayload,
  availableVersions: string[],
): CatalogItemManifest | null {
  // Effective app-version floor: the stricter of the identity-level and
  // version-level `minGezelVersion`. Forwarded explicitly in every branch
  // below — this merge builds resolved manifests from fixed field lists
  // (see the KV-geometry note in the chat-model branch), so a field left
  // out of a branch is silently dropped for that kind.
  const minGezelVersion = maxMinGezelVersion(identity.minGezelVersion, version.minGezelVersion);
  // The identity's discriminator must match the directory's kind, which
  // we already verified upstream; this branch is for type narrowing.
  if (kind === 'toolset' && identity.kind === 'toolset' && version.__kind === 'toolset') {
    return {
      schemaVersion: 1,
      kind: 'toolset',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      runtime: version.runtime,
      tools: version.tools,
      config: version.config,
      ...(version.requirements ? { requirements: version.requirements } : {}),
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
      // Derived here, not by gilde's index builder, so a folder read and an
      // index read agree and the rule has one owner.
      category:
        identity.category ||
        categorizeToolset({
          id: identity.id,
          name: identity.name,
          description: identity.description,
          tags: identity.tags,
          maintainerName: identity.maintainer?.name,
        }),
    };
  }
  if (
    kind === 'craftbook-template' &&
    identity.kind === 'craftbook-template' &&
    version.__kind === 'craftbook-template'
  ) {
    return {
      schemaVersion: 1,
      kind: 'craftbook-template',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      role: identity.role,
      ...(identity.category ? { category: identity.category } : {}),
      ...(identity.workflow ? { workflow: identity.workflow } : {}),
      about: version.about,
      steps: version.steps,
      entryStepId: version.entryStepId,
      ...(version.defaultAssignee ? { defaultAssignee: version.defaultAssignee } : {}),
      ...(version.basedOn ? { basedOn: version.basedOn } : {}),
      ...(version.plan !== undefined ? { plan: version.plan } : {}),
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      ...(version.triggers ? { triggers: version.triggers } : {}),
      ...(version.hooks ? { hooks: version.hooks } : {}),
      ...(version.bundledScripts ? { bundledScripts: version.bundledScripts } : {}),
      ...(version.paramSchema ? { paramSchema: version.paramSchema } : {}),
      ...(version.command ? { command: version.command } : {}),
      ...(version.requirements ? { requirements: version.requirements } : {}),
      ...(version.recommends ? { recommends: version.recommends } : {}),
      ...(version.runModes ? { runModes: version.runModes } : {}),
      ...(version.toolsets ? { toolsets: version.toolsets } : {}),
      ...(version.connectors ? { connectors: version.connectors } : {}),
      ...(version.models ? { models: version.models } : {}),
      ...(version.services ? { services: version.services } : {}),
      availableVersions,
    };
  }
  if (
    kind === 'project-type' &&
    identity.kind === 'project-type' &&
    version.__kind === 'project-type'
  ) {
    return {
      schemaVersion: 1,
      kind: 'project-type',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      ...(identity.category !== undefined ? { category: identity.category } : {}),
      ...(identity.icon !== undefined ? { icon: identity.icon } : {}),
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      ...(version.extends !== undefined ? { extends: version.extends } : {}),
      ...(version.meesterManaged !== undefined ? { meesterManaged: version.meesterManaged } : {}),
      ...(version.tabVisibility !== undefined ? { tabVisibility: version.tabVisibility } : {}),
      ...(version.mode !== undefined ? { mode: version.mode } : {}),
      ...(version.leadLabel !== undefined ? { leadLabel: version.leadLabel } : {}),
      ...(version.leanProfile !== undefined ? { leanProfile: version.leanProfile } : {}),
      ...(version.capabilityFloor !== undefined
        ? { capabilityFloor: version.capabilityFloor }
        : {}),
      ...(version.indexingEnabled !== undefined
        ? { indexingEnabled: version.indexingEnabled }
        : {}),
      ...(version.params !== undefined ? { params: version.params } : {}),
      ...(version.nameTemplate !== undefined ? { nameTemplate: version.nameTemplate } : {}),
      ...(version.aboutTemplate !== undefined ? { aboutTemplate: version.aboutTemplate } : {}),
      ...(version.missionTemplate !== undefined
        ? { missionTemplate: version.missionTemplate }
        : {}),
      gezels: version.gezels,
      toolsets: version.toolsets,
      craftbooks: version.craftbooks,
      ...(version.scripts !== undefined ? { scripts: version.scripts } : {}),
      tools: version.tools,
      ...(version.pages !== undefined ? { pages: version.pages } : {}),
      schedules: version.schedules,
      workspaceSeed: version.workspaceSeed,
      artifactsSeed: version.artifactsSeed,
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
    };
  }
  if (
    kind === 'connector-type' &&
    identity.kind === 'connector-type' &&
    version.__kind === 'connector-type'
  ) {
    return {
      schemaVersion: 1,
      kind: 'connector-type',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      driver: version.driver,
      ...(version.configSchema !== undefined ? { configSchema: version.configSchema } : {}),
      ...(version.secretShape !== undefined ? { secretShape: version.secretShape } : {}),
      ...(version.setupInstructions !== undefined
        ? { setupInstructions: version.setupInstructions }
        : {}),
      source: version.source,
      normalize: version.normalize,
      actions: version.actions,
      ...(version.completeness !== undefined ? { completeness: version.completeness } : {}),
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
    };
  }
  if (
    kind === 'gezel-template' &&
    identity.kind === 'gezel-template' &&
    version.__kind === 'gezel-template'
  ) {
    return {
      schemaVersion: 1,
      kind: 'gezel-template',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      role: identity.role,
      about: version.about,
      ...(version.suggestedProvider ? { suggestedProvider: version.suggestedProvider } : {}),
      ...(version.suggestedModel ? { suggestedModel: version.suggestedModel } : {}),
      suggestedTools: version.suggestedTools,
      meesterCandidate: identity.meesterCandidate,
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      ...(version.frontmatter ? { frontmatter: version.frontmatter } : {}),
      ...(version.nameSuggestions ? { nameSuggestions: version.nameSuggestions } : {}),
      ...(version.suggestedCraftbooks ? { suggestedCraftbooks: version.suggestedCraftbooks } : {}),
      availableVersions,
    };
  }
  if (kind === 'chat-model' && identity.kind === 'chat-model' && version.__kind === 'chat-model') {
    return {
      schemaVersion: 1,
      kind: 'chat-model',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.maker !== undefined ? { maker: identity.maker } : {}),
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(identity.licenseClass !== undefined ? { licenseClass: identity.licenseClass } : {}),
      ...(identity.licenseShortName !== undefined
        ? { licenseShortName: identity.licenseShortName }
        : {}),
      ...(identity.licenseUrl !== undefined ? { licenseUrl: identity.licenseUrl } : {}),
      ...(identity.recoScore !== undefined ? { recoScore: identity.recoScore } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      parameterSize: identity.parameterSize,
      approxSizeBytes: version.approxSizeBytes,
      supportsTools: identity.supportsTools,
      ...(identity.contextWindow !== undefined ? { contextWindow: identity.contextWindow } : {}),
      // KV geometry is architecture-determined, so it rides on identity and
      // must be forwarded explicitly — this merge builds the resolved
      // manifest from a fixed field list, which is why authoring the fields
      // alone did nothing: they were silently dropped here and the
      // pre-install fit badge kept pricing weights only.
      ...(identity.kvBytesPerTokenF16 !== undefined
        ? { kvBytesPerTokenF16: identity.kvBytesPerTokenF16 }
        : {}),
      ...(identity.kvFixedBytesF16 !== undefined
        ? { kvFixedBytesF16: identity.kvFixedBytesF16 }
        : {}),
      ...(identity.upstream !== undefined ? { upstream: identity.upstream } : {}),
      ...(identity.category ? { category: identity.category } : {}),
      ...(identity.style ? { style: identity.style } : {}),
      ...(identity.behaviors ? { behaviors: identity.behaviors } : {}),
      ...(identity.tuning ? { tuning: identity.tuning } : {}),
      ...(version.ollama ? { ollama: version.ollama } : {}),
      ...(version.llamaCpp ? { llamaCpp: version.llamaCpp } : {}),
      ...(version.mlx ? { mlx: version.mlx } : {}),
      ...(version.ds4 ? { ds4: version.ds4 } : {}),
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
    };
  }
  if (
    kind === 'image-model' &&
    identity.kind === 'image-model' &&
    version.__kind === 'image-model'
  ) {
    return {
      schemaVersion: 1,
      kind: 'image-model',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(identity.licenseClass !== undefined ? { licenseClass: identity.licenseClass } : {}),
      ...(identity.licenseShortName !== undefined
        ? { licenseShortName: identity.licenseShortName }
        : {}),
      ...(identity.licenseUrl !== undefined ? { licenseUrl: identity.licenseUrl } : {}),
      ...(identity.recoScore !== undefined ? { recoScore: identity.recoScore } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      downloadUrl: version.downloadUrl,
      sha256: version.sha256,
      approxSizeBytes: version.approxSizeBytes,
      ...(version.quantization ? { quantization: version.quantization } : {}),
      recommendedSteps: identity.recommendedSteps,
      ...(identity.widthRange ? { widthRange: identity.widthRange } : {}),
      ...(identity.heightRange ? { heightRange: identity.heightRange } : {}),
      ...(identity.upstream !== undefined ? { upstream: identity.upstream } : {}),
      ...(identity.category ? { category: identity.category } : {}),
      weightsKind: identity.weightsKind,
      ...(identity.supportsImg2Img !== undefined
        ? { supportsImg2Img: identity.supportsImg2Img }
        : {}),
      auxiliaryFiles: version.auxiliaryFiles,
      hardwareTier: identity.hardwareTier,
      minRamGB: identity.minRamGB,
      commercialUse: identity.commercialUse,
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
    };
  }
  if (
    kind === 'knowledge-catalog' &&
    identity.kind === 'knowledge-catalog' &&
    version.__kind === 'knowledge-catalog'
  ) {
    return {
      schemaVersion: 1,
      kind: 'knowledge-catalog',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(identity.licenseClass !== undefined ? { licenseClass: identity.licenseClass } : {}),
      ...(identity.licenseShortName !== undefined
        ? { licenseShortName: identity.licenseShortName }
        : {}),
      ...(identity.licenseUrl !== undefined ? { licenseUrl: identity.licenseUrl } : {}),
      ...(identity.recoScore !== undefined ? { recoScore: identity.recoScore } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      publisherId: identity.publisherId,
      language: identity.language,
      ...(identity.category ? { category: identity.category } : {}),
      ...(identity.upstream !== undefined ? { upstream: identity.upstream } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      formatVersion: version.formatVersion,
      huggingface: version.huggingface,
      sha256: version.sha256,
      archiveBytes: version.archiveBytes,
      uncompressedBytes: version.uncompressedBytes,
      documents: version.documents,
      chunks: version.chunks,
      embeddingProfile: version.embeddingProfile,
      topics: version.topics,
      ...(version.sourceSnapshot ? { sourceSnapshot: version.sourceSnapshot } : {}),
      ...(version.parquet ? { parquet: version.parquet } : {}),
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
    };
  }
  if (
    kind === 'video-model' &&
    identity.kind === 'video-model' &&
    version.__kind === 'video-model'
  ) {
    return {
      schemaVersion: 1,
      kind: 'video-model',
      id: identity.id,
      name: identity.name,
      description: identity.description,
      tags: identity.tags,
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(identity.licenseClass !== undefined ? { licenseClass: identity.licenseClass } : {}),
      ...(identity.licenseShortName !== undefined
        ? { licenseShortName: identity.licenseShortName }
        : {}),
      ...(identity.licenseUrl !== undefined ? { licenseUrl: identity.licenseUrl } : {}),
      ...(identity.recoScore !== undefined ? { recoScore: identity.recoScore } : {}),
      ...(minGezelVersion !== undefined ? { minGezelVersion } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      family: identity.family,
      ...(identity.load !== undefined ? { load: identity.load } : {}),
      source: version.source,
      approxSizeBytes: version.source.approxSizeBytes,
      recommendedSteps: identity.recommendedSteps,
      ...(identity.guidanceScale !== undefined ? { guidanceScale: identity.guidanceScale } : {}),
      defaultNumFrames: identity.defaultNumFrames,
      ...(identity.numFramesRange ? { numFramesRange: identity.numFramesRange } : {}),
      defaultFps: identity.defaultFps,
      ...(identity.fpsRange ? { fpsRange: identity.fpsRange } : {}),
      ...(identity.maxDurationSeconds !== undefined
        ? { maxDurationSeconds: identity.maxDurationSeconds }
        : {}),
      ...(identity.widthRange ? { widthRange: identity.widthRange } : {}),
      ...(identity.heightRange ? { heightRange: identity.heightRange } : {}),
      ...(identity.defaultWidth !== undefined ? { defaultWidth: identity.defaultWidth } : {}),
      ...(identity.defaultHeight !== undefined ? { defaultHeight: identity.defaultHeight } : {}),
      supportsImageToVideo: identity.supportsImageToVideo,
      ...(identity.upstream !== undefined ? { upstream: identity.upstream } : {}),
      hardwareTier: identity.hardwareTier,
      minVramGB: identity.minVramGB,
      commercialUse: identity.commercialUse,
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
    };
  }
  return null;
}
