import { z } from 'zod';
import {
  backupEntryPrefix,
  backupSettingsTarget,
  isBackupDerivedPath,
  isBackupItemRequested,
  isBackupSettingsFileId,
} from '../backup-policy.js';
import { assertSafeEntityId } from '../entity-id.js';
import { parseGezelMarkdown, serializeGezelMarkdown } from '../markdown/gezel-md.js';
import { PoppetjeSchema } from '../poppetje/schema.js';
import { type GezelConfig, GezelConfigSchema } from '../schemas/api.js';
import { ProjectSchema } from '../schemas/project.js';
import { PromptDraftMetaSchema } from '../schemas/prompt-draft.js';
import { QuestionSchema } from '../schemas/question.js';
import { ScriptRunSchema } from '../schemas/script.js';
import { ChatSessionSchema } from '../schemas/session.js';
import {
  BACKUP_MANIFEST_KIND,
  BACKUP_SCHEMA_VERSION,
  type BackupManifest,
  BackupManifestSchema,
  type BackupPlan,
  type BackupRequest,
  type RestoreConfirm,
  RestoreConfirmSchema,
  type RestoreReview,
} from '../schemas/storage.js';
import { TaskSchema } from '../schemas/task.js';
import { projectManagedWorkspaceWritable } from '../security/policy.js';
import { isSharedLibraryProject } from '../shared-project.js';
import { PORTABLE_BACKUP_LIMITS, readBackupZip, writeBackupZip } from './backup-zip.js';
import { boundedText, decodeText } from './files.js';
import { listGezels } from './gezels.js';
import { validateMemoryDay } from './memories.js';
import { getProject, listProjects, readConfig, sharedProjectId } from './projects.js';
import type { PortableRepository } from './repository.js';

export type PortableBackupOptions = Pick<BackupRequest, 'include' | 'excludeWorkspaces'>;
const WARNINGS = [
  'Model files, credentials, device paths, and security permissions are not transferred.',
  'Portable backups support up to 5,000 files, 16 MiB per file, and 64 MiB of content.',
];
const ConfigKeys = [
  'meesterGezelId',
  'klerkGezelId',
  'boekwachterGezelId',
  'keurmeesterGezelId',
  'sharedProjectId',
  'roleBasedNameOnlyMode',
] as const;
function portableConfig(config: GezelConfig): GezelConfig {
  return GezelConfigSchema.parse(
    Object.fromEntries(
      ConfigKeys.flatMap((key) => (config[key] === undefined ? [] : [[key, config[key]]])),
    ),
  );
}
async function collect(
  repo: PortableRepository,
  options: PortableBackupOptions,
): Promise<{ entries: Map<string, Uint8Array>; manifest: BackupManifest }> {
  const entries = new Map<string, Uint8Array>();
  const items: BackupManifest['items'] = [];
  let total = 0;
  async function item(
    kind: BackupManifest['items'][number]['kind'],
    id: string,
    label: string,
    root: string,
    entryPrefix = root,
  ): Promise<void> {
    let bytes = 0;
    let fileCount = 0;
    for (const path of await repo.tree(root)) {
      if (
        isBackupDerivedPath(path) ||
        (options.excludeWorkspaces && kind === 'project' && path.startsWith(`${root}/workspace/`))
      )
        continue;
      if ((await repo.stat(path))?.isDirectory) continue;
      const data = await repo.files.read(path);
      if (!data) continue;
      total += data.length;
      bytes += data.length;
      fileCount++;
      if (
        data.length > PORTABLE_BACKUP_LIMITS.fileBytes ||
        total > PORTABLE_BACKUP_LIMITS.totalBytes ||
        entries.size >= PORTABLE_BACKUP_LIMITS.files - 1
      )
        throw new Error('Selected content exceeds portable backup limits');
      entries.set(`${entryPrefix}${path.slice(root.length)}`, data);
    }
    items.push({ kind, id, label, entryPrefix, bytes, fileCount });
  }
  const requested = (kind: BackupManifest['items'][number]['kind'], id: string) =>
    isBackupItemRequested({ kind, id }, options.include);
  for (const gezel of await listGezels(repo))
    if (requested('gezel', gezel.id))
      await item('gezel', gezel.id, gezel.name, `gezels/${gezel.id}`);
  for (const project of await listProjects(repo))
    if (!isSharedLibraryProject(project) && requested('project', project.id))
      await item('project', project.id, project.name, `projects/${project.id}`);
  if (requested('document-root', 'documents'))
    await item('document-root', 'documents', 'Shared documents', 'documents');
  if (requested('settings-file', 'config.json')) {
    const content = boundedText(JSON.stringify(portableConfig(await readConfig(repo))));
    entries.set('settings/config.json', content);
    items.push({
      kind: 'settings-file',
      id: 'config.json',
      label: 'Settings',
      entryPrefix: 'settings/config.json',
      bytes: content.length,
      fileCount: 1,
    });
  }
  return {
    entries,
    manifest: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: BACKUP_MANIFEST_KIND,
      createdAt: repo.now(),
      gezelVersion: repo.version,
      platform: 'portable',
      excludedWorkspaces: options.excludeWorkspaces === true,
      externalFolders: null,
      items,
      secretsExcluded: true,
    },
  };
}
export async function planBackup(
  repo: PortableRepository,
  options: PortableBackupOptions = {},
): Promise<BackupPlan> {
  const { manifest } = await collect(repo, options);
  return {
    items: manifest.items.map(({ entryPrefix: _prefix, ...item }) => ({
      ...item,
      external: false,
    })),
    totalBytes: manifest.items.reduce((sum, item) => sum + item.bytes, 0),
    secretsExcluded: true,
    warnings: WARNINGS,
  };
}
export async function exportBackup(
  repo: PortableRepository,
  options: PortableBackupOptions = {},
): Promise<{ bytes: Uint8Array; manifest: BackupManifest }> {
  const { entries, manifest } = await collect(repo, options);
  entries.set('manifest.json', boundedText(JSON.stringify(manifest)));
  return { bytes: writeBackupZip(entries), manifest };
}
function parseRecord(bytes: Uint8Array): unknown {
  return JSON.parse(decodeText(bytes, PORTABLE_BACKUP_LIMITS.fileBytes));
}
function validateFile(path: string, bytes: Uint8Array): void {
  const segments = path.split('/');
  if (segments[0] === 'settings') {
    // Only the config is parsed; other known settings files (the desktop's
    // `history.jsonl`) ride along as opaque text and are never restored here.
    if (segments[1] === 'config.json') GezelConfigSchema.parse(parseRecord(bytes));
    else if (!isBackupSettingsFileId(segments[1] ?? ''))
      throw new Error('Unsupported settings file in backup');
    return;
  }
  if (segments[0] === 'documents') return;
  const id = segments[1]!;
  const relative = segments.slice(2).join('/');
  if (relative === 'project.json' && segments[0] === 'projects') {
    if (ProjectSchema.parse(parseRecord(bytes)).id !== id)
      throw new Error('Backup project identity does not match its path');
  } else if (relative === 'questions.json' && segments[0] === 'projects') {
    const questions = z.array(QuestionSchema).parse(parseRecord(bytes));
    if (questions.some((question) => question.projectId !== id))
      throw new Error('Backup question identity does not match its project');
  } else if (relative === 'gezel.md' && segments[0] === 'gezels') {
    const parsed = parseGezelMarkdown(decodeText(bytes));
    if (parsed.frontmatter.id && parsed.frontmatter.id !== id)
      throw new Error('Backup gezel identity does not match its path');
    if (!parsed.frontmatter.name.trim()) throw new Error('Backup gezel needs a name');
  } else if (relative === 'poppetje.json' && segments[0] === 'gezels') {
    if (PoppetjeSchema.parse(parseRecord(bytes)).key !== id)
      throw new Error('Backup character identity does not match its gezel');
  } else if (/^sessions\/[^/]+\.json$/.test(relative) && segments[0] === 'gezels') {
    const session = ChatSessionSchema.parse(parseRecord(bytes));
    if (session.gezelId !== id || `${session.id}.json` !== segments[3])
      throw new Error('Backup session identity does not match its path');
    assertSafeEntityId(session.projectId);
  } else if (/^artifacts\/prompts\/[^/]+\/draft\.json$/.test(relative)) {
    const draft = PromptDraftMetaSchema.parse(parseRecord(bytes));
    if (draft.projectId !== id || draft.id !== segments[4])
      throw new Error('Backup draft identity does not match its path');
  } else if (/^tasks\/[^/]+\/task\.json$/.test(relative)) {
    const task = TaskSchema.parse(parseRecord(bytes));
    if (
      task.projectId !== id ||
      String(task.num) !== segments[3] ||
      task.ref !== `${id}/${task.num}`
    )
      throw new Error('Backup task identity does not match its path');
  } else if (/^scripts\/runs\/[^/]+\/[^/]+\.json$/.test(relative)) {
    const run = ScriptRunSchema.parse(parseRecord(bytes));
    if (
      run.projectId !== id ||
      `${run.id}.json` !== segments[5] ||
      run.startedAt.slice(0, 10) !== segments[4]
    )
      throw new Error('Backup script run identity does not match its path');
  } else if (/^memories\/daily\//.test(relative)) {
    if (!/^memories\/daily\/\d{4}-\d{2}-\d{2}\.md$/.test(relative))
      throw new Error('Invalid memory day in backup');
    validateMemoryDay(relative.slice('memories/daily/'.length, -3));
    decodeText(bytes);
  } else if (
    ['about.md', 'memories/summary.md', 'memories/lessons.md'].includes(relative) ||
    relative.startsWith('documents/')
  )
    decodeText(bytes);
}
async function inspect(
  bytes: Uint8Array,
): Promise<{ entries: Map<string, Uint8Array>; manifest: BackupManifest }> {
  const entries = await readBackupZip(bytes);
  const encoded = entries.get('manifest.json');
  if (!encoded) throw new Error('Backup manifest is missing');
  const manifest = BackupManifestSchema.parse(parseRecord(encoded));
  if (
    manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    manifest.items.length > PORTABLE_BACKUP_LIMITS.files
  )
    throw new Error('Unsupported backup schema version');
  const claimed = new Set(['manifest.json']);
  const identities = new Set<string>();
  for (const item of manifest.items) {
    const prefix = backupEntryPrefix(item);
    const identity = `${item.kind}/${item.id}`;
    if (identities.has(identity) || item.entryPrefix !== prefix)
      throw new Error('Invalid or duplicate backup item');
    identities.add(identity);
    let total = 0;
    let count = 0;
    for (const [path, content] of entries)
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        if (claimed.has(path) || isBackupDerivedPath(path))
          throw new Error('Backup contains overlapping items or private runtime data');
        validateFile(path, content);
        claimed.add(path);
        total += content.length;
        count++;
      }
    if (count !== item.fileCount || total !== item.bytes)
      throw new Error('Backup manifest sizes do not match its files');
    if (
      (item.kind === 'project' || item.kind === 'gezel') &&
      !entries.has(`${prefix}/${item.kind === 'project' ? 'project.json' : 'gezel.md'}`)
    )
      throw new Error('Backup entity metadata is missing');
  }
  if (claimed.size !== entries.size) throw new Error('Backup contains undeclared files');
  return { entries, manifest };
}
const StagedSchema = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    review: z.unknown(),
  })
  .strict();
const digest = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
function restoreRoot(id: string): string {
  assertSafeEntityId(id);
  return `.restore/${id}`;
}
async function targetExists(
  repo: PortableRepository,
  item: BackupManifest['items'][number],
): Promise<boolean> {
  return repo.exists(
    item.kind === 'settings-file' && isBackupSettingsFileId(item.id)
      ? backupSettingsTarget(item.id)
      : backupEntryPrefix(item),
  );
}
export async function scanRestore(
  repo: PortableRepository,
  bytes: Uint8Array,
): Promise<RestoreReview> {
  // At most three pending reviews prevent abandoned uploads filling the device.
  // A review is two writes, so a kill between them leaves a directory holding
  // an archive nobody can name. Those are swept here rather than counted:
  // otherwise three interrupted uploads lock the user out of importing at all.
  const pending: string[] = [];
  for (const entry of await repo.list('.restore')) {
    if (!entry.isDirectory) continue;
    if (await repo.exists(`.restore/${entry.name}/review.json`)) {
      pending.push(entry.name);
      continue;
    }
    await repo.files.remove(`.restore/${entry.name}`).catch(() => {});
  }
  if (pending.length >= 3)
    throw new Error('Cancel a pending restore review before importing another backup');
  const { manifest } = await inspect(bytes);
  const id = repo.createId();
  const root = restoreRoot(id);
  const review: RestoreReview = {
    restoreId: id,
    createdAt: repo.now(),
    gezelVersion: manifest.gezelVersion,
    archivePath: 'Imported backup',
    items: await Promise.all(
      manifest.items.map(async ({ entryPrefix: _prefix, ...item }) => ({
        ...item,
        conflict: (await targetExists(repo, {
          ...item,
          entryPrefix: backupEntryPrefix(item),
        }))
          ? ('exists' as const)
          : ('none' as const),
      })),
    ),
    secretsExcluded: true,
    warnings: WARNINGS,
  };
  await repo.files.mkdir(root);
  try {
    await repo.files.write(`${root}/archive.zip`, bytes);
    await repo.files.write(
      `${root}/review.json`,
      repo.json({ version: 1, digest: await digest(bytes), review }),
    );
  } catch (error) {
    await repo.files.remove(root).catch(() => {});
    throw error;
  }
  return review;
}
export async function cancelRestore(
  repo: PortableRepository,
  id: string,
): Promise<{ cancelled: boolean }> {
  await repo.files.remove(restoreRoot(id));
  return { cancelled: true };
}
export async function confirmRestore(
  repo: PortableRepository,
  id: string,
  raw: RestoreConfirm,
): Promise<{ restored: number }> {
  const input = RestoreConfirmSchema.parse(raw);
  const root = restoreRoot(id);
  const staged = await repo.record(`${root}/review.json`, StagedSchema);
  const bytes = await repo.files.read(`${root}/archive.zip`);
  if (!staged || !bytes) throw new Error('Restore review could not be found');
  if ((await digest(bytes)) !== staged.digest) throw new Error('The reviewed backup has changed');
  const { entries, manifest } = await inspect(bytes);
  const writes = new Map<string, Uint8Array>();
  const clears: string[] = [];
  const directories: string[] = [];
  const selected = new Set<string>();
  const config = await readConfig(repo);
  const importedConfig = entries.has('settings/config.json')
    ? portableConfig(GezelConfigSchema.parse(parseRecord(entries.get('settings/config.json')!)))
    : {};
  if (input.settings && !entries.has('settings/config.json'))
    throw new Error('This backup contains no settings to restore');
  const libraryId = await sharedProjectId(repo);
  for (const requested of input.items) {
    const key = `${requested.kind}/${requested.id}`;
    if (selected.has(key)) throw new Error('Restore selection contains duplicates');
    selected.add(key);
    const item = manifest.items.find(
      (candidate) => candidate.kind === requested.kind && candidate.id === requested.id,
    );
    if (!item) throw new Error('Restore selection is not present in the reviewed backup');
    if (item.kind === 'settings-file') continue;
    const target = backupEntryPrefix(item);
    if ((await targetExists(repo, item)) && requested.action !== 'replace')
      throw new Error(`Choose replace to restore ${item.label}`);
    if (item.kind === 'project') {
      const before = await getProject(repo, item.id);
      if (before?.status === 'readonly' || (before && isSharedLibraryProject(before)))
        throw new Error('A read-only project or shared-library identity cannot be replaced');
    }
    if (item.kind === 'document-root' && libraryId) {
      const library = await getProject(repo, libraryId);
      if (library && (library.status === 'readonly' || !projectManagedWorkspaceWritable(library)))
        throw new Error('Shared document writes are disabled');
    }
    clears.push(target);
    directories.push(target);
    for (const [path, original] of entries)
      if (path.startsWith(`${target}/`)) {
        let data = original;
        if (path === `${target}/project.json`) {
          const project = ProjectSchema.parse(parseRecord(data));
          if (isSharedLibraryProject(project))
            throw new Error('Shared library metadata must not be restored as an ordinary project');
          const before = await getProject(repo, item.id);
          delete project.workingDir;
          delete project.github;
          // Imported data cannot expand an existing project's write authority.
          project.managedWorkspaceWritePolicy = before
            ? (before.managedWorkspaceWritePolicy ??
              (before.allowGezelWrites === false ? 'deny' : 'auto'))
            : project.managedWorkspaceWritePolicy === 'deny'
              ? 'deny'
              : 'auto';
          delete project.allowGezelWrites;
          data = repo.json(project);
        } else if (/^gezels\/[^/]+\/sessions\/[^/]+\.json$/.test(path)) {
          const session = ChatSessionSchema.parse(parseRecord(data));
          session.providerState = {};
          if (session.projectId === importedConfig.sharedProjectId && libraryId)
            session.projectId = libraryId;
          data = repo.json(session);
        } else if (path === `${target}/gezel.md`) {
          const parsed = parseGezelMarkdown(decodeText(data));
          parsed.frontmatter.id = item.id;
          data = boundedText(serializeGezelMarkdown(parsed));
        }
        writes.set(path, data);
      }
    if (item.kind === 'project') {
      directories.push(`${target}/workspace`, `${target}/artifacts`);
      if (manifest.excludedWorkspaces)
        for (const path of await repo.tree(`${target}/workspace`)) {
          if ((await repo.stat(path))?.isDirectory) directories.push(path);
          else {
            const content = await repo.files.read(path);
            if (content) writes.set(path, content);
          }
        }
    }
  }
  if (input.settings) {
    // Preserve every device capability, provider, secret, path and permission.
    const preferences = { ...importedConfig };
    delete preferences.sharedProjectId;
    for (const key of [
      'meesterGezelId',
      'klerkGezelId',
      'boekwachterGezelId',
      'keurmeesterGezelId',
    ] as const)
      if (
        preferences[key] &&
        !writes.has(`gezels/${preferences[key]}/gezel.md`) &&
        !(await repo.exists(`gezels/${preferences[key]}/gezel.md`))
      )
        delete preferences[key];
    writes.set('config.json', repo.json({ ...config, ...preferences }));
  }
  for (const [path, data] of writes)
    if (/^gezels\/[^/]+\/sessions\/[^/]+\.json$/.test(path)) {
      const session = ChatSessionSchema.parse(parseRecord(data));
      if (
        !writes.has(`projects/${session.projectId}/project.json`) &&
        !(await getProject(repo, session.projectId))
      )
        throw new Error('Restore the projects used by these conversations as well');
    }
  if (!clears.length && !input.settings) throw new Error('Choose content to restore');
  if (
    writes.size > PORTABLE_BACKUP_LIMITS.files ||
    [...writes.values()].reduce((total, data) => total + data.length, 0) >
      PORTABLE_BACKUP_LIMITS.totalBytes
  )
    throw new Error('Restored content and retained working files exceed portable restore limits');
  await repo.transactions.commit(writes, [root], directories, clears);
  return { restored: clears.length + Number(!!input.settings) };
}
