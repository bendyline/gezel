import { isOutsideInInternalPath } from '../outside-in-paths.js';
import { isPromptDraftId } from '../prompt-drafts.js';
import type { ProjectFileEntry } from '../schemas/project.js';
import { PromptDraftMetaSchema } from '../schemas/prompt-draft.js';
import { projectManagedWorkspaceWritable } from '../security/policy.js';
import {
  isReservedDiffpackArtifactPath,
  isReservedShadowArtifactPath,
  isReservedTabularArtifactPath,
} from '../shadow-paths.js';
import { isSharedLibraryProject } from '../shared-project.js';
import { PORTABLE_MAX_RECORD_BYTES, boundedText, readText, validatePortablePath } from './files.js';
import { projectRoot, requireProject, sharedProjectId } from './projects.js';
import type { PortableRepository } from './repository.js';

export type PortableFileArea = 'workspace' | 'artifacts' | 'documents';
export interface PortableListOptions {
  withStats?: boolean;
  includeHidden?: boolean;
  subpath?: string;
}

async function basePath(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId?: string,
): Promise<string> {
  if (area === 'documents') {
    const id = await sharedProjectId(repo);
    if (!id) throw new Error('The shared library has not been initialized');
    return 'documents';
  }
  if (!projectId) throw new Error('A project is required');
  const project = await requireProject(repo, projectId);
  return area === 'workspace' && isSharedLibraryProject(project)
    ? 'documents'
    : `${projectRoot(projectId)}/${area}`;
}
async function filePath(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
  write = false,
): Promise<string> {
  validatePortablePath(path);
  if (
    write &&
    area === 'artifacts' &&
    (isReservedShadowArtifactPath(path) ||
      isReservedTabularArtifactPath(path) ||
      isReservedDiffpackArtifactPath(path))
  )
    throw new Error('This artifact folder is managed by Gezel');
  if (write && area === 'artifacts' && path.split('/')[0] === 'prompts') {
    const [, id, folder, ...rest] = path.split('/');
    if (!id || !isPromptDraftId(id) || folder !== 'message_files' || !rest.length)
      throw new Error('Prompt metadata must be changed through the draft editor');
    const draft = await repo.record(
      `${projectRoot(projectId!)}/artifacts/prompts/${id}/draft.json`,
      PromptDraftMetaSchema,
    );
    if (!draft || draft.projectId !== projectId || draft.status !== 'draft')
      throw new Error('This draft is not editable');
  }
  if (write) {
    const ownerId = projectId ?? (area === 'documents' ? await sharedProjectId(repo) : null);
    if (ownerId) {
      const owner = await requireProject(repo, ownerId);
      if (owner.status === 'readonly') throw new Error('This project is read-only');
      if (area !== 'artifacts' && !projectManagedWorkspaceWritable(owner))
        throw new Error('Workspace writes are disabled for this project');
    }
  }
  return `${await basePath(repo, area, projectId)}/${path}`;
}
export async function listFiles(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  subpath = '',
  recursive = false,
  options: PortableListOptions = {},
): Promise<{ entries: ProjectFileEntry[]; truncated: boolean }> {
  validatePortablePath(subpath, true);
  const root = await basePath(repo, area, projectId);
  const entries: ProjectFileEntry[] = [];
  let truncated = false;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 64) {
      truncated = true;
      return;
    }
    for (const entry of await repo.list(relative ? `${root}/${relative}` : root)) {
      const path = validatePortablePath(relative ? `${relative}/${entry.name}` : entry.name);
      if (
        !options.includeHidden &&
        (entry.name.startsWith('.') ||
          (isOutsideInInternalPath(path) && !isOutsideInInternalPath(subpath)))
      )
        continue;
      if (
        area === 'artifacts' &&
        (isReservedShadowArtifactPath(path) || isReservedTabularArtifactPath(path))
      )
        continue;
      if (entries.length >= 5000) {
        truncated = true;
        return;
      }
      entries.push({
        name: entry.name,
        path,
        isDirectory: entry.isDirectory,
        ...(options.withStats ? { mtimeMs: entry.mtime } : {}),
      });
      if (recursive && entry.isDirectory) await visit(path, depth + 1);
    }
  };
  await visit(subpath, 0);
  return {
    entries: entries.sort(
      (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path),
    ),
    truncated,
  };
}
export async function readFile(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
): Promise<string | null> {
  return readText(repo.files, await filePath(repo, area, projectId, path));
}
export async function writeFile(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
  content: string,
): Promise<void> {
  await writeFileBytes(repo, area, projectId, path, boundedText(content));
}
export async function makeFolder(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
): Promise<void> {
  const destination = await filePath(repo, area, projectId, path, true);
  if ((await repo.stat(destination))?.isDirectory === false)
    throw new Error('A file already exists at this path');
  await repo.transactions.commit(new Map(), [], [destination]);
}
export async function deleteFile(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
): Promise<void> {
  const destination = await filePath(repo, area, projectId, path, true);
  await repo.transactions.commit(new Map(), [destination]);
}
export async function renameFile(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  from: string,
  to: string,
): Promise<void> {
  const source = await filePath(repo, area, projectId, from, true);
  const destination = await filePath(repo, area, projectId, to, true);
  if (!(await repo.exists(source))) throw new Error('The source file could not be found');
  if (await repo.exists(destination)) throw new Error('The destination already exists');
  if (destination.startsWith(`${source}/`))
    throw new Error('A directory cannot be moved inside itself');
  const bytes = (await repo.stat(source))?.isDirectory ? null : await repo.files.read(source);
  const writes = new Map<string, Uint8Array>();
  const directories: string[] = [];
  if (bytes !== null) writes.set(destination, bytes);
  else {
    directories.push(destination);
    for (const path of await repo.tree(source)) {
      const newPath = `${destination}${path.slice(source.length)}`;
      const data = (await repo.stat(path))?.isDirectory ? null : await repo.files.read(path);
      if (data === null) directories.push(newPath);
      else writes.set(newPath, data);
    }
  }
  await repo.transactions.commit(writes, [source], directories);
}

export async function readFileBytes(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
): Promise<Uint8Array | null> {
  const source = await filePath(repo, area, projectId, path);
  if ((await repo.stat(source))?.isDirectory) throw new Error('Choose a file, not a folder');
  return repo.files.read(source);
}
export async function writeFileBytes(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
  bytes: Uint8Array,
  options: { createOnly?: boolean } = {},
): Promise<void> {
  const destination = await filePath(repo, area, projectId, path, true);
  if (bytes.byteLength > PORTABLE_MAX_RECORD_BYTES)
    throw new Error('File exceeds the 16 MiB limit');
  const existing = await repo.stat(destination);
  if (existing?.isDirectory || (existing && options.createOnly))
    throw new Error('A file or folder already exists at this path');
  await repo.transactions.commit(new Map([[destination, bytes]]));
}

/** Metadata through the same confinement boundary; callers need not read a large file. */
export async function statFile(
  repo: PortableRepository,
  area: PortableFileArea,
  projectId: string | undefined,
  path: string,
) {
  return (await repo.stat(await filePath(repo, area, projectId, path))) ?? null;
}

/** Human-facing Documents facade, shared with question attachment links. Agent
 * file tools continue to use their scoped file-area port. */
export async function readDocumentReference(
  repo: PortableRepository,
  path: string,
): Promise<Uint8Array | null> {
  validatePortablePath(path);
  const shared = await readFileBytes(repo, 'documents', undefined, path);
  if (shared !== null) return shared;
  const match = /^projects\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return null;
  const projectId = match[1]!;
  const relative = match[2]!;
  await requireProject(repo, projectId);
  for (const area of ['artifacts', 'workspace'] as const)
    if (relative.startsWith(`${area}/`))
      return readFileBytes(repo, area, projectId, relative.slice(area.length + 1));
  const name = relative.replace(/^documents\//, '');
  if (name === 'about.md' || name === 'missionObjectives.md') {
    const text = await readText(repo.files, `${projectRoot(projectId)}/documents/${name}`);
    return text === null ? null : boundedText(text);
  }
  return readFileBytes(repo, 'artifacts', projectId, relative);
}
