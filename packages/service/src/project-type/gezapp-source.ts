/**
 * AI App source folders — the authoring form of a `.gezapp`.
 *
 * A source folder is byte-compatible with an unzipped package: a root
 * `gezapp.json` (minimal, everything heavy is derived) beside the same
 * `items/{project-types|gezel-templates|craftbook-templates}/<shard>/<id>/`
 * tree the archive carries. Two conveniences exist only at authoring
 * time: a root `manifest.json` that parses as a *packed* manifest is
 * tolerated (that is what unzipping an exported app produces), and a
 * project-type version may keep scripts as real sidecar files under
 * `versions/<v>/scripts/<name>.ts` instead of (or beside) the inline
 * `scripts` map. Packing folds sidecars into the map and drops the
 * files, so the shipped format — and everything at runtime — is
 * unchanged.
 *
 * Validation is collect-all and layered: folder shape, per-item payload
 * parses, package parity (the same `verifyGezapp` an import runs, over
 * an in-memory assembly), referenced files + craftbook graphs, page
 * checks, and offline dependency availability. Error severity means
 * "pack/import/adoption/runtime would break"; warn is advisory.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Script as VmScript } from 'node:vm';
import {
  CatalogItemIdentitySchema,
  type CraftbookDoc,
  CraftbookTemplateVersionManifestSchema,
  GEZAPP_SOURCE_MANIFEST_FILENAME,
  type GezappDependency,
  type GezappEmbeddedKind,
  type GezappItem,
  type GezappManifest,
  GezappManifestSchema,
  type GezappSourceManifest,
  GezappSourceManifestSchema,
  GezelTemplateVersionManifestSchema,
  type ProjectTypeVersionManifest,
  ProjectTypeVersionManifestSchema,
  ScriptNameSchema,
  compareSemver,
  craftbookFromDoc,
  formatCraftbookDocErrors,
  isSemver,
  maxMinGezelVersion,
  parseCraftbookDoc,
  parseCraftbookTestSpec,
} from '@bendyline/gezel';
import { CatalogService, renderGildeSchemaFiles, renderSchema } from '@bendyline/gezel-catalog';
import { validateCraftbookScripts } from '../scripts/source.js';
import { parseCron } from '../tasks/cron.js';
import {
  GEZAPP_KIND_DIR,
  type GezappDependencyLockInputs,
  buildGezappArchive,
  hashGezappItemFiles,
  isSafeGezappArchivePath,
  missingGezappDependencies,
  resolveGezappDependencyLock,
  verifyGezapp,
} from './gezapp.js';

export interface GezappSourceFinding {
  severity: 'error' | 'warn';
  /** Source-root-relative path ('' = the whole folder). */
  file: string;
  /** Slash pointer inside the file ('' = the whole file). */
  pointer: string;
  /** Stable kebab-case rule id, e.g. 'script-name-collision'. */
  rule: string;
  message: string;
}

export class GezappSourceError extends Error {
  readonly findings: GezappSourceFinding[];
  constructor(findings: GezappSourceFinding[]) {
    const errors = findings.filter((finding) => finding.severity === 'error');
    super(
      `AI App source folder has ${errors.length} error${errors.length === 1 ? '' : 's'} — ` +
        `run \`gezel app validate\` for the full report. First: ${errors[0]?.message ?? 'unknown'}`,
    );
    this.name = 'GezappSourceError';
    this.findings = findings;
  }
}

/** Placeholder for synthesized manifests before pack stamps the real time. */
const PLACEHOLDER_CREATED_AT = '1970-01-01T00:00:00.000Z';

const OS_JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Extensions that ship without comment. Mirrors gilde's content
 * allowlist (json/md/html/svg/webp) plus page assets and script
 * sidecars. Anything else still packs — the warn exists so a stray
 * archive or binary is a decision, not an accident.
 */
const EXPECTED_EXTENSIONS = new Set([
  '.json',
  '.md',
  '.html',
  '.svg',
  '.webp',
  '.css',
  '.js',
  '.ts',
]);

const KIND_BY_DIR: Record<string, GezappEmbeddedKind> = Object.fromEntries(
  Object.entries(GEZAPP_KIND_DIR).map(([kind, dir]) => [dir, kind as GezappEmbeddedKind]),
);

type LegacyCraftbookVersionManifest = ReturnType<
  typeof CraftbookTemplateVersionManifestSchema.parse
>;

interface SourceItemAnalysis {
  kind: GezappEmbeddedKind;
  id: string;
  /** Source-root-relative item dir, e.g. 'items/project-types/ex/example-journal'. */
  dir: string;
  identity: ReturnType<typeof CatalogItemIdentitySchema.parse> | null;
  versions: string[];
  selectedVersion: string | null;
  /** Item-relative path → content, selected version only, sidecars folded. */
  files: Array<{ rel: string; content: Buffer }>;
}

interface SourceAnalysis {
  findings: GezappSourceFinding[];
  sourceManifest: GezappSourceManifest | null;
  /** Entry/publisher recovered from a tolerated packed root manifest.json. */
  packedFallback: GezappManifest | null;
  entry: { projectType: string; version: string } | null;
  entryItem: SourceItemAnalysis | null;
  entryVersionManifest: ProjectTypeVersionManifest | null;
  /** Package-relative path (`items/…`) → content, post-fold. */
  files: Map<string, Buffer>;
  items: GezappItem[];
  roleVersions: Map<string, ReturnType<typeof GezelTemplateVersionManifestSchema.parse>>;
  craftbookDocs: Map<string, CraftbookDoc>;
  craftbookLegacy: Map<string, LegacyCraftbookVersionManifest>;
  /** Craftbook-template id → raw test.json bytes when present. */
  testSpecs: Map<string, Buffer>;
  embeddedCraftbooks: Map<string, CraftbookDoc>;
  /** Entry-type script name → source-root-relative sidecar path it came from. */
  scriptOrigins: Map<string, string>;
  minGezelVersion: string | undefined;
}

export interface AssembledGezappSource {
  sourceManifest: GezappSourceManifest | null;
  entry: { projectType: string; version: string } | null;
  /** Package-relative (`items/…`) → normalized bytes (sidecars folded, dropped). */
  files: Map<string, Buffer>;
  items: GezappItem[];
  findings: GezappSourceFinding[];
}

export interface ValidateGezappSourceResult {
  /** True when no error-severity findings exist. */
  ok: boolean;
  findings: GezappSourceFinding[];
  /** Synthesized packed manifest (placeholder createdAt) when assemblable. */
  manifest: GezappManifest | null;
}

export interface PackGezappFromSourceResult {
  buffer: Buffer;
  manifest: GezappManifest;
  /** Warnings that did not block the pack. */
  findings: GezappSourceFinding[];
}

export interface GezappSourceOptions {
  /** Entry project-type version override (defaults to gezapp.json's pin, then highest). */
  version?: string;
  /** Catalog for dependency resolution. Defaults to the offline bundled catalog. */
  catalog?: CatalogService;
}

/** Whether a directory looks like an AI App source folder. */
export async function isGezappSourceDir(path: string): Promise<boolean> {
  const exists = async (candidate: string, dir: boolean): Promise<boolean> => {
    try {
      const info = await stat(candidate);
      return dir ? info.isDirectory() : info.isFile();
    } catch {
      return false;
    }
  };
  if (await exists(join(path, GEZAPP_SOURCE_MANIFEST_FILENAME), false)) return true;
  return exists(join(path, 'items'), true);
}

/**
 * The JSON Schemas an app author (human or AI) codes against: every
 * catalog content schema plus the packed and source gezapp manifests.
 * Rendered live from core's Zod schemas, so they can never lag a build.
 */
export function renderGezappAuthoringSchemaFiles(): Array<[filename: string, content: string]> {
  const catalogSchemas = renderGildeSchemaFiles().filter(
    ([filename]) => filename.endsWith('.schema.json') && filename !== 'catalog-index.schema.json',
  );
  return [
    ...catalogSchemas,
    [
      'gezapp-manifest.schema.json',
      renderSchema('gezapp-manifest.schema.json', GezappManifestSchema),
    ],
    [
      'gezapp-source-manifest.schema.json',
      renderSchema('gezapp-source-manifest.schema.json', GezappSourceManifestSchema),
    ],
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

interface WalkedFile {
  /** Posix path relative to the source root, always starting `items/`. */
  rel: string;
  content: Buffer;
}

async function walkItemsTree(root: string, findings: GezappSourceFinding[]): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const visit = async (dirAbs: string, dirRel: string): Promise<void> => {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${dirRel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        findings.push({
          severity: 'warn',
          file: rel,
          pointer: '',
          rule: 'symlink-skipped',
          message: 'symbolic links are never packed; replace it with the real file',
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(join(dirAbs, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (OS_JUNK_FILES.has(entry.name.toLowerCase())) {
        findings.push({
          severity: 'warn',
          file: rel,
          pointer: '',
          rule: 'os-junk-file',
          message: 'operating-system junk file; excluded from the package',
        });
        continue;
      }
      if (!isSafeGezappArchivePath(rel)) {
        findings.push({
          severity: 'error',
          file: rel,
          pointer: '',
          rule: 'unsafe-item-path',
          message:
            'path is not portable across platforms (reserved name, trailing space/dot, or unsafe segment)',
        });
        continue;
      }
      if (!EXPECTED_EXTENSIONS.has(extensionOf(entry.name))) {
        findings.push({
          severity: 'warn',
          file: rel,
          pointer: '',
          rule: 'unexpected-extension',
          message:
            'unusual file type for catalog content (expected json/md/html/svg/webp/css/js/ts); it will still be packed',
        });
      }
      out.push({ rel, content: await readFile(join(dirAbs, entry.name)) });
    }
  };
  await visit(root, 'items');
  return out;
}

const DERIVED_MANIFEST_FIELDS = new Set([
  'items',
  'dependencies',
  'createdAt',
  'signature',
  'minGezelVersion',
  'provenance',
  'name',
  'description',
]);

async function readSourceManifest(
  dir: string,
  findings: GezappSourceFinding[],
): Promise<{ sourceManifest: GezappSourceManifest | null; packedFallback: GezappManifest | null }> {
  const sourceBytes = await readFileIfExists(join(dir, GEZAPP_SOURCE_MANIFEST_FILENAME));
  if (sourceBytes) {
    let raw: unknown;
    try {
      raw = JSON.parse(sourceBytes.toString('utf8'));
    } catch (err) {
      findings.push({
        severity: 'error',
        file: GEZAPP_SOURCE_MANIFEST_FILENAME,
        pointer: '',
        rule: 'source-manifest-invalid',
        message: `not valid JSON: ${errorMessage(err)}`,
      });
      return { sourceManifest: null, packedFallback: null };
    }
    const parsed = GezappSourceManifestSchema.safeParse(raw);
    if (parsed.success) return { sourceManifest: parsed.data, packedFallback: null };
    for (const issue of parsed.error.issues) {
      const derived =
        issue.code === 'unrecognized_keys'
          ? issue.keys.filter((key) => DERIVED_MANIFEST_FIELDS.has(key))
          : [];
      if (derived.length > 0) {
        findings.push({
          severity: 'error',
          file: GEZAPP_SOURCE_MANIFEST_FILENAME,
          pointer: `/${derived[0]}`,
          rule: 'source-manifest-derived-field',
          message: `${derived.join(', ')}: generated by \`gezel app pack\` — remove from gezapp.json`,
        });
      } else {
        findings.push({
          severity: 'error',
          file: GEZAPP_SOURCE_MANIFEST_FILENAME,
          pointer: issue.path.length > 0 ? `/${issue.path.map(String).join('/')}` : '',
          rule: 'source-manifest-invalid',
          message: issue.message,
        });
      }
    }
    return { sourceManifest: null, packedFallback: null };
  }

  const packedBytes = await readFileIfExists(join(dir, 'manifest.json'));
  if (packedBytes) {
    try {
      const packed = GezappManifestSchema.parse(JSON.parse(packedBytes.toString('utf8')));
      findings.push({
        severity: 'warn',
        file: 'manifest.json',
        pointer: '',
        rule: 'stale-packed-manifest',
        message:
          'packed manifest found at the source root (an unzipped .gezapp); pack regenerates it — consider replacing it with a minimal gezapp.json',
      });
      return { sourceManifest: null, packedFallback: packed };
    } catch (err) {
      findings.push({
        severity: 'error',
        file: 'manifest.json',
        pointer: '',
        rule: 'source-manifest-invalid',
        message: `neither a gezapp.json nor a packed manifest: ${errorMessage(err)}`,
      });
      return { sourceManifest: null, packedFallback: null };
    }
  }

  findings.push({
    severity: 'warn',
    file: '',
    pointer: '',
    rule: 'missing-source-manifest',
    message: `no ${GEZAPP_SOURCE_MANIFEST_FILENAME} at the source root; pack will derive entry and publisher from the items tree`,
  });
  return { sourceManifest: null, packedFallback: null };
}

interface RawItemGroup {
  kind: GezappEmbeddedKind;
  kindDir: string;
  shardDir: string;
  id: string;
  dir: string;
  /** Item-relative path → content. */
  files: Map<string, Buffer>;
}

function groupItems(walked: WalkedFile[], findings: GezappSourceFinding[]): RawItemGroup[] {
  const groups = new Map<string, RawItemGroup>();
  for (const file of walked) {
    const parts = file.rel.split('/');
    const [, kindDir, shardDir, id] = parts;
    if (!kindDir || !(kindDir in KIND_BY_DIR)) {
      findings.push({
        severity: 'error',
        file: file.rel,
        pointer: '',
        rule: 'unsupported-kind-dir',
        message: `items/ may only contain ${Object.values(GEZAPP_KIND_DIR).join(', ')}`,
      });
      continue;
    }
    if (parts.length < 5 || !shardDir || !id) {
      findings.push({
        severity: 'error',
        file: file.rel,
        pointer: '',
        rule: 'stray-file',
        message: `expected items/${kindDir}/<shard>/<id>/… — files cannot sit above an item folder`,
      });
      continue;
    }
    const key = `${kindDir}/${shardDir}/${id}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: KIND_BY_DIR[kindDir]!,
        kindDir,
        shardDir,
        id,
        dir: `items/${key}`,
        files: new Map(),
      };
      groups.set(key, group);
    }
    group.files.set(parts.slice(4).join('/'), file.content);
  }
  return [...groups.values()];
}

function parseJsonFile(
  group: RawItemGroup,
  rel: string,
  findings: GezappSourceFinding[],
): unknown | undefined {
  const bytes = group.files.get(rel);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    findings.push({
      severity: 'error',
      file: `${group.dir}/${rel}`,
      pointer: '',
      rule: 'invalid-json',
      message: errorMessage(err),
    });
    return undefined;
  }
}

/**
 * Fold `versions/<v>/scripts/<name>.ts` sidecars into the raw version
 * manifest's `scripts` map, mutating `group.files`: the manifest bytes
 * are rewritten and the sidecar files removed, so the packed item is
 * exactly what today's runtime reads. Returns script name → sidecar
 * source path for later diagnostics attribution.
 */
function foldScriptSidecars(
  group: RawItemGroup,
  version: string,
  findings: GezappSourceFinding[],
): Map<string, string> {
  const origins = new Map<string, string>();
  const scriptsPrefix = `versions/${version}/scripts/`;
  const sidecars = [...group.files.keys()].filter((rel) => rel.startsWith(scriptsPrefix));
  if (sidecars.length === 0) return origins;

  const manifestRel = `versions/${version}/manifest.json`;
  const raw = parseJsonFile(group, manifestRel, findings);
  if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return origins;
  }
  const manifest = raw as Record<string, unknown>;
  const inline =
    typeof manifest.scripts === 'object' && manifest.scripts !== null
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...inline };

  for (const rel of sidecars.sort()) {
    const sourcePath = `${group.dir}/${rel}`;
    const remainder = rel.slice(scriptsPrefix.length);
    if (remainder.includes('/') || !remainder.endsWith('.ts')) {
      findings.push({
        severity: 'error',
        file: sourcePath,
        pointer: '',
        rule: 'invalid-script-filename',
        message: 'scripts/ holds flat <name>.ts sidecar files only',
      });
      continue;
    }
    const name = remainder.slice(0, -'.ts'.length);
    if (!ScriptNameSchema.safeParse(name).success) {
      findings.push({
        severity: 'error',
        file: sourcePath,
        pointer: '',
        rule: 'invalid-script-filename',
        message:
          'script name must start with a letter and contain only letters, digits, underscore, or hyphen',
      });
      continue;
    }
    if (name in inline) {
      findings.push({
        severity: 'error',
        file: sourcePath,
        pointer: '',
        rule: 'script-name-collision',
        message: `"${name}" is defined inline in ${manifestRel} and as a sidecar file — keep one`,
      });
      continue;
    }
    merged[name] = group.files.get(rel)!.toString('utf8');
    origins.set(name, sourcePath);
    group.files.delete(rel);
  }

  manifest.scripts = merged;
  group.files.set(manifestRel, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return origins;
}

async function analyzeGezappSource(
  dir: string,
  opts?: GezappSourceOptions,
): Promise<SourceAnalysis> {
  const findings: GezappSourceFinding[] = [];
  const analysis: SourceAnalysis = {
    findings,
    sourceManifest: null,
    packedFallback: null,
    entry: null,
    entryItem: null,
    entryVersionManifest: null,
    files: new Map(),
    items: [],
    roleVersions: new Map(),
    craftbookDocs: new Map(),
    craftbookLegacy: new Map(),
    testSpecs: new Map(),
    embeddedCraftbooks: new Map(),
    scriptOrigins: new Map(),
    minGezelVersion: undefined,
  };

  const manifests = await readSourceManifest(dir, findings);
  analysis.sourceManifest = manifests.sourceManifest;
  analysis.packedFallback = manifests.packedFallback;

  const itemsRoot = join(dir, 'items');
  let itemsRootStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    itemsRootStat = await stat(itemsRoot);
  } catch {
    itemsRootStat = null;
  }
  if (!itemsRootStat?.isDirectory()) {
    findings.push({
      severity: 'error',
      file: '',
      pointer: '',
      rule: 'missing-items-tree',
      message: 'no items/ directory — an AI App source folder is gezapp.json plus items/…',
    });
    return analysis;
  }

  const walked = await walkItemsTree(itemsRoot, findings);
  const groups = groupItems(walked, findings);
  const entryPin = opts?.version ?? analysis.sourceManifest?.entry?.version;
  const entryIdPin =
    analysis.sourceManifest?.entry?.projectType ?? analysis.packedFallback?.entry.projectType;

  const itemAnalyses: SourceItemAnalysis[] = [];
  for (const group of groups) {
    const item: SourceItemAnalysis = {
      kind: group.kind,
      id: group.id,
      dir: group.dir,
      identity: null,
      versions: [],
      selectedVersion: null,
      files: [],
    };
    itemAnalyses.push(item);

    if (group.shardDir !== group.id.slice(0, 2).toLowerCase()) {
      findings.push({
        severity: 'error',
        file: group.dir,
        pointer: '',
        rule: 'shard-mismatch',
        message: `item folder must sit under shard "${group.id.slice(0, 2).toLowerCase()}" (the first two characters of the id)`,
      });
    }

    const identityRaw = parseJsonFile(group, 'manifest.json', findings);
    if (group.files.has('manifest.json')) {
      if (identityRaw !== undefined) {
        const parsed = CatalogItemIdentitySchema.safeParse(identityRaw);
        if (!parsed.success) {
          findings.push({
            severity: 'error',
            file: `${group.dir}/manifest.json`,
            pointer: '',
            rule: 'invalid-manifest',
            message: parsed.error.issues
              .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
              .join('; '),
          });
        } else {
          item.identity = parsed.data;
          if (parsed.data.kind !== group.kind) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/manifest.json`,
              pointer: '/kind',
              rule: 'kind-dir-mismatch',
              message: `identity declares "${parsed.data.kind}" but the item sits under ${group.kindDir}/`,
            });
          }
          if (parsed.data.id !== group.id) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/manifest.json`,
              pointer: '/id',
              rule: 'id-dir-mismatch',
              message: `identity declares id "${parsed.data.id}" but the folder is named "${group.id}"`,
            });
          }
        }
      }
    } else {
      findings.push({
        severity: 'error',
        file: group.dir,
        pointer: '',
        rule: 'missing-identity',
        message: 'item has no root manifest.json (the identity manifest)',
      });
    }

    const versionDirs = new Set<string>();
    for (const rel of group.files.keys()) {
      if (!rel.startsWith('versions/')) continue;
      const name = rel.split('/')[1];
      if (name) versionDirs.add(name);
    }
    for (const name of [...versionDirs].sort()) {
      if (!isSemver(name)) {
        findings.push({
          severity: 'error',
          file: `${group.dir}/versions/${name}`,
          pointer: '',
          rule: 'bad-version-dir',
          message: 'version folders must be exact semver (for example 1.0.0)',
        });
        versionDirs.delete(name);
      }
    }
    item.versions = [...versionDirs].sort(compareSemver);
    if (item.versions.length === 0) {
      findings.push({
        severity: 'error',
        file: group.dir,
        pointer: '',
        rule: 'missing-version-payload',
        message: 'item has no versions/<semver>/ payload',
      });
      continue;
    }

    const pinned =
      group.kind === 'project-type' && group.id === (entryIdPin ?? group.id) ? entryPin : undefined;
    if (pinned && !item.versions.includes(pinned)) {
      findings.push({
        severity: 'error',
        file: group.dir,
        pointer: '',
        rule: 'entry-not-found',
        message: `pinned entry version ${pinned} has no versions/${pinned}/ folder (found: ${item.versions.join(', ')})`,
      });
      continue;
    }
    const selected = pinned ?? item.versions[item.versions.length - 1]!;
    item.selectedVersion = selected;

    if (group.kind === 'project-type') {
      const origins = foldScriptSidecars(group, selected, findings);
      for (const [name, origin] of origins) analysis.scriptOrigins.set(name, origin);
    }

    // Parse every version payload; the selected one is kept for deep checks.
    for (const version of item.versions) {
      const prefix = `versions/${version}/`;
      if (group.kind === 'craftbook-template') {
        const docRaw = group.files.get(`${prefix}craftbook.json`);
        if (docRaw) {
          const parsed = parseCraftbookDoc(docRaw.toString('utf8'), 'json');
          if (!parsed.ok) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/${prefix}craftbook.json`,
              pointer: '',
              rule: 'invalid-craftbook',
              message: formatCraftbookDocErrors(parsed.errors),
            });
            continue;
          }
          if (parsed.doc.version !== version) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/${prefix}craftbook.json`,
              pointer: '/version',
              rule: 'version-folder-mismatch',
              message: `craftbook.json says ${parsed.doc.version ?? '(missing)'} but the folder is versions/${version}/`,
            });
          }
          // Optional on the doc schema, but the catalog's version discovery
          // skips a craftbook.json without it — the item would install and
          // then silently fail to resolve.
          if (!parsed.doc.releasedAt) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/${prefix}craftbook.json`,
              pointer: '/releasedAt',
              rule: 'missing-releasedAt',
              message:
                'craftbook.json needs a releasedAt timestamp — the catalog skips versions without one',
            });
          }
          if (version === selected) {
            analysis.craftbookDocs.set(group.id, parsed.doc);
          }
          continue;
        }
        const legacyRaw = parseJsonFile(group, `${prefix}manifest.json`, findings);
        if (legacyRaw === undefined) {
          if (!group.files.has(`${prefix}manifest.json`)) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/versions/${version}`,
              pointer: '',
              rule: 'missing-version-payload',
              message: 'craftbook version needs craftbook.json (or a legacy manifest.json)',
            });
          }
          continue;
        }
        const legacy = CraftbookTemplateVersionManifestSchema.safeParse(legacyRaw);
        if (!legacy.success) {
          findings.push({
            severity: 'error',
            file: `${group.dir}/${prefix}manifest.json`,
            pointer: '',
            rule: 'invalid-manifest',
            message: legacy.error.issues
              .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
              .join('; '),
          });
        } else {
          if (legacy.data.version !== version) {
            findings.push({
              severity: 'error',
              file: `${group.dir}/${prefix}manifest.json`,
              pointer: '/version',
              rule: 'version-folder-mismatch',
              message: `manifest says ${legacy.data.version} but the folder is versions/${version}/`,
            });
          }
          if (version === selected) analysis.craftbookLegacy.set(group.id, legacy.data);
        }
        continue;
      }

      const manifestRaw = parseJsonFile(group, `${prefix}manifest.json`, findings);
      if (manifestRaw === undefined) {
        if (!group.files.has(`${prefix}manifest.json`)) {
          findings.push({
            severity: 'error',
            file: `${group.dir}/versions/${version}`,
            pointer: '',
            rule: 'missing-version-payload',
            message: 'version folder has no manifest.json',
          });
        }
        continue;
      }
      const schema =
        group.kind === 'project-type'
          ? ProjectTypeVersionManifestSchema
          : GezelTemplateVersionManifestSchema;
      const parsed = schema.safeParse(manifestRaw);
      if (!parsed.success) {
        findings.push({
          severity: 'error',
          file: `${group.dir}/${prefix}manifest.json`,
          pointer: '',
          rule: 'invalid-manifest',
          message: parsed.error.issues
            .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        });
        continue;
      }
      if (parsed.data.version !== version) {
        findings.push({
          severity: 'error',
          file: `${group.dir}/${prefix}manifest.json`,
          pointer: '/version',
          rule: 'version-folder-mismatch',
          message: `manifest says ${parsed.data.version} but the folder is versions/${version}/`,
        });
      }
      if (version === selected) {
        if (group.kind === 'project-type') {
          analysis.entryVersionManifest = parsed.data as ProjectTypeVersionManifest;
          analysis.minGezelVersion = maxMinGezelVersion(
            analysis.minGezelVersion,
            (parsed.data as ProjectTypeVersionManifest).minGezelVersion,
          );
        } else {
          const role = parsed.data as ReturnType<typeof GezelTemplateVersionManifestSchema.parse>;
          analysis.roleVersions.set(group.id, role);
          analysis.minGezelVersion = maxMinGezelVersion(
            analysis.minGezelVersion,
            role.minGezelVersion,
          );
        }
      }
    }

    // The packed payload: item-root files plus the selected version only.
    item.files = [...group.files.entries()]
      .filter(([rel]) => !rel.startsWith('versions/') || rel.startsWith(`versions/${selected}/`))
      .map(([rel, content]) => ({ rel, content }));

    if (group.kind === 'craftbook-template') {
      const spec = group.files.get(`versions/${selected}/test.json`);
      if (spec) analysis.testSpecs.set(group.id, spec);
    }
  }

  // Entry discovery: exactly one project type, or the pinned id.
  const projectTypes = itemAnalyses.filter((item) => item.kind === 'project-type');
  let entryItem: SourceItemAnalysis | null = null;
  if (entryIdPin) {
    entryItem = projectTypes.find((item) => item.id === entryIdPin) ?? null;
    if (!entryItem) {
      findings.push({
        severity: 'error',
        file: GEZAPP_SOURCE_MANIFEST_FILENAME,
        pointer: '/entry/projectType',
        rule: 'entry-not-found',
        message: `entry project type "${entryIdPin}" is not in the items tree`,
      });
    }
  } else if (projectTypes.length === 1) {
    entryItem = projectTypes[0]!;
  } else if (projectTypes.length === 0) {
    findings.push({
      severity: 'error',
      file: '',
      pointer: '',
      rule: 'entry-not-found',
      message: 'the items tree holds no project type — every AI App is built around exactly one',
    });
  } else {
    findings.push({
      severity: 'error',
      file: '',
      pointer: '',
      rule: 'multiple-project-types',
      message: `found ${projectTypes.length} project types (${projectTypes.map((item) => item.id).join(', ')}); pin one as entry.projectType in ${GEZAPP_SOURCE_MANIFEST_FILENAME}`,
    });
  }
  analysis.entryItem = entryItem;
  if (entryItem?.selectedVersion) {
    analysis.entry = { projectType: entryItem.id, version: entryItem.selectedVersion };
  }

  // Embedded type-private craftbooks referenced by the entry manifest.
  if (entryItem?.selectedVersion && analysis.entryVersionManifest) {
    const prefix = `versions/${entryItem.selectedVersion}/craftbooks/`;
    const referenced = new Set(analysis.entryVersionManifest.craftbooks);
    for (const file of entryItem.files) {
      if (!file.rel.startsWith(prefix) || !file.rel.endsWith('.json')) continue;
      const id = file.rel.slice(prefix.length, -'.json'.length);
      if (!referenced.has(id)) {
        findings.push({
          severity: 'warn',
          file: `${entryItem.dir}/${file.rel}`,
          pointer: '',
          rule: 'unreferenced-embedded-craftbook',
          message: `embedded craftbook "${id}" is not listed in the version manifest's craftbooks — it will ship but never install`,
        });
      }
      const parsed = parseCraftbookDoc(file.content.toString('utf8'), 'json');
      if (!parsed.ok) {
        findings.push({
          severity: 'error',
          file: `${entryItem.dir}/${file.rel}`,
          pointer: '',
          rule: 'invalid-craftbook',
          message: formatCraftbookDocErrors(parsed.errors),
        });
        continue;
      }
      if (parsed.doc.id && parsed.doc.id !== id) {
        findings.push({
          severity: 'error',
          file: `${entryItem.dir}/${file.rel}`,
          pointer: '/id',
          rule: 'craftbook-id-mismatch',
          message: `document id "${parsed.doc.id}" must match the filename "${id}.json"`,
        });
      }
      analysis.embeddedCraftbooks.set(id, parsed.doc);
    }
  }

  // Assemble the package view: files map + hashed item list.
  for (const item of itemAnalyses) {
    if (!item.selectedVersion) continue;
    for (const file of item.files) {
      analysis.files.set(`${item.dir}/${file.rel}`, file.content);
    }
    analysis.items.push({
      kind: item.kind,
      id: item.id,
      version: item.selectedVersion,
      sha256: hashGezappItemFiles(item.files),
    });
  }

  return analysis;
}

function synthesizeManifest(
  analysis: SourceAnalysis,
  dependencies: GezappDependency[],
  opts: { createdAt: string; publisher?: { name: string; url?: string } },
): GezappManifest | null {
  if (!analysis.entry || !analysis.entryItem?.identity) return null;
  const identity = analysis.entryItem.identity;
  const publisher =
    opts.publisher ??
    analysis.sourceManifest?.publisher ??
    analysis.packedFallback?.publisher ??
    identity.maintainer;
  try {
    return GezappManifestSchema.parse({
      format: 'gezel-ai-app',
      schemaVersion: 1,
      entry: analysis.entry,
      name: identity.name,
      description: identity.description,
      publisher,
      createdAt: opts.createdAt,
      ...(analysis.minGezelVersion ? { minGezelVersion: analysis.minGezelVersion } : {}),
      signature: { status: 'unsigned' },
      items: analysis.items,
      dependencies,
      provenance: { source: 'source-folder' },
    });
  } catch (err) {
    analysis.findings.push({
      severity: 'error',
      file: GEZAPP_SOURCE_MANIFEST_FILENAME,
      pointer: '',
      rule: 'package-manifest',
      message: errorMessage(err),
    });
    return null;
  }
}

function lockInputsFrom(analysis: SourceAnalysis): GezappDependencyLockInputs {
  const craftbooks: GezappDependencyLockInputs['craftbooks'] = [];
  for (const [id, doc] of analysis.craftbookDocs) {
    craftbooks.push({
      id,
      ...(doc.toolsets ? { toolsets: doc.toolsets } : {}),
      ...(doc.connectors ? { connectors: doc.connectors } : {}),
    });
  }
  for (const [id, legacy] of analysis.craftbookLegacy) {
    craftbooks.push({
      id,
      ...(legacy.toolsets ? { toolsets: legacy.toolsets } : {}),
      ...(legacy.connectors ? { connectors: legacy.connectors } : {}),
    });
  }
  for (const [id, doc] of analysis.embeddedCraftbooks) {
    craftbooks.push({
      id,
      ...(doc.toolsets ? { toolsets: doc.toolsets } : {}),
      ...(doc.connectors ? { connectors: doc.connectors } : {}),
    });
  }
  return {
    typeToolsets: analysis.entryVersionManifest?.toolsets ?? [],
    roles: [...analysis.roleVersions.entries()].map(([id, role]) => ({
      id,
      suggestedTools: role.suggestedTools,
      ...(role.suggestedModel ? { suggestedModel: role.suggestedModel } : {}),
    })),
    craftbooks,
  };
}

function checkReferencedFiles(analysis: SourceAnalysis): void {
  const entryItem = analysis.entryItem;
  const manifest = analysis.entryVersionManifest;
  if (!entryItem?.selectedVersion || !manifest) return;
  const manifestFile = `${entryItem.dir}/versions/${entryItem.selectedVersion}/manifest.json`;
  const versionPrefix = `${entryItem.dir}/versions/${entryItem.selectedVersion}/`;
  const missing = (pointer: string, ref: string): void => {
    analysis.findings.push({
      severity: 'error',
      file: manifestFile,
      pointer,
      rule: 'missing-referenced-file',
      message: `"${ref}" does not exist in the version folder`,
    });
  };
  const refs: Array<[pointer: string, ref: string | undefined]> = [
    ['/aboutTemplate', manifest.aboutTemplate],
    ['/missionTemplate', manifest.missionTemplate],
    ...manifest.workspaceSeed.map(
      (ref, index) => [`/workspaceSeed/${index}`, ref] as [string, string],
    ),
    ...manifest.artifactsSeed.map(
      (ref, index) => [`/artifactsSeed/${index}`, ref] as [string, string],
    ),
  ];
  for (const [pointer, ref] of refs) {
    if (typeof ref === 'string' && !analysis.files.has(`${versionPrefix}${ref}`)) {
      missing(pointer, ref);
    }
  }
  if (manifest.pages && !analysis.files.has(`${versionPrefix}pages/${manifest.pages.entry}`)) {
    missing('/pages/entry', `pages/${manifest.pages.entry}`);
  }

  for (const [id, role] of analysis.roleVersions) {
    const item = analysis.items.find(
      (candidate) => candidate.kind === 'gezel-template' && candidate.id === id,
    );
    if (!item) continue;
    const aboutPath = `items/${GEZAPP_KIND_DIR['gezel-template']}/${id.slice(0, 2).toLowerCase()}/${id}/versions/${item.version}/${role.about}`;
    if (!analysis.files.has(aboutPath)) {
      analysis.findings.push({
        severity: 'error',
        file: `items/${GEZAPP_KIND_DIR['gezel-template']}/${id.slice(0, 2).toLowerCase()}/${id}/versions/${item.version}/manifest.json`,
        pointer: '/about',
        rule: 'missing-referenced-file',
        message: `"${role.about}" does not exist in the version folder`,
      });
    }
  }
}

function checkComposition(analysis: SourceAnalysis): void {
  const manifest = analysis.entryVersionManifest;
  const entryItem = analysis.entryItem;
  if (!manifest || !entryItem?.selectedVersion) return;
  const manifestFile = `${entryItem.dir}/versions/${entryItem.selectedVersion}/manifest.json`;

  const craftbookIds = new Set(manifest.craftbooks);
  for (const [index, schedule] of manifest.schedules.entries()) {
    if (!craftbookIds.has(schedule.craftbook)) {
      analysis.findings.push({
        severity: 'error',
        file: manifestFile,
        pointer: `/schedules/${index}/craftbook`,
        rule: 'schedule-unknown-craftbook',
        message: `"${schedule.craftbook}" is not in this version's craftbooks list`,
      });
    }
    if (schedule.runMode === 'scheduled') {
      try {
        parseCron(schedule.cron ?? '');
      } catch (err) {
        analysis.findings.push({
          severity: 'error',
          file: manifestFile,
          pointer: `/schedules/${index}/cron`,
          rule: 'invalid-cron',
          message: errorMessage(err),
        });
      }
    }
  }

  const scriptNames = new Set(Object.keys(manifest.scripts ?? {}));
  const toolNames = new Set<string>();
  const templateIds = new Set(manifest.gezels.map((ref) => ref.templateId));
  for (const [index, tool] of manifest.tools.entries()) {
    toolNames.add(tool.name);
    if (!scriptNames.has(tool.script)) {
      analysis.findings.push({
        severity: 'error',
        file: manifestFile,
        pointer: `/tools/${index}/script`,
        rule: 'tool-script-missing',
        message: `tool "${tool.name}" names script "${tool.script}", which is neither inline nor a scripts/ sidecar`,
      });
    }
    if (tool.reaction && !templateIds.has(tool.reaction.gezel)) {
      analysis.findings.push({
        severity: 'warn',
        file: manifestFile,
        pointer: `/tools/${index}/reaction/gezel`,
        rule: 'reaction-unknown-gezel',
        message: `reaction names "${tool.reaction.gezel}", which is not a gezels[].templateId — the runtime will fall back to the project voorman`,
      });
    }
  }
  for (const [index, name] of (manifest.pages?.tools ?? []).entries()) {
    if (!toolNames.has(name)) {
      analysis.findings.push({
        severity: 'error',
        file: manifestFile,
        pointer: `/pages/tools/${index}`,
        rule: 'page-tool-missing',
        message: `"${name}" is not a declared tool`,
      });
    }
  }
}

function pushScriptDiagnostics(
  analysis: SourceAnalysis,
  scripts: Record<string, string>,
  fallbackFile: string,
  origins?: Map<string, string>,
): void {
  for (const validation of validateCraftbookScripts(scripts)) {
    const file = origins?.get(validation.name) ?? fallbackFile;
    for (const diagnostic of validation.diagnostics) {
      analysis.findings.push({
        severity: diagnostic.severity === 'error' ? 'error' : 'warn',
        file,
        pointer: origins?.has(validation.name) ? '' : `/scripts/${validation.name}`,
        rule: 'script-diagnostic',
        message: `${validation.name}: ${diagnostic.message}`,
      });
    }
  }
}

function checkCraftbookDocs(analysis: SourceAnalysis): void {
  const docs: Array<[id: string, doc: CraftbookDoc, file: string]> = [];
  for (const [id, doc] of analysis.craftbookDocs) {
    docs.push([
      id,
      doc,
      `items/${GEZAPP_KIND_DIR['craftbook-template']}/${id.slice(0, 2).toLowerCase()}/${id}/versions/${
        analysis.items.find((item) => item.kind === 'craftbook-template' && item.id === id)?.version
      }/craftbook.json`,
    ]);
  }
  if (analysis.entryItem?.selectedVersion) {
    for (const [id, doc] of analysis.embeddedCraftbooks) {
      docs.push([
        id,
        doc,
        `${analysis.entryItem.dir}/versions/${analysis.entryItem.selectedVersion}/craftbooks/${id}.json`,
      ]);
    }
  }
  for (const [id, doc, file] of docs) {
    const converted = craftbookFromDoc(doc, { id, now: PLACEHOLDER_CREATED_AT });
    if (!converted.ok) {
      analysis.findings.push({
        severity: 'error',
        file,
        pointer: '',
        rule: 'invalid-craftbook',
        message: formatCraftbookDocErrors(converted.errors),
      });
    }
    if (doc.scripts) pushScriptDiagnostics(analysis, doc.scripts, file);
  }

  for (const [id, raw] of analysis.testSpecs) {
    const item = analysis.items.find(
      (candidate) => candidate.kind === 'craftbook-template' && candidate.id === id,
    );
    const file = `items/${GEZAPP_KIND_DIR['craftbook-template']}/${id.slice(0, 2).toLowerCase()}/${id}/versions/${item?.version}/test.json`;
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      analysis.findings.push({
        severity: 'warn',
        file,
        pointer: '',
        rule: 'test-spec-schema',
        message: `not valid JSON: ${errorMessage(err)}`,
      });
      continue;
    }
    const spec = parseCraftbookTestSpec(parsedRaw);
    if (!spec.ok) {
      analysis.findings.push({
        severity: 'warn',
        file,
        pointer: '',
        rule: 'test-spec-schema',
        message: spec.errors.join('; '),
      });
    }
  }
  for (const [id] of analysis.craftbookDocs) {
    if (!analysis.testSpecs.has(id)) {
      analysis.findings.push({
        severity: 'warn',
        file: `items/${GEZAPP_KIND_DIR['craftbook-template']}/${id.slice(0, 2).toLowerCase()}/${id}`,
        pointer: '',
        rule: 'missing-test-spec',
        message:
          'no test.json eval sidecar — the craftbook cannot be regression-checked (advisory for private apps)',
      });
    }
  }
}

const PAGE_LEGACY_MARKERS = [
  '__gezelPageInvoke',
  '__gezelPageResult',
  '__gezelPageRefresh',
  'gezelPage = (function',
];

function stripDarkMediaBlocks(html: string): string {
  let out = html;
  for (;;) {
    const match = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/i.exec(out);
    if (!match) return out;
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < out.length && depth > 0) {
      const char = out[index];
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      index += 1;
    }
    out = out.slice(0, match.index) + out.slice(index);
  }
}

function checkPages(analysis: SourceAnalysis): void {
  const manifest = analysis.entryVersionManifest;
  const entryItem = analysis.entryItem;
  if (!manifest?.pages || !entryItem?.selectedVersion) return;
  const pagesPrefix = `${entryItem.dir}/versions/${entryItem.selectedVersion}/pages/`;
  const entryPath = `${pagesPrefix}${manifest.pages.entry}`;
  const entryBytes = analysis.files.get(entryPath);
  if (!entryBytes) return; // missing-referenced-file already reported

  const html = entryBytes.toString('utf8');
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const body = match[2] ?? '';
    if (!body.trim()) continue;
    try {
      new VmScript(body, { filename: entryPath });
    } catch (err) {
      analysis.findings.push({
        severity: 'error',
        file: entryPath,
        pointer: '',
        rule: 'page-script-syntax',
        message: `inline <script> does not parse: ${errorMessage(err)}`,
      });
    }
  }
  for (const [path, content] of analysis.files) {
    if (!path.startsWith(pagesPrefix) || !path.endsWith('.js')) continue;
    try {
      new VmScript(content.toString('utf8'), { filename: path });
    } catch (err) {
      analysis.findings.push({
        severity: 'error',
        file: path,
        pointer: '',
        rule: 'page-script-syntax',
        message: `script does not parse: ${errorMessage(err)}`,
      });
    }
  }

  if (manifest.pages.api === 1) {
    for (const marker of PAGE_LEGACY_MARKERS) {
      if (html.includes(marker)) {
        analysis.findings.push({
          severity: 'error',
          file: entryPath,
          pointer: '',
          rule: 'page-legacy-wire',
          message: `page declares api 1 but still carries the v0 wire marker "${marker}" — code against window.gezel instead`,
        });
      }
    }
  }

  if (!/prefers-color-scheme\s*:\s*dark/i.test(html)) {
    analysis.findings.push({
      severity: 'warn',
      file: entryPath,
      pointer: '',
      rule: 'page-theme-contract',
      message: 'no "@media (prefers-color-scheme: dark)" block — the page will ignore dark mode',
    });
  }
  if (!/color-scheme\s*:\s*light\s+dark/i.test(html)) {
    analysis.findings.push({
      severity: 'warn',
      file: entryPath,
      pointer: '',
      rule: 'page-theme-contract',
      message:
        'declare "color-scheme: light dark" so form controls and scrollbars follow the theme',
    });
  }
  const lightOnly = stripDarkMediaBlocks(html);
  if (/\b(?:background|background-color|color)\s*:\s*(?:#fff(?:fff)?\b|white\b)/i.test(lightOnly)) {
    analysis.findings.push({
      severity: 'warn',
      file: entryPath,
      pointer: '',
      rule: 'page-hardcoded-color',
      message:
        'hardcoded white background/color outside the dark block — drive it through a CSS variable that the dark block overrides',
    });
  }
}

interface ValidatedSource {
  analysis: SourceAnalysis;
  manifest: GezappManifest | null;
  dependencies: GezappDependency[];
}

async function validateAnalyzedSource(
  dir: string,
  opts?: GezappSourceOptions & { createdAt?: string; publisher?: { name: string; url?: string } },
): Promise<ValidatedSource> {
  const analysis = await analyzeGezappSource(dir, opts);
  if (!analysis.entry || !analysis.entryItem?.identity || !analysis.entryVersionManifest) {
    return { analysis, manifest: null, dependencies: [] };
  }

  const catalog = opts?.catalog ?? new CatalogService();
  const lock = await resolveGezappDependencyLock(catalog, lockInputsFrom(analysis));
  for (const problem of lock.problems) {
    analysis.findings.push({
      severity: 'error',
      file: '',
      pointer: '',
      rule: 'dependency-lock',
      message: problem,
    });
  }

  const manifest = synthesizeManifest(analysis, lock.dependencies, {
    createdAt: opts?.createdAt ?? PLACEHOLDER_CREATED_AT,
    ...(opts?.publisher ? { publisher: opts.publisher } : {}),
  });
  if (manifest) {
    const verify = verifyGezapp({
      manifest,
      files: analysis.files,
      packageSha256: '0'.repeat(64),
    });
    for (const error of verify.errors) {
      analysis.findings.push({
        severity: 'error',
        file: '',
        pointer: '',
        rule: 'package-verify',
        message: error,
      });
    }
  }

  checkReferencedFiles(analysis);
  checkComposition(analysis);
  if (analysis.entryVersionManifest.scripts) {
    pushScriptDiagnostics(
      analysis,
      analysis.entryVersionManifest.scripts,
      `${analysis.entryItem.dir}/versions/${analysis.entryItem.selectedVersion}/manifest.json`,
      analysis.scriptOrigins,
    );
  }
  checkCraftbookDocs(analysis);
  checkPages(analysis);

  if (manifest) {
    const missing = await missingGezappDependencies(catalog, manifest.dependencies);
    for (const dependency of missing) {
      analysis.findings.push({
        severity: 'warn',
        file: '',
        pointer: '',
        rule: 'dependency-unavailable-locally',
        message: `${dependency.kind} ${dependency.id}@${dependency.version} does not resolve from this machine's catalog — install will require it${dependency.required ? '' : ' (optional)'}`,
      });
    }
  }

  return { analysis, manifest, dependencies: lock.dependencies };
}

/** Walk an app source folder into its package view without judging it. */
export async function assembleGezappSource(
  dir: string,
  opts?: GezappSourceOptions,
): Promise<AssembledGezappSource> {
  const analysis = await analyzeGezappSource(dir, opts);
  return {
    sourceManifest: analysis.sourceManifest,
    entry: analysis.entry,
    files: analysis.files,
    items: analysis.items,
    findings: analysis.findings,
  };
}

/** Validate an app source folder. Collect-all; never throws on content. */
export async function validateGezappSource(
  dir: string,
  opts?: GezappSourceOptions,
): Promise<ValidateGezappSourceResult> {
  const { analysis, manifest } = await validateAnalyzedSource(dir, opts);
  return {
    ok: !analysis.findings.some((finding) => finding.severity === 'error'),
    findings: analysis.findings,
    manifest,
  };
}

/**
 * Validate then pack an app source folder into `.gezapp` bytes. Throws
 * `GezappSourceError` (carrying the full findings list) when any
 * error-severity finding exists.
 */
export async function packGezappFromSource(
  dir: string,
  opts?: GezappSourceOptions & {
    createdAt?: string;
    publisher?: { name: string; url?: string };
  },
): Promise<PackGezappFromSourceResult> {
  const createdAt = opts?.createdAt ?? new Date().toISOString();
  const { analysis, manifest } = await validateAnalyzedSource(dir, { ...opts, createdAt });
  if (analysis.findings.some((finding) => finding.severity === 'error') || !manifest) {
    throw new GezappSourceError(analysis.findings);
  }
  return {
    buffer: buildGezappArchive(analysis.files, manifest),
    manifest,
    findings: analysis.findings,
  };
}
