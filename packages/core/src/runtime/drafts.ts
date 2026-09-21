import {
  derivePromptDraftTitle,
  formatPromptDraftId,
  isPromptDraftId,
  parsePromptDraftId,
} from '../prompt-drafts.js';
import {
  type CreatePromptDraftRequest,
  CreatePromptDraftRequestSchema,
  type DuplicatePromptDraftRequest,
  DuplicatePromptDraftRequestSchema,
  type PatchPromptDraftRequest,
  PatchPromptDraftRequestSchema,
  type PromptDraft,
  type PromptDraftMeta,
  PromptDraftMetaSchema,
  type PromptDraftSummary,
  type WritePromptDraftContentResponse,
} from '../schemas/prompt-draft.js';
import { boundedText } from './files.js';
import { requireGezel } from './gezels.js';
import { projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';
import { getSession } from './sessions.js';
import { getTask } from './tasks.js';

export function draftRoot(projectId: string, id: string): string {
  if (!isPromptDraftId(id)) throw new Error('Invalid prompt draft identifier');
  return `${projectRoot(projectId)}/artifacts/prompts/${id}`;
}
async function validateRecipient(
  repo: PortableRepository,
  projectId: string,
  input: {
    gezelId: string;
    sessionId: string | null;
    taskRef?: string | null;
    craftbookRef?: string | null;
  },
): Promise<void> {
  await requireProject(repo, projectId);
  await requireGezel(repo, input.gezelId);
  if (input.taskRef) {
    const task = await getTask(repo, input.taskRef);
    if (!task || task.projectId !== projectId)
      throw new Error('Task does not belong to the selected project');
  } else if (input.craftbookRef)
    throw new Error('Craftbook authoring conversations are unavailable on this host');
  if (input.sessionId) {
    const session = await getSession(repo, input.gezelId, input.sessionId);
    if (!session || session.projectId !== projectId)
      throw new Error('This conversation does not belong to the selected project and gezel');
    if (
      (input.taskRef && input.taskRef !== session.taskRef) ||
      (input.craftbookRef && input.craftbookRef !== session.craftbookRef)
    )
      throw new Error('This conversation does not belong to the selected task or craftbook');
  }
}
export async function getPromptDraft(
  repo: PortableRepository,
  projectId: string,
  id: string,
): Promise<PromptDraft | null> {
  await requireProject(repo, projectId);
  const root = draftRoot(projectId, id);
  const meta = await repo.record(`${root}/draft.json`, PromptDraftMetaSchema);
  if (!meta) return null;
  if (meta.id !== id || meta.projectId !== projectId)
    throw new Error('Prompt draft identity does not match its directory');
  const content = (await repo.text(`${root}/message.md`)) ?? '';
  let fileCount = 0;
  for (const path of await repo.tree(`${root}/message_files`))
    if (!(await repo.stat(path))?.isDirectory) fileCount++;
  return {
    ...meta,
    content,
    title: derivePromptDraftTitle(content),
    hasFiles: fileCount > 0,
    fileCount,
  };
}
export async function listPromptDrafts(
  repo: PortableRepository,
  projectId: string,
  options: {
    gezelId?: string;
    sessionId?: string | null;
    status?: 'draft' | 'sent';
    scope?: string;
  } = {},
): Promise<PromptDraftSummary[]> {
  await requireProject(repo, projectId);
  const drafts: PromptDraftSummary[] = [];
  for (const entry of await repo.list(`${projectRoot(projectId)}/artifacts/prompts`)) {
    if (!entry.isDirectory || !isPromptDraftId(entry.name)) continue;
    const draft = await getPromptDraft(repo, projectId, entry.name);
    if (
      !draft ||
      (options.gezelId && draft.gezelId !== options.gezelId) ||
      (options.sessionId !== undefined && draft.sessionId !== options.sessionId) ||
      (options.status && draft.status !== options.status) ||
      (options.scope && draft.scope !== options.scope)
    )
      continue;
    const { content: _content, ...summary } = draft;
    drafts.push(summary);
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createPromptDraft(
  repo: PortableRepository,
  projectId: string,
  raw: CreatePromptDraftRequest,
): Promise<PromptDraft> {
  const input = CreatePromptDraftRequestSchema.parse(raw);
  await validateRecipient(repo, projectId, { ...input, sessionId: input.sessionId ?? null });
  const entries = await repo.list(`${projectRoot(projectId)}/artifacts/prompts`);
  const seq =
    entries.reduce(
      (maximum, entry) => Math.max(maximum, parsePromptDraftId(entry.name)?.seq ?? 0),
      0,
    ) + 1;
  const at = repo.now();
  const id = formatPromptDraftId(new Date(at), seq);
  const root = draftRoot(projectId, id);
  const meta = PromptDraftMetaSchema.parse({
    ...input,
    id,
    projectId,
    sessionId: input.sessionId ?? null,
    createdAt: at,
    updatedAt: at,
    status: 'draft',
  });
  await repo.transactions.commit(
    new Map([
      [`${root}/draft.json`, repo.json(meta)],
      [`${root}/message.md`, boundedText(input.content ?? '')],
    ]),
    [],
    [`${root}/message_files`],
  );
  return (await getPromptDraft(repo, projectId, id))!;
}
async function requireDraft(
  repo: PortableRepository,
  projectId: string,
  id: string,
): Promise<PromptDraft> {
  const draft = await getPromptDraft(repo, projectId, id);
  if (!draft) throw new Error('Prompt draft could not be found');
  return draft;
}
export async function writePromptDraftContent(
  repo: PortableRepository,
  projectId: string,
  id: string,
  content: string,
): Promise<WritePromptDraftContentResponse> {
  const draft = await requireDraft(repo, projectId, id);
  if (draft.status !== 'draft') throw new Error('A sent draft cannot be edited');
  if (!content.trim() && !draft.hasFiles) {
    await repo.transactions.commit(new Map(), [draftRoot(projectId, id)]);
    return { draft: null, deleted: true };
  }
  const root = draftRoot(projectId, id);
  await repo.transactions.commit(
    new Map([
      [
        `${root}/draft.json`,
        repo.json(PromptDraftMetaSchema.parse({ ...draft, updatedAt: repo.now() })),
      ],
      [`${root}/message.md`, boundedText(content)],
    ]),
  );
  const { content: _content, ...summary } = (await getPromptDraft(repo, projectId, id))!;
  return { draft: summary, deleted: false };
}
export async function patchPromptDraft(
  repo: PortableRepository,
  projectId: string,
  id: string,
  raw: PatchPromptDraftRequest,
): Promise<PromptDraft> {
  const before = await requireDraft(repo, projectId, id);
  if (before.status !== 'draft') throw new Error('A sent draft cannot be edited');
  const patch = PatchPromptDraftRequestSchema.parse(raw);
  const fields: Record<string, unknown> = { ...before, ...patch, updatedAt: repo.now() };
  for (const key of ['taskRef', 'craftbookRef', 'scope'])
    if (fields[key] === null) delete fields[key];
  const meta = PromptDraftMetaSchema.parse(fields);
  await validateRecipient(repo, projectId, meta);
  await repo.transactions.commit(
    new Map([[`${draftRoot(projectId, id)}/draft.json`, repo.json(meta)]]),
  );
  return (await getPromptDraft(repo, projectId, id))!;
}
export async function deletePromptDraft(
  repo: PortableRepository,
  projectId: string,
  id: string,
): Promise<boolean> {
  if (!(await getPromptDraft(repo, projectId, id))) return false;
  await repo.transactions.commit(new Map(), [draftRoot(projectId, id)]);
  return true;
}
export async function markPromptDraftSent(
  repo: PortableRepository,
  projectId: string,
  id: string,
  sessionId: string,
  messageAt?: string,
): Promise<PromptDraft> {
  const before = await requireDraft(repo, projectId, id);
  await validateRecipient(repo, projectId, { ...before, sessionId });
  const at = repo.now();
  const meta: PromptDraftMeta = {
    ...PromptDraftMetaSchema.parse(before),
    status: 'sent',
    updatedAt: at,
    sentAt: at,
    sentSessionId: sessionId,
    ...(messageAt ? { sentMessageAt: messageAt } : {}),
  };
  await repo.transactions.commit(
    new Map([[`${draftRoot(projectId, id)}/draft.json`, repo.json(meta)]]),
  );
  return (await getPromptDraft(repo, projectId, id))!;
}

/** Copy metadata, prose and attachments in one recoverable commit. */
export async function duplicatePromptDraft(
  repo: PortableRepository,
  projectId: string,
  sourceId: string,
  raw: DuplicatePromptDraftRequest = {},
): Promise<PromptDraft> {
  const options = DuplicatePromptDraftRequestSchema.parse(raw);
  const before = await requireDraft(repo, projectId, sourceId);
  const sessionId = options.sessionId === undefined ? before.sessionId : options.sessionId;
  await validateRecipient(repo, projectId, { ...before, sessionId });
  const entries = await repo.list(`${projectRoot(projectId)}/artifacts/prompts`);
  const seq =
    entries.reduce(
      (maximum, entry) => Math.max(maximum, parsePromptDraftId(entry.name)?.seq ?? 0),
      0,
    ) + 1;
  const at = repo.now();
  const id = formatPromptDraftId(new Date(at), seq);
  const root = draftRoot(projectId, id);
  const source = draftRoot(projectId, sourceId);
  const meta = PromptDraftMetaSchema.parse({
    id,
    projectId,
    gezelId: before.gezelId,
    sessionId,
    taskRef: before.taskRef,
    craftbookRef: before.craftbookRef,
    scope: before.scope,
    createdAt: at,
    updatedAt: at,
    status: 'draft',
  });
  const writes = new Map([
    [`${root}/draft.json`, repo.json(meta)],
    [`${root}/message.md`, boundedText(before.content)],
  ]);
  const directories = [`${root}/message_files`];
  for (const path of await repo.tree(`${source}/message_files`)) {
    const destination = `${root}${path.slice(source.length)}`;
    if ((await repo.stat(path))?.isDirectory) directories.push(destination);
    else {
      const bytes = await repo.files.read(path);
      if (bytes === null) throw new Error('A draft attachment disappeared while copying');
      writes.set(destination, bytes);
    }
  }
  await repo.transactions.commit(writes, [], directories);
  return (await getPromptDraft(repo, projectId, id))!;
}
