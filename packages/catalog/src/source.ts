import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CRAFTBOOK_TEST_FILENAME,
  type CatalogItemDetail,
  type CatalogItemIdentity,
  CatalogItemIdentitySchema,
  type CatalogItemManifest,
  type CatalogItemSummary,
  type CatalogItemVersionInfo,
  type CatalogKind,
  ChatModelVersionManifestSchema,
  ConnectorTypeVersionManifestSchema,
  type CraftbookDoc,
  CraftbookTemplateVersionManifestSchema,
  type CraftbookTestSpec,
  GezelTemplateVersionManifestSchema,
  ImageModelVersionManifestSchema,
  ProjectTypeVersionManifestSchema,
  ToolsetVersionManifestSchema,
  VideoModelVersionManifestSchema,
  compareSemver,
  expandStepDeliverables,
  formatCraftbookDocErrors,
  isSemver,
  parseCraftbookDoc,
  parseCraftbookTestSpec,
} from '@bendyline/gezel';
import { gildeDataDir } from './gilde-data.js';

/**
 * ─ CatalogSource ───────────────────────────────────────────────────
 *
 * Abstracts where catalog items live. Two implementations today:
 *
 *   - BundledSource:  reads the on-disk `data/` directory shipped with
 *                     this package. Always available, zero network.
 *   - RemoteSource:   (TODO) fetches a static index.json + per-item
 *                     manifests from an HTTP(S) URL. Stubbed until we
 *                     publish a public catalog repo.
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
   * on-disk sources implement it (used by the `.gzl` exporter); synthetic
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
  /** Override the on-disk root. Defaults to `data/` next to this package. */
  dataDir?: string;
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
}

export class BundledSource implements CatalogSource {
  readonly id: string;
  readonly label: string;
  private readonly root: string;
  private readonly useIndex: boolean;

  constructor(options: BundledSourceOptions | string = {}) {
    // Back-compat: old positional `root: string` signature.
    const opts: BundledSourceOptions = typeof options === 'string' ? { dataDir: options } : options;
    this.root = opts.dataDir ?? defaultBundledDataDir();
    this.id = opts.id ?? 'bundled';
    this.label = opts.label ?? 'Bundled';
    this.useIndex = !opts.noIndex;
  }

  async listKinds(): Promise<CatalogKind[]> {
    return KINDS;
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (this.useIndex) {
      const indexed = await this.listFromIndex(kind);
      if (indexed) return indexed;
    }
    return this.listFromDisk(kind);
  }

  /**
   * Fast-path: when `{kindDir}/index.json` is present, load every
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
      raw = await readFile(indexPath, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[catalog] failed to parse ${indexPath}:`, err);
      return null;
    }
    const obj = parsed as { kind?: unknown; entries?: unknown };
    if (obj.kind !== kind || !Array.isArray(obj.entries)) {
      console.warn(`[catalog] ${indexPath}: kind/entries mismatch — falling back to disk walk`);
      return null;
    }
    const items: CatalogItemSummary[] = [];
    for (const raw of obj.entries) {
      const e = raw as { manifest?: unknown; iconSvg?: unknown };
      if (!e.manifest || typeof e.manifest !== 'object') continue;
      const manifest = e.manifest as CatalogItemManifest;
      // Re-stamp source id + logo URL — the index is source-agnostic so
      // multiple sources can share one on-disk index file with each
      // applying its own routing.
      const item: CatalogItemSummary = {
        sourceId: this.id,
        kind,
        manifest,
        ...(typeof e.iconSvg === 'string' ? { iconSvg: e.iconSvg } : {}),
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
      shards = await readdir(base);
    } catch (err) {
      if (isAbsentDir(err)) return [];
      throw err;
    }
    const items: CatalogItemSummary[] = [];
    for (const shard of shards) {
      // The index file lives at the kind-dir root next to shard folders;
      // skip it so the walker doesn't try to descend into it.
      if (shard === 'index.json') continue;
      let ids: string[] = [];
      try {
        ids = await readdir(join(base, shard));
      } catch (err) {
        if (isAbsentDir(err)) continue;
        throw err;
      }
      for (const id of ids) {
        const manifest = await this.loadResolvedManifest(kind, id);
        if (!manifest) continue;
        items.push({
          sourceId: this.id,
          kind,
          manifest,
          logoUrl: this.logoUrlFor(kind, id, manifest),
        });
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
        return await readFile(versioned);
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
      return await readFile(join(itemDir, relPath));
    } catch {
      return null;
    }
  }

  /**
   * Every file under an item's folder, as item-relative paths (e.g.
   * `manifest.json`, `versions/1.0.0/pages/gallery/index.html`), sorted. Used
   * by the `.gzl` exporter to pack an item verbatim — pages, seeds, and all
   * assets, not just the ones the manifest names. Read each back with
   * `readItemFile(kind, id, relPath)` (no version → item-relative). Empty when
   * the item folder is missing.
   */
  async listItemFiles(kind: CatalogKind, id: string): Promise<string[]> {
    const dir = this.itemDir(kind, id);
    let entries: Array<{ parentPath?: string; path?: string; name: string; isFile(): boolean }>;
    try {
      entries = (await readdir(dir, { recursive: true, withFileTypes: true })) as never;
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      // Node's Dirent under `recursive` carries the containing dir in
      // `parentPath` (Node 20.12+) or the older `path`; join + relativize.
      const parent = e.parentPath ?? e.path ?? dir;
      const abs = join(parent, e.name);
      const rel = abs.startsWith(dir) ? abs.slice(dir.length).replace(/^[/\\]+/, '') : e.name;
      out.push(rel.split('\\').join('/'));
    }
    out.sort();
    return out;
  }

  /** Parse a version folder's `craftbook.json`, or null when absent/invalid. */
  private async readCraftbookDoc(versionDir: string): Promise<CraftbookDoc | null> {
    const text = await this.readOptional(join(versionDir, 'craftbook.json'));
    if (text === null) return null;
    const parsed = parseCraftbookDoc(text, 'json');
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
    const picked = await this.pickVersion('craftbook-template', id, identity, version);
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
      console.warn(`[catalog] ${file}: test spec is not valid JSON`);
      return null;
    }
    const parsed = parseCraftbookTestSpec(raw, { mode: 'tolerant' });
    if (!parsed.ok) {
      console.warn(`[catalog] ${file}: invalid test spec — ${parsed.errors[0]}`);
      return null;
    }
    return { version: picked, spec: parsed.spec };
  }

  private itemDir(kind: CatalogKind, id: string): string {
    return join(this.root, KIND_DIR[kind], shardPrefix(id), id);
  }

  /** Read + validate the identity (root) manifest for an item. */
  private async loadIdentity(kind: CatalogKind, id: string): Promise<CatalogItemIdentity | null> {
    const file = join(this.itemDir(kind, id), 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = CatalogItemIdentitySchema.parse(JSON.parse(raw));
      if (parsed.kind !== kind) {
        console.warn(
          `[catalog] ${file}: identity kind=${parsed.kind} doesn't match directory kind=${kind}, skipping`,
        );
        return null;
      }
      if (parsed.id !== id) {
        console.warn(
          `[catalog] ${file}: identity id=${parsed.id} doesn't match directory id=${id}, skipping`,
        );
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn(`[catalog] invalid identity manifest ${file}:`, err);
      return null;
    }
  }

  /** Enumerate `versions/{semver}/manifest.json` entries. Unsorted. */
  private async discoverVersionFolders(
    kind: CatalogKind,
    id: string,
  ): Promise<Array<{ version: string; releasedAt: string }>> {
    const versionsDir = join(this.itemDir(kind, id), 'versions');
    let names: string[];
    try {
      names = await readdir(versionsDir);
    } catch {
      return [];
    }
    const out: Array<{ version: string; releasedAt: string }> = [];
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
          raw = await readFile(versionFile, 'utf8');
        } catch {
          continue;
        }
        try {
          const json = JSON.parse(raw) as { version?: unknown; releasedAt?: unknown };
          const version = typeof json.version === 'string' ? json.version : null;
          const releasedAt = typeof json.releasedAt === 'string' ? json.releasedAt : null;
          if (!version || !releasedAt) continue;
          if (version !== name) {
            console.warn(
              `[catalog] ${versionFile}: version=${version} doesn't match folder name=${name}, skipping`,
            );
            continue;
          }
          out.push({ version, releasedAt });
        } catch {
          continue;
        }
        break;
      }
    }
    return out;
  }

  /**
   * Pick a target version. When `requested` is set, validate it exists.
   * Otherwise resolve the highest non-yanked semver above
   * `minSupportedVersion`. Returns null when nothing satisfies.
   */
  private async pickVersion(
    kind: CatalogKind,
    id: string,
    identity: CatalogItemIdentity,
    requested?: string,
  ): Promise<string | null> {
    const folders = await this.discoverVersionFolders(kind, id);
    if (folders.length === 0) return null;
    const all = folders.map((f) => f.version);
    if (requested) {
      return all.includes(requested) ? requested : null;
    }
    const yanked = new Set(identity.yankedVersions);
    const minSupported = identity.minSupportedVersion;
    const eligible = all.filter((v) => {
      if (yanked.has(v)) return false;
      if (minSupported && safeCompare(v, minSupported) < 0) return false;
      return true;
    });
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
  ): Promise<CatalogItemManifest | null> {
    const identity = await this.loadIdentity(kind, id);
    if (!identity) return null;
    const chosen = await this.pickVersion(kind, id, identity, version);
    if (!chosen) {
      if (version) {
        console.warn(`[catalog] ${kind}/${id}: requested version ${version} not found on disk`);
      } else {
        // Tombstoned identities — every on-disk version is in
        // `yankedVersions` — are an expected steady state for entries
        // the importer has marked fully deprecated upstream. The
        // directory is preserved so the next importer run unions the
        // yank list forward; warning on it just spams build output.
        const folders = await this.discoverVersionFolders(kind, id);
        const yanked = new Set(identity.yankedVersions);
        const everythingYanked = folders.length > 0 && folders.every((f) => yanked.has(f.version));
        if (!everythingYanked) {
          console.warn(`[catalog] ${kind}/${id}: no eligible versions on disk`);
        }
      }
      return null;
    }
    const versionDir = join(this.itemDir(kind, id), 'versions', chosen);
    const yankedSet = new Set(identity.yankedVersions);
    const minSupportedVersion = identity.minSupportedVersion;
    const allFolders = await this.discoverVersionFolders(kind, id);
    const availableVersions = allFolders
      .map((f) => f.version)
      .filter((v) => {
        if (yankedSet.has(v)) return false;
        if (minSupportedVersion && safeCompare(v, minSupportedVersion) < 0) return false;
        return true;
      })
      .sort((a, b) => safeCompare(b, a));
    // Craftbook templates: the single-document `craftbook.json` payload is
    // canonical (Craftbooks V2). A present-but-invalid document is a hard
    // miss — never fall back to a possibly-stale legacy manifest beside it.
    if (kind === 'craftbook-template' && identity.kind === 'craftbook-template') {
      const docText = await this.readOptional(join(versionDir, 'craftbook.json'));
      if (docText !== null) {
        const parsed = parseCraftbookDoc(docText, 'json');
        if (!parsed.ok) {
          console.warn(
            `[catalog] invalid craftbook document ${join(versionDir, 'craftbook.json')}:\n${formatCraftbookDocErrors(parsed.errors)}`,
          );
          return null;
        }
        return craftbookManifestFromDoc(identity, parsed.doc, chosen, availableVersions);
      }
      // No craftbook.json → legacy manifest.json + about.md + scripts/ layout
      // (user homes and community roots may still carry it).
    }
    const versionFile = join(versionDir, 'manifest.json');
    let versionPayload: unknown;
    try {
      versionPayload = JSON.parse(await readFile(versionFile, 'utf8'));
    } catch (err) {
      console.warn(`[catalog] failed to read ${versionFile}:`, err);
      return null;
    }
    const parsedVersion = parseVersionPayload(kind, versionPayload);
    if (!parsedVersion) {
      console.warn(`[catalog] invalid version manifest ${versionFile}`);
      return null;
    }
    if (kind === 'chat-model') {
      const v = parsedVersion as { ollama?: unknown; llamaCpp?: unknown; mlx?: unknown };
      if (!v.ollama && !v.llamaCpp && !v.mlx) {
        console.warn(
          `[catalog] ${versionFile}: chat-model version has no ollama / llamaCpp / mlx source — skipping`,
        );
        return null;
      }
    }
    if (kind === 'video-model') {
      const v = parsedVersion as { source?: { files?: unknown[] } };
      if (!v.source || !Array.isArray(v.source.files) || v.source.files.length === 0) {
        console.warn(
          `[catalog] ${versionFile}: video-model version has no source files — skipping`,
        );
        return null;
      }
    }
    return mergeIdentityAndVersion(kind, identity, parsedVersion, availableVersions);
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
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
    console.warn(`[catalog] craftbook-template/${identity.id}@${version}: doc has no releasedAt`);
    return null;
  }
  const steps = expandStepDeliverables(doc.steps);
  const entryStepId = doc.entryStepId ?? steps[0]!.id;
  const scriptNames = Object.keys(doc.scripts ?? {});
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
    version,
    releasedAt: doc.releasedAt,
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
    ...(doc.runModes ? { runModes: doc.runModes } : {}),
    ...(doc.toolsets ? { toolsets: doc.toolsets } : {}),
    ...(doc.hooks ? { hooks: doc.hooks } : {}),
    ...(doc.spawn ? { spawn: doc.spawn } : {}),
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
  | (ReturnType<typeof VideoModelVersionManifestSchema.parse> & { __kind: 'video-model' });

function parseVersionPayload(kind: CatalogKind, raw: unknown): AnyVersionPayload | null {
  try {
    if (kind === 'toolset') {
      const p = ToolsetVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'toolset' } as AnyVersionPayload;
    }
    if (kind === 'gezel-template') {
      const p = GezelTemplateVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'gezel-template' } as AnyVersionPayload;
    }
    if (kind === 'craftbook-template') {
      const p = CraftbookTemplateVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'craftbook-template' } as AnyVersionPayload;
    }
    if (kind === 'project-type') {
      const p = ProjectTypeVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'project-type' } as AnyVersionPayload;
    }
    if (kind === 'connector-type') {
      const p = ConnectorTypeVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'connector-type' } as AnyVersionPayload;
    }
    if (kind === 'chat-model') {
      const p = ChatModelVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'chat-model' } as AnyVersionPayload;
    }
    if (kind === 'video-model') {
      const p = VideoModelVersionManifestSchema.parse(raw);
      return { ...p, __kind: 'video-model' } as AnyVersionPayload;
    }
    const p = ImageModelVersionManifestSchema.parse(raw);
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
      version: version.version,
      releasedAt: version.releasedAt,
      runtime: version.runtime,
      tools: version.tools,
      config: version.config,
      ...(version.requirements ? { requirements: version.requirements } : {}),
      ...(version.notes !== undefined ? { notes: version.notes } : {}),
      availableVersions,
      ...(identity.category ? { category: identity.category } : {}),
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
      version: version.version,
      releasedAt: version.releasedAt,
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
      ...(version.runModes ? { runModes: version.runModes } : {}),
      ...(version.toolsets ? { toolsets: version.toolsets } : {}),
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
      maintainer: identity.maintainer,
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      ...(version.extends !== undefined ? { extends: version.extends } : {}),
      ...(version.meesterManaged !== undefined ? { meesterManaged: version.meesterManaged } : {}),
      ...(version.tabVisibility !== undefined ? { tabVisibility: version.tabVisibility } : {}),
      ...(version.mode !== undefined ? { mode: version.mode } : {}),
      ...(version.leadLabel !== undefined ? { leadLabel: version.leadLabel } : {}),
      ...(version.leanProfile !== undefined ? { leanProfile: version.leanProfile } : {}),
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
      version: version.version,
      releasedAt: version.releasedAt,
      driver: version.driver,
      ...(version.configSchema !== undefined ? { configSchema: version.configSchema } : {}),
      ...(version.secretShape !== undefined ? { secretShape: version.secretShape } : {}),
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
      ...(identity.logo !== undefined ? { logo: identity.logo } : {}),
      ...(identity.license !== undefined ? { license: identity.license } : {}),
      ...(identity.licenseClass !== undefined ? { licenseClass: identity.licenseClass } : {}),
      ...(identity.licenseShortName !== undefined
        ? { licenseShortName: identity.licenseShortName }
        : {}),
      ...(identity.licenseUrl !== undefined ? { licenseUrl: identity.licenseUrl } : {}),
      ...(identity.recoScore !== undefined ? { recoScore: identity.recoScore } : {}),
      version: version.version,
      releasedAt: version.releasedAt,
      parameterSize: identity.parameterSize,
      approxSizeBytes: version.approxSizeBytes,
      supportsTools: identity.supportsTools,
      ...(identity.contextWindow !== undefined ? { contextWindow: identity.contextWindow } : {}),
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
      auxiliaryFiles: version.auxiliaryFiles,
      hardwareTier: identity.hardwareTier,
      minRamGB: identity.minRamGB,
      commercialUse: identity.commercialUse,
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
