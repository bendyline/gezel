import { type GetScriptSourceResponse, ScriptNameSchema } from '../schemas/script.js';
import type { Task } from '../schemas/task.js';
import { craftbookScriptHeader, craftbookScriptProvenance } from '../scripts/provenance.js';
import { encodeText } from './files.js';
import { projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';

export type EditableScriptScope = { scope: 'user' } | { scope: 'project'; projectId: string };
async function folder(repo: PortableRepository, scope: EditableScriptScope, writing = false) {
  if (scope.scope === 'user') return 'scripts';
  const project = await requireProject(repo, scope.projectId);
  if (writing && project.status === 'readonly') throw new Error('This project is read-only');
  return `${projectRoot(scope.projectId)}/scripts`;
}
export async function portableScriptSourceHash(source: string) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(encodeText(source)).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function readScriptSource(
  repo: PortableRepository,
  scope: EditableScriptScope,
  name: string,
): Promise<GetScriptSourceResponse | null> {
  ScriptNameSchema.parse(name);
  const path = `${await folder(repo, scope)}/${name}.ts`;
  const source = await repo.text(path);
  return source === null
    ? null
    : {
        name,
        source,
        hash: await portableScriptSourceHash(source),
        mtimeMs: (await repo.stat(path))?.mtime ?? 0,
        ...(craftbookScriptProvenance(source)
          ? { provenance: { kind: 'craftbook' as const, ref: craftbookScriptProvenance(source)! } }
          : {}),
      };
}
export async function listScriptSources(repo: PortableRepository, scope: EditableScriptScope) {
  const entries = await repo.list(await folder(repo, scope));
  if (entries.length > 1000) throw new Error('The script library exceeds 1000 entries');
  const sources: GetScriptSourceResponse[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.ts')) continue;
    const name = entry.name.slice(0, -3);
    if (!ScriptNameSchema.safeParse(name).success) continue;
    const source = await readScriptSource(repo, scope, name);
    if (source) sources.push(source);
  }
  return sources;
}
/** Called under the repository lock: comparison and replacement are one transaction. */
export async function saveScriptSource(
  repo: PortableRepository,
  scope: EditableScriptScope,
  input: { name: string; source: string; baseHash?: string; create?: boolean },
) {
  ScriptNameSchema.parse(input.name);
  if (input.source.length > 256_000) throw new Error('Script source exceeds 256000 characters');
  const root = await folder(repo, scope, true);
  const previous = await readScriptSource(repo, scope, input.name);
  if (input.create && previous) throw new Error('A script with this name already exists');
  if (input.baseHash !== undefined && input.baseHash !== (previous?.hash ?? ''))
    return {
      status: 'conflict' as const,
      currentHash: previous?.hash ?? '',
      currentSource: previous?.source ?? '',
    };
  await repo.transactions.commit(new Map([[`${root}/${input.name}.ts`, encodeText(input.source)]]));
  return { status: 'saved' as const, hash: await portableScriptSourceHash(input.source) };
}
export async function deleteScriptSource(
  repo: PortableRepository,
  scope: EditableScriptScope,
  name: string,
) {
  ScriptNameSchema.parse(name);
  await repo.transactions.commit(new Map(), [`${await folder(repo, scope, true)}/${name}.ts`]);
}

/** Stage alongside task creation. The task snapshot is authoritative; preserve unrelated authored files. */
export async function stageCraftbookScriptSources(
  repo: PortableRepository,
  projectId: string,
  book: Task['craftbook'],
  writes: Map<string, Uint8Array>,
) {
  for (const [name, source] of Object.entries(book.scripts ?? {})) {
    ScriptNameSchema.parse(name);
    if (source.length > 256_000)
      throw new Error('Craftbook script source exceeds 256000 characters');
    const path = `${projectRoot(projectId)}/scripts/${name}.ts`;
    const existing = await repo.text(path);
    if (existing && !craftbookScriptProvenance(existing)?.startsWith(`${book.id}@`)) continue;
    writes.set(
      path,
      encodeText(craftbookScriptHeader(book.id, book.version ?? 'unversioned') + source),
    );
  }
}
