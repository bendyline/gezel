import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CatalogItemIdentitySchema,
  type CraftbookDoc,
  CraftbookTemplateVersionManifestSchema,
  GEZEL_CONTENT_COMPAT,
  type GezappDependency,
  type GezappEmbeddedKind,
  type GezappInstallReceipt,
  GezappInstallReceiptSchema,
  type GezappItem,
  type GezappManifest,
  GezappManifestSchema,
  type GezappRegistry,
  type GezappRegistryEntry,
  GezappRegistrySchema,
  GezelTemplateVersionManifestSchema,
  ProjectTypeVersionManifestSchema,
  compareSemver,
  createLogger,
  formatCraftbookDocErrors,
  maxMinGezelVersion,
  parseCraftbookDoc,
  satisfiesMinGezelVersion,
} from '@bendyline/gezel';
import type { CatalogItemDetail } from '@bendyline/gezel';
import { BundledSource, type CatalogService } from '@bendyline/gezel-catalog';
import {
  aiAppReceiptFile,
  aiAppVersionDir,
  aiAppsRegistryFile,
  aiAppsRoot,
} from '@bendyline/gezel/paths';
import AdmZip from 'adm-zip';
import { writeFileAtomic } from '../fs/atomic.js';
import { isReservedWindowsName, safeJoin } from '../fs/safe-paths.js';

const log = createLogger('gezapp');
let installQueue: Promise<void> = Promise.resolve();

async function withGezappInstallLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = installQueue;
  let release!: () => void;
  installQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export const GEZAPP_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const GEZAPP_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const GEZAPP_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const GEZAPP_MAX_FILES = 4_096;

const KIND_DIR: Record<GezappEmbeddedKind, string> = {
  'project-type': 'project-types',
  'gezel-template': 'gezel-templates',
  'craftbook-template': 'craftbook-templates',
};

function shard(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

function itemPath(item: Pick<GezappItem, 'kind' | 'id'>): string {
  return `${KIND_DIR[item.kind]}/${shard(item.id)}/${item.id}`;
}

function packageItemPrefix(item: Pick<GezappItem, 'kind' | 'id'>): string {
  return `items/${itemPath(item)}/`;
}

function hashItemFiles(files: Array<{ rel: string; content: Buffer }>): string {
  const hash = createHash('sha256');
  for (const { rel, content } of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

function packageSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function exactVersionFile(rel: string, version: string): boolean {
  return !rel.startsWith('versions/') || rel.startsWith(`versions/${version}/`);
}

function isSafeArchivePath(path: string): boolean {
  if (
    !path ||
    path.length > 1_024 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path)
  ) {
    return false;
  }
  const parts = path.split('/');
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      !part.includes(':') &&
      !/[ .]$/.test(part) &&
      !isReservedWindowsName(part),
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PackageTarget {
  kind: GezappEmbeddedKind;
  id: string;
  version: string;
  sourceId: string;
  detail: CatalogItemDetail;
}

async function getReferencedItem(
  catalog: CatalogService,
  kind: GezappEmbeddedKind,
  id: string,
  preferredSourceId?: string,
): Promise<CatalogItemDetail | null> {
  if (preferredSourceId) {
    const sameSource = await catalog.get(kind, id, preferredSourceId);
    if (sameSource) return sameSource;
  }
  return catalog.get(kind, id);
}

async function collectTargetFiles(
  catalog: CatalogService,
  target: PackageTarget,
): Promise<Array<{ rel: string; content: Buffer }>> {
  const rels = await catalog.listItemFiles(target.kind, target.id, target.sourceId);
  const selected = rels.filter((rel) => exactVersionFile(rel, target.version));
  const files: Array<{ rel: string; content: Buffer }> = [];
  for (const rel of selected) {
    const content = await catalog.readItemFile(target.kind, target.id, rel, target.sourceId);
    if (content) files.push({ rel, content });
  }
  if (!files.some((file) => file.rel === 'manifest.json')) {
    throw new Error(`${target.kind} ${target.id} has no readable identity manifest`);
  }
  if (!files.some((file) => file.rel.startsWith(`versions/${target.version}/`))) {
    throw new Error(
      `${target.kind} ${target.id}@${target.version} has no readable version payload`,
    );
  }
  return files;
}

async function resolveExternalDependency(
  catalog: CatalogService,
  input: Omit<GezappDependency, 'version'> & { minVersion?: string },
): Promise<GezappDependency | null> {
  const preferred = input.sourceId ? await catalog.get(input.kind, input.id, input.sourceId) : null;
  const detail = preferred ?? (await catalog.get(input.kind, input.id));
  if (!detail) {
    if (input.required) throw new Error(`required ${input.kind} dependency ${input.id} not found`);
    return null;
  }
  if (
    input.minVersion &&
    /^\d+\.\d+\.\d+/.test(detail.manifest.version) &&
    compareSemver(detail.manifest.version, input.minVersion) < 0
  ) {
    throw new Error(
      `${input.kind} dependency ${input.id}@${detail.manifest.version} is below required ${input.minVersion}`,
    );
  }
  return {
    kind: input.kind,
    id: input.id,
    version: detail.manifest.version,
    required: input.required,
    sourceId: detail.sourceId,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function mergeDependency(
  dependencies: Map<string, GezappDependency>,
  dependency: GezappDependency | null,
): void {
  if (!dependency) return;
  const key = `${dependency.kind}:${dependency.id}`;
  const existing = dependencies.get(key);
  if (existing && existing.version !== dependency.version) {
    throw new Error(
      `dependency ${key} resolved to conflicting versions ${existing.version} and ${dependency.version}`,
    );
  }
  dependencies.set(key, {
    ...(existing ?? dependency),
    required: Boolean(existing?.required || dependency.required),
    ...(existing?.reason || dependency.reason
      ? { reason: existing?.reason ?? dependency.reason }
      : {}),
  });
}

// Internal helpers shared with the source-folder authoring module
// (`gezapp-source.ts`); renamed on export so their scope stays clear.
export {
  KIND_DIR as GEZAPP_KIND_DIR,
  hashItemFiles as hashGezappItemFiles,
  isSafeArchivePath as isSafeGezappArchivePath,
  itemPath as gezappItemPath,
};

export interface GezappDependencyLockInputs {
  /** The entry project type's toolset references. */
  typeToolsets: Array<{
    id: string;
    need: 'required' | 'suggested';
    sourceId?: string;
    reason?: string;
  }>;
  /** Embedded gezel-template payloads (suggested tools/model become optional locks). */
  roles: Array<{ id: string; suggestedTools: string[]; suggestedModel?: string }>;
  /** Embedded craftbook payloads — template items and type-private docs alike. */
  craftbooks: Array<{
    id: string;
    toolsets?: Array<{
      toolsetId: string;
      optional?: boolean;
      sourceId?: string;
      minVersion?: string;
      reason?: string;
    }>;
    connectors?: Array<{ typeId: string; optional?: boolean; sourceId?: string; reason?: string }>;
  }>;
}

/**
 * Resolve the exact external dependency lock for a package's contents.
 * Collects problems (a required dependency missing from the catalog, a
 * version conflict, a semver floor violation) instead of throwing so the
 * source-folder validator can report all of them; `packGezapp` keeps its
 * historical throw-on-first behavior on top.
 */
export async function resolveGezappDependencyLock(
  catalog: CatalogService,
  inputs: GezappDependencyLockInputs,
): Promise<{ dependencies: GezappDependency[]; problems: string[] }> {
  const dependencies = new Map<string, GezappDependency>();
  const problems: string[] = [];
  const add = async (
    input: Omit<GezappDependency, 'version'> & { minVersion?: string },
  ): Promise<void> => {
    try {
      mergeDependency(dependencies, await resolveExternalDependency(catalog, input));
    } catch (err) {
      problems.push(errorMessage(err));
    }
  };
  for (const ref of inputs.typeToolsets) {
    await add({
      kind: 'toolset',
      id: ref.id,
      required: ref.need === 'required',
      ...(ref.sourceId ? { sourceId: ref.sourceId } : {}),
      ...(ref.reason ? { reason: ref.reason } : {}),
    });
  }
  for (const role of inputs.roles) {
    for (const id of role.suggestedTools) {
      await add({ kind: 'toolset', id, required: false, reason: `Suggested by role ${role.id}` });
    }
    if (role.suggestedModel) {
      await add({
        kind: 'chat-model',
        id: role.suggestedModel,
        required: false,
        reason: `Suggested by role ${role.id}`,
      });
    }
  }
  for (const craftbook of inputs.craftbooks) {
    for (const ref of craftbook.toolsets ?? []) {
      await add({
        kind: 'toolset',
        id: ref.toolsetId,
        required: !ref.optional,
        ...(ref.sourceId ? { sourceId: ref.sourceId } : {}),
        ...(ref.minVersion ? { minVersion: ref.minVersion } : {}),
        ...(ref.reason ? { reason: ref.reason } : {}),
      });
    }
    for (const ref of craftbook.connectors ?? []) {
      await add({
        kind: 'connector-type',
        id: ref.typeId,
        required: !ref.optional,
        ...(ref.sourceId ? { sourceId: ref.sourceId } : {}),
        ...(ref.reason ? { reason: ref.reason } : {}),
      });
    }
  }
  return {
    dependencies: [...dependencies.values()].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    ),
    problems,
  };
}

export interface PackGezappResult {
  buffer: Buffer;
  manifest: GezappManifest;
}

/**
 * Assemble the final `.gezapp` bytes from package-relative item files
 * (`items/…`) plus the root manifest, enforcing the archive safety rules
 * and quotas shared with `readGezapp`.
 */
export function buildGezappArchive(
  files: ReadonlyMap<string, Buffer>,
  manifest: GezappManifest,
): Buffer {
  const zip = new AdmZip();
  const archiveNames = new Set<string>();
  let expandedBytes = 0;
  const addArchiveFile = (path: string, content: Buffer): void => {
    if (!isSafeArchivePath(path)) throw new Error(`unsafe catalog path for .gezapp: ${path}`);
    const portableName = path.toLowerCase();
    if (archiveNames.has(portableName)) {
      throw new Error(`duplicate or case-colliding .gezapp file: ${path}`);
    }
    if (content.length > GEZAPP_MAX_FILE_BYTES) {
      throw new Error(`${path} exceeds ${GEZAPP_MAX_FILE_BYTES} byte file limit`);
    }
    if (archiveNames.size + 1 > GEZAPP_MAX_FILES) {
      throw new Error(`.gezapp exceeds ${GEZAPP_MAX_FILES} file limit`);
    }
    expandedBytes += content.length;
    if (expandedBytes > GEZAPP_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`.gezapp exceeds ${GEZAPP_MAX_UNCOMPRESSED_BYTES} byte expanded limit`);
    }
    archiveNames.add(portableName);
    zip.addFile(path, content);
  };
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    addArchiveFile(path, content);
  }
  addArchiveFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const buffer = zip.toBuffer();
  if (buffer.length > GEZAPP_MAX_ARCHIVE_BYTES) {
    throw new Error(`.gezapp exceeds ${GEZAPP_MAX_ARCHIVE_BYTES} byte archive limit`);
  }
  return buffer;
}

/** Build one exact-version AI App package from a catalog project type. */
export async function packGezapp(
  deps: { catalog: CatalogService },
  opts: {
    typeId: string;
    version?: string;
    publisher?: { name: string; url?: string };
    createdAt?: string;
    exportedFromProject?: string;
  },
): Promise<PackGezappResult> {
  const typeDetail = await deps.catalog.get('project-type', opts.typeId, undefined, opts.version);
  if (!typeDetail || typeDetail.manifest.kind !== 'project-type') {
    throw new Error(
      `project type ${opts.typeId}${opts.version ? `@${opts.version}` : ''} not found`,
    );
  }

  const targets = new Map<string, PackageTarget>();
  const addTarget = (detail: CatalogItemDetail): void => {
    if (
      detail.manifest.kind !== 'project-type' &&
      detail.manifest.kind !== 'gezel-template' &&
      detail.manifest.kind !== 'craftbook-template'
    ) {
      throw new Error(`cannot embed catalog kind ${detail.manifest.kind}`);
    }
    const key = `${detail.manifest.kind}:${detail.manifest.id}`;
    const existing = targets.get(key);
    if (existing && existing.version !== detail.manifest.version) {
      throw new Error(
        `embedded item ${key} resolved to conflicting versions ${existing.version} and ${detail.manifest.version}`,
      );
    }
    targets.set(key, {
      kind: detail.manifest.kind,
      id: detail.manifest.id,
      version: detail.manifest.version,
      sourceId: detail.sourceId,
      detail,
    });
  };
  addTarget(typeDetail);

  for (const ref of typeDetail.manifest.gezels) {
    const detail = await getReferencedItem(
      deps.catalog,
      'gezel-template',
      ref.templateId,
      typeDetail.sourceId,
    );
    if (!detail || detail.manifest.kind !== 'gezel-template') {
      throw new Error(`gezel template ${ref.templateId} referenced by ${opts.typeId} not found`);
    }
    addTarget(detail);
  }

  for (const id of typeDetail.manifest.craftbooks) {
    const embedded = await deps.catalog.readItemFile(
      'project-type',
      opts.typeId,
      `craftbooks/${id}.json`,
      typeDetail.sourceId,
      typeDetail.manifest.version,
    );
    if (embedded) continue;
    const detail = await getReferencedItem(
      deps.catalog,
      'craftbook-template',
      id,
      typeDetail.sourceId,
    );
    if (!detail || detail.manifest.kind !== 'craftbook-template') {
      throw new Error(
        `craftbook ${id} referenced by ${opts.typeId} is neither embedded nor cataloged`,
      );
    }
    addTarget(detail);
  }

  const lockInputs: GezappDependencyLockInputs = {
    typeToolsets: typeDetail.manifest.toolsets,
    roles: [],
    craftbooks: [],
  };
  for (const target of targets.values()) {
    if (target.detail.manifest.kind === 'gezel-template') {
      lockInputs.roles.push({
        id: target.id,
        suggestedTools: target.detail.manifest.suggestedTools,
        ...(target.detail.manifest.suggestedModel
          ? { suggestedModel: target.detail.manifest.suggestedModel }
          : {}),
      });
    }
    if (target.detail.manifest.kind === 'craftbook-template') {
      lockInputs.craftbooks.push({
        id: target.id,
        ...(target.detail.manifest.toolsets ? { toolsets: target.detail.manifest.toolsets } : {}),
        ...(target.detail.manifest.connectors
          ? { connectors: target.detail.manifest.connectors }
          : {}),
      });
    }
  }
  const lock = await resolveGezappDependencyLock(deps.catalog, lockInputs);
  if (lock.problems.length > 0) throw new Error(lock.problems[0]);

  const files = new Map<string, Buffer>();
  const items: GezappItem[] = [];
  let minGezelVersion: string | undefined;
  for (const target of targets.values()) {
    const collected = await collectTargetFiles(deps.catalog, target);
    for (const file of collected) {
      files.set(`items/${itemPath(target)}/${file.rel}`, file.content);
    }
    items.push({
      kind: target.kind,
      id: target.id,
      version: target.version,
      sha256: hashItemFiles(collected),
    });
    minGezelVersion = maxMinGezelVersion(minGezelVersion, target.detail.manifest.minGezelVersion);
  }

  const manifest = GezappManifestSchema.parse({
    format: 'gezel-ai-app',
    schemaVersion: 1,
    entry: { projectType: typeDetail.manifest.id, version: typeDetail.manifest.version },
    name: typeDetail.manifest.name,
    description: typeDetail.manifest.description,
    publisher: opts.publisher ?? typeDetail.manifest.maintainer,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(minGezelVersion ? { minGezelVersion } : {}),
    signature: { status: 'unsigned' },
    items,
    dependencies: lock.dependencies,
    provenance: {
      source: typeDetail.sourceId,
      ...(opts.exportedFromProject ? { exportedFromProject: opts.exportedFromProject } : {}),
    },
  });
  return { buffer: buildGezappArchive(files, manifest), manifest };
}

export interface ReadGezappResult {
  manifest: GezappManifest;
  /** Package-relative path (`items/…`) to file content. */
  files: Map<string, Buffer>;
  packageSha256: string;
}

/** Parse and quota-check a `.gezapp`; no filesystem writes occur. */
export function readGezapp(buffer: Buffer): ReadGezappResult {
  if (buffer.length > GEZAPP_MAX_ARCHIVE_BYTES) {
    throw new Error(`.gezapp exceeds ${GEZAPP_MAX_ARCHIVE_BYTES} byte archive limit`);
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`not a readable .gezapp (zip) file: ${errorMessage(err)}`);
  }
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  if (entries.length > GEZAPP_MAX_FILES) {
    throw new Error(`.gezapp exceeds ${GEZAPP_MAX_FILES} file limit`);
  }
  const names = new Set<string>();
  const contents = new Map<string, Buffer>();
  let declaredTotal = 0;
  let expandedTotal = 0;
  for (const entry of entries) {
    if (!isSafeArchivePath(entry.entryName)) {
      throw new Error(`unsafe file path in .gezapp: ${entry.entryName}`);
    }
    const portableName = entry.entryName.toLowerCase();
    if (names.has(portableName)) {
      throw new Error(`duplicate or case-colliding file in .gezapp: ${entry.entryName}`);
    }
    names.add(portableName);
    const size = entry.header.size;
    if (size > GEZAPP_MAX_FILE_BYTES) {
      throw new Error(`${entry.entryName} exceeds ${GEZAPP_MAX_FILE_BYTES} byte file limit`);
    }
    declaredTotal += size;
    if (declaredTotal > GEZAPP_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`.gezapp exceeds ${GEZAPP_MAX_UNCOMPRESSED_BYTES} byte expanded limit`);
    }
    if (entry.entryName !== 'manifest.json' && !entry.entryName.startsWith('items/')) {
      throw new Error(`unsupported top-level file in .gezapp: ${entry.entryName}`);
    }
    let content: Buffer;
    try {
      content = entry.getData();
    } catch (err) {
      throw new Error(`cannot expand ${entry.entryName}: ${errorMessage(err)}`);
    }
    if (content.length !== size) {
      throw new Error(`${entry.entryName} expanded size does not match its ZIP header`);
    }
    expandedTotal += content.length;
    if (expandedTotal > GEZAPP_MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`.gezapp exceeds ${GEZAPP_MAX_UNCOMPRESSED_BYTES} byte expanded limit`);
    }
    contents.set(entry.entryName, content);
  }
  const manifestBytes = contents.get('manifest.json');
  if (!manifestBytes) throw new Error('not a .gezapp package — no root manifest.json');
  let manifest: GezappManifest;
  try {
    manifest = GezappManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  } catch (err) {
    throw new Error(`invalid .gezapp manifest: ${errorMessage(err)}`);
  }
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const content = contents.get(entry.entryName);
    if (entry.entryName.startsWith('items/') && content) files.set(entry.entryName, content);
  }
  return { manifest, files, packageSha256: packageSha256(buffer) };
}

type ParsedItemPayload =
  | { kind: 'project-type'; value: ReturnType<typeof ProjectTypeVersionManifestSchema.parse> }
  | { kind: 'gezel-template'; value: ReturnType<typeof GezelTemplateVersionManifestSchema.parse> }
  | {
      kind: 'craftbook-template';
      value: ReturnType<typeof CraftbookTemplateVersionManifestSchema.parse> | CraftbookDoc;
    };

export interface VerifyGezappResult {
  ok: boolean;
  errors: string[];
}

function parseItemPayload(
  item: GezappItem,
  collected: Array<{ rel: string; content: Buffer }>,
): ParsedItemPayload {
  const identityFile = collected.find((file) => file.rel === 'manifest.json');
  if (!identityFile) throw new Error(`${item.kind}/${item.id} has no identity manifest`);
  const identity = CatalogItemIdentitySchema.parse(
    JSON.parse(identityFile.content.toString('utf8')),
  );
  if (identity.kind !== item.kind || identity.id !== item.id) {
    throw new Error(`${item.kind}/${item.id} identity declares ${identity.kind}/${identity.id}`);
  }
  const versionPrefix = `versions/${item.version}/`;
  if (item.kind === 'craftbook-template') {
    const docFile = collected.find((file) => file.rel === `${versionPrefix}craftbook.json`);
    if (docFile) {
      const parsed = parseCraftbookDoc(docFile.content.toString('utf8'), 'json');
      if (!parsed.ok) {
        throw new Error(
          `${item.kind}/${item.id}@${item.version}: ${formatCraftbookDocErrors(parsed.errors)}`,
        );
      }
      if (parsed.doc.id && parsed.doc.id !== item.id) {
        throw new Error(`craftbook document id ${parsed.doc.id} does not match ${item.id}`);
      }
      if (parsed.doc.version !== item.version) {
        throw new Error(
          `craftbook document version ${parsed.doc.version ?? '(missing)'} does not match ${item.version}`,
        );
      }
      return { kind: item.kind, value: parsed.doc };
    }
    const legacy = collected.find((file) => file.rel === `${versionPrefix}manifest.json`);
    if (!legacy) throw new Error(`${item.kind}/${item.id}@${item.version} has no version payload`);
    const value = CraftbookTemplateVersionManifestSchema.parse(
      JSON.parse(legacy.content.toString('utf8')),
    );
    if (value.version !== item.version) throw new Error(`version payload mismatch for ${item.id}`);
    return { kind: item.kind, value };
  }
  const versionFile = collected.find((file) => file.rel === `${versionPrefix}manifest.json`);
  if (!versionFile)
    throw new Error(`${item.kind}/${item.id}@${item.version} has no version manifest`);
  const raw = JSON.parse(versionFile.content.toString('utf8'));
  if (item.kind === 'project-type') {
    const value = ProjectTypeVersionManifestSchema.parse(raw);
    if (value.version !== item.version) throw new Error(`version payload mismatch for ${item.id}`);
    return { kind: item.kind, value };
  }
  const value = GezelTemplateVersionManifestSchema.parse(raw);
  if (value.version !== item.version) throw new Error(`version payload mismatch for ${item.id}`);
  return { kind: item.kind, value };
}

/** Verify hashes, exact paths, inner schemas, the entry, and dependency closure. */
export function verifyGezapp(result: ReadGezappResult): VerifyGezappResult {
  const errors: string[] = [];
  const claimed = new Set<string>();
  const payloads = new Map<string, ParsedItemPayload>();
  for (const item of result.manifest.items) {
    const prefix = packageItemPrefix(item);
    const collected: Array<{ rel: string; content: Buffer }> = [];
    for (const [path, content] of result.files) {
      if (!path.startsWith(prefix)) continue;
      const rel = path.slice(prefix.length);
      if (!exactVersionFile(rel, item.version)) {
        errors.push(`${item.kind}/${item.id} contains an undeclared version file: ${rel}`);
        continue;
      }
      claimed.add(path);
      collected.push({ rel, content });
    }
    if (collected.length === 0) {
      errors.push(`${item.kind}/${item.id} has no files in the package`);
      continue;
    }
    if (hashItemFiles(collected) !== item.sha256) {
      errors.push(`sha256 mismatch for ${item.kind}/${item.id}`);
      continue;
    }
    try {
      payloads.set(`${item.kind}:${item.id}`, parseItemPayload(item, collected));
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  for (const path of result.files.keys()) {
    if (!claimed.has(path)) errors.push(`unclaimed file in package: ${path}`);
  }

  const entryIdentityPath = `${packageItemPrefix({ kind: 'project-type', id: result.manifest.entry.projectType })}manifest.json`;
  try {
    const identityBytes = result.files.get(entryIdentityPath);
    if (!identityBytes) throw new Error('entry project type identity is missing');
    const identity = CatalogItemIdentitySchema.parse(JSON.parse(identityBytes.toString('utf8')));
    if (identity.kind !== 'project-type') throw new Error('entry identity is not a project type');
    if (
      identity.name !== result.manifest.name ||
      identity.description !== result.manifest.description
    ) {
      errors.push('package name/description do not match the entry project type identity');
    }
  } catch (err) {
    errors.push(errorMessage(err));
  }

  const project = payloads.get(`project-type:${result.manifest.entry.projectType}`);
  if (project?.kind === 'project-type') {
    for (const ref of project.value.gezels) {
      if (!payloads.has(`gezel-template:${ref.templateId}`)) {
        errors.push(`entry project type references missing gezel template ${ref.templateId}`);
      }
    }
    for (const id of project.value.craftbooks) {
      const embeddedPath = `${packageItemPrefix({ kind: 'project-type', id: result.manifest.entry.projectType })}versions/${result.manifest.entry.version}/craftbooks/${id}.json`;
      if (!result.files.has(embeddedPath) && !payloads.has(`craftbook-template:${id}`)) {
        errors.push(`entry project type references missing craftbook ${id}`);
      }
    }
    const dependencyKeys = new Set(
      result.manifest.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}`),
    );
    for (const ref of project.value.toolsets.filter((toolset) => toolset.need === 'required')) {
      if (!dependencyKeys.has(`toolset:${ref.id}`)) {
        errors.push(`required toolset ${ref.id} is absent from the dependency lock`);
      }
    }
  }

  const dependencyKeys = new Set(
    result.manifest.dependencies.map((dependency) => `${dependency.kind}:${dependency.id}`),
  );
  for (const payload of payloads.values()) {
    if (payload.kind !== 'craftbook-template') continue;
    for (const ref of payload.value.toolsets ?? []) {
      if (!ref.optional && !dependencyKeys.has(`toolset:${ref.toolsetId}`)) {
        errors.push(
          `required craftbook toolset ${ref.toolsetId} is absent from the dependency lock`,
        );
      }
    }
    for (const ref of payload.value.connectors ?? []) {
      if (!ref.optional && !dependencyKeys.has(`connector-type:${ref.typeId}`)) {
        errors.push(
          `required craftbook connector ${ref.typeId} is absent from the dependency lock`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface ImportGezappResult {
  manifest: GezappManifest;
  items: Array<{ kind: GezappEmbeddedKind; id: string; version: string }>;
  dependencies: GezappDependency[];
  missingDependencies: GezappDependency[];
  packageSha256: string;
  installed?: { appId: string; version: string; receiptPath: string; alreadyPresent: boolean };
}

async function readRegistry(home: string): Promise<GezappRegistry> {
  try {
    return GezappRegistrySchema.parse(JSON.parse(await readFile(aiAppsRegistryFile(home), 'utf8')));
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { schemaVersion: 1, apps: [] };
    }
    throw new Error(`AI App registry is unreadable: ${errorMessage(err)}`);
  }
}

/** Dependency locks that do not currently resolve from the catalog. */
export async function missingGezappDependencies(
  catalog: CatalogService,
  dependencies: GezappDependency[],
): Promise<GezappDependency[]> {
  const missing: GezappDependency[] = [];
  for (const dependency of dependencies) {
    const preferred = dependency.sourceId
      ? await catalog.get(dependency.kind, dependency.id, dependency.sourceId, dependency.version)
      : null;
    const detail =
      preferred ??
      (await catalog.get(dependency.kind, dependency.id, undefined, dependency.version));
    if (!detail) missing.push(dependency);
  }
  return missing;
}

async function assertNoInstalledItemConflict(
  home: string,
  registry: GezappRegistry,
  manifest: GezappManifest,
): Promise<void> {
  for (const installed of registry.apps.filter((entry) => entry.enabled)) {
    // Installing another version of the same app replaces its active mount.
    // The prior version stays on disk for rollback, but it cannot conflict
    // with the package that is about to supersede it.
    if (installed.appId === manifest.entry.projectType) continue;
    let receipt: GezappInstallReceipt;
    try {
      receipt = GezappInstallReceiptSchema.parse(
        JSON.parse(
          await readFile(aiAppReceiptFile(home, installed.appId, installed.version), 'utf8'),
        ),
      );
    } catch {
      throw new Error(
        `installed AI App ${installed.appId}@${installed.version} has no readable receipt`,
      );
    }
    for (const item of manifest.items) {
      const other = receipt.manifest.items.find(
        (candidate) => candidate.kind === item.kind && candidate.id === item.id,
      );
      if (other && (other.version !== item.version || other.sha256 !== item.sha256)) {
        throw new Error(
          `${item.kind} ${item.id} conflicts with installed AI App ${installed.appId}@${installed.version}`,
        );
      }
    }
  }
}

async function assertNoCatalogItemConflict(
  catalog: CatalogService,
  manifest: GezappManifest,
): Promise<void> {
  for (const item of manifest.items) {
    for (const source of catalog.listSources()) {
      // Active installed apps are checked by receipt above. Skipping the
      // aggregate source also lets a private app advance its own version.
      if (source.id === 'installed-ai-apps') continue;
      const existing = await catalog.get(item.kind, item.id, source.id);
      if (!existing) continue;
      if (existing.manifest.version !== item.version) {
        throw new Error(
          `${item.kind} ${item.id} conflicts with ${source.label} version ${existing.manifest.version}`,
        );
      }
      const files = await collectTargetFiles(catalog, {
        kind: item.kind,
        id: item.id,
        version: item.version,
        sourceId: existing.sourceId,
        detail: existing,
      });
      if (hashItemFiles(files) !== item.sha256) {
        throw new Error(
          `${item.kind} ${item.id}@${item.version} conflicts with ${source.label} content`,
        );
      }
    }
  }
}

async function validateStagedCatalog(root: string, manifest: GezappManifest): Promise<void> {
  const source = new BundledSource({ dataDir: join(root, 'items'), noIndex: true });
  for (const item of manifest.items) {
    const detail = await source.get(item.kind, item.id, item.version);
    if (!detail || detail.manifest.version !== item.version) {
      throw new Error(`staged ${item.kind} ${item.id}@${item.version} does not resolve`);
    }
  }
}

/** Preview or atomically install a `.gezapp` as one mounted catalog unit. */
export async function importGezapp(
  deps: { home: string; catalog: CatalogService; gezelVersion?: string },
  buffer: Buffer,
  opts: { confirm?: boolean } = {},
): Promise<ImportGezappResult> {
  const parsed = readGezapp(buffer);
  const verified = verifyGezapp(parsed);
  if (!verified.ok) throw new Error(`.gezapp failed verification: ${verified.errors.join('; ')}`);
  const currentVersion = deps.gezelVersion ?? GEZEL_CONTENT_COMPAT;
  if (
    parsed.manifest.minGezelVersion &&
    !satisfiesMinGezelVersion(parsed.manifest.minGezelVersion, currentVersion)
  ) {
    throw new Error(
      `.gezapp requires Gezel ${parsed.manifest.minGezelVersion} or newer (this build supports ${currentVersion})`,
    );
  }
  const missing = await missingGezappDependencies(deps.catalog, parsed.manifest.dependencies);
  const result: ImportGezappResult = {
    manifest: parsed.manifest,
    items: parsed.manifest.items.map(({ kind, id, version }) => ({ kind, id, version })),
    dependencies: parsed.manifest.dependencies,
    missingDependencies: missing,
    packageSha256: parsed.packageSha256,
  };
  if (!opts.confirm) return result;
  const requiredMissing = missing.filter((dependency) => dependency.required);
  if (requiredMissing.length > 0) {
    throw new Error(
      `required dependencies are unavailable: ${requiredMissing.map((d) => `${d.kind}:${d.id}@${d.version}`).join(', ')}`,
    );
  }

  return withGezappInstallLock(async () => {
    const appId = parsed.manifest.entry.projectType;
    const version = parsed.manifest.entry.version;
    const registry = await readRegistry(deps.home);
    await assertNoInstalledItemConflict(deps.home, registry, parsed.manifest);
    await assertNoCatalogItemConflict(deps.catalog, parsed.manifest);
    const target = aiAppVersionDir(deps.home, appId, version);
    const existingReceipt = await readFile(
      aiAppReceiptFile(deps.home, appId, version),
      'utf8',
    ).catch(() => null);
    if (existingReceipt) {
      const receipt = GezappInstallReceiptSchema.parse(JSON.parse(existingReceipt));
      if (receipt.packageSha256 !== parsed.packageSha256) {
        throw new Error(`AI App ${appId}@${version} is already installed with different bytes`);
      }
      const next: GezappRegistry = {
        schemaVersion: 1,
        apps: [
          ...registry.apps.filter((entry) => entry.appId !== appId),
          {
            appId,
            version,
            packageSha256: parsed.packageSha256,
            installedAt: receipt.installedAt,
            enabled: true,
          },
        ],
      };
      await mkdir(aiAppsRoot(deps.home), { recursive: true });
      await writeFileAtomic(aiAppsRegistryFile(deps.home), `${JSON.stringify(next, null, 2)}\n`);
      return {
        ...result,
        installed: {
          appId,
          version,
          receiptPath: aiAppReceiptFile(deps.home, appId, version),
          alreadyPresent: true,
        },
      };
    }
    if (await stat(target).catch(() => null)) {
      throw new Error(`AI App target exists without a valid receipt: ${target}`);
    }

    const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
    const installedAt = new Date().toISOString();
    try {
      await mkdir(join(staging, 'items'), { recursive: true });
      for (const [path, content] of parsed.files) {
        const destination = safeJoin(staging, path);
        if (!destination) throw new Error(`unsafe staged path: ${path}`);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      const receipt: GezappInstallReceipt = {
        schemaVersion: 1,
        manifest: parsed.manifest,
        packageSha256: parsed.packageSha256,
        installedAt,
      };
      await writeFile(join(staging, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
      await validateStagedCatalog(staging, parsed.manifest);
      await mkdir(dirname(target), { recursive: true });
      await rename(staging, target);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const next: GezappRegistry = {
      schemaVersion: 1,
      apps: [
        ...registry.apps.filter((entry) => entry.appId !== appId),
        {
          appId,
          version,
          packageSha256: parsed.packageSha256,
          installedAt,
          enabled: true,
        },
      ],
    };
    try {
      await writeFileAtomic(aiAppsRegistryFile(deps.home), `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      // The registry is the activation point. Roll back a newly published but
      // still-unmounted version if that activation cannot be committed.
      await rm(target, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    log.info(`[import] installed AI App ${appId}@${version}`);
    return {
      ...result,
      installed: {
        appId,
        version,
        receiptPath: aiAppReceiptFile(deps.home, appId, version),
        alreadyPresent: false,
      },
    };
  });
}

// ─ install-level management (list / enable / remove) ─────────────────────

export interface InstalledGezapp {
  entry: GezappRegistryEntry;
  /** Null when the receipt is unreadable — reported, never fatal. */
  receipt: GezappInstallReceipt | null;
  /** Version dirs on disk for this app, oldest first (rollback material). */
  versionsOnDisk: string[];
}

function bySemverTolerant(a: string, b: string): number {
  try {
    return compareSemver(a, b);
  } catch {
    return a.localeCompare(b);
  }
}

async function versionDirsOnDisk(home: string, appId: string): Promise<string[]> {
  const entries = await readdir(join(aiAppsRoot(home), appId), { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.includes('.staging-'))
    .map((entry) => entry.name)
    .sort(bySemverTolerant);
}

async function readReceipt(
  home: string,
  appId: string,
  version: string,
): Promise<GezappInstallReceipt | null> {
  try {
    return GezappInstallReceiptSchema.parse(
      JSON.parse(await readFile(aiAppReceiptFile(home, appId, version), 'utf8')),
    );
  } catch {
    return null;
  }
}

/** Every registered AI App with its receipt and on-disk version dirs. */
export async function listGezapps(home: string): Promise<InstalledGezapp[]> {
  const registry = await readRegistry(home);
  const result: InstalledGezapp[] = [];
  for (const entry of registry.apps) {
    result.push({
      entry,
      receipt: await readReceipt(home, entry.appId, entry.version),
      versionsOnDisk: await versionDirsOnDisk(home, entry.appId),
    });
  }
  return result.sort((a, b) => a.entry.appId.localeCompare(b.entry.appId));
}

/** Flip an installed app's enabled flag. Returns null when not installed. */
export async function setGezappEnabled(
  home: string,
  appId: string,
  enabled: boolean,
): Promise<GezappRegistryEntry | null> {
  return withGezappInstallLock(async () => {
    const registry = await readRegistry(home);
    const entry = registry.apps.find((candidate) => candidate.appId === appId);
    if (!entry) return null;
    if (entry.enabled !== enabled) {
      entry.enabled = enabled;
      await mkdir(aiAppsRoot(home), { recursive: true });
      await writeFileAtomic(aiAppsRegistryFile(home), `${JSON.stringify(registry, null, 2)}\n`);
      log.info(`[manage] ${enabled ? 'enabled' : 'disabled'} AI App ${appId}`);
    }
    return entry;
  });
}

export interface RemoveGezappResult {
  appId: string;
  removedVersions: string[];
  keptVersions: string[];
}

/**
 * Uninstall an AI App. The registry entry is dropped FIRST — the registry is
 * the activation point, so unmounting before touching bytes closes the window
 * where a catalog read could resolve a half-deleted version. Version-dir
 * deletion failures (e.g. Windows EBUSY under an open reader) are reported in
 * `keptVersions`, never fatal: a leftover dir with a valid receipt is
 * harmlessly re-adopted by a later import of the same bytes.
 */
export async function removeGezapp(
  home: string,
  appId: string,
  opts: { keepFiles?: boolean } = {},
): Promise<RemoveGezappResult | null> {
  return withGezappInstallLock(async () => {
    const registry = await readRegistry(home);
    if (!registry.apps.some((candidate) => candidate.appId === appId)) return null;
    const next: GezappRegistry = {
      schemaVersion: 1,
      apps: registry.apps.filter((candidate) => candidate.appId !== appId),
    };
    await mkdir(aiAppsRoot(home), { recursive: true });
    await writeFileAtomic(aiAppsRegistryFile(home), `${JSON.stringify(next, null, 2)}\n`);

    const versions = await versionDirsOnDisk(home, appId);
    const removedVersions: string[] = [];
    const keptVersions: string[] = [];
    if (opts.keepFiles) {
      keptVersions.push(...versions);
    } else {
      const appDir = join(aiAppsRoot(home), appId);
      for (const version of versions) {
        try {
          await rm(join(appDir, version), { recursive: true, force: true });
          removedVersions.push(version);
        } catch (err) {
          log.warn(`[manage] could not delete ${appId}@${version}: ${errorMessage(err)}`);
          keptVersions.push(version);
        }
      }
      if (keptVersions.length === 0)
        await rm(appDir, { recursive: true, force: true }).catch(() => {});
    }
    log.info(
      `[manage] uninstalled AI App ${appId} (removed ${removedVersions.length} version dir${removedVersions.length === 1 ? '' : 's'})`,
    );
    return { appId, removedVersions, keptVersions };
  });
}
