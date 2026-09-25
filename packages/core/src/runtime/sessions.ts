import { assertSafeEntityId, isSafeEntityId } from '../entity-id.js';
import { isPromptDraftId } from '../prompt-drafts.js';
import type { ProviderName } from '../schemas/gezel.js';
import { ProjectSchema } from '../schemas/project.js';
import { PromptDraftMetaSchema } from '../schemas/prompt-draft.js';
import {
  type ChatSession,
  ChatSessionSchema,
  type ChatSessionSummary,
} from '../schemas/session.js';
import { NEW_THREAD_TITLE } from '../thread-title.js';
import { draftMatchesSession } from './draft-address.js';
import { sentDraftMeta } from './drafts.js';
import { sessionSummary } from './entities.js';
import { gezelRoot, listGezels, requireGezel } from './gezels.js';
import { projectRoot, readConfig, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';
import { getTask, getTaskLifecycle } from './tasks.js';

export interface CreatePortableSession {
  gezelId: string;
  projectId?: string;
  providerName?: ProviderName;
  model?: string;
  title?: string;
  taskRef?: string;
  stepId?: string;
  craftbookRef?: string;
  roleBasedNameOnlyMode?: boolean;
}
export function sessionPath(gezelId: string, id: string): string {
  assertSafeEntityId(id, 'session id');
  return `${gezelRoot(gezelId)}/sessions/${id}.json`;
}
export async function getSession(
  repo: PortableRepository,
  gezelId: string,
  id: string,
): Promise<ChatSession | null> {
  const session = await repo.tolerantRecord(
    sessionPath(gezelId, id),
    ChatSessionSchema,
    `session ${gezelId}/${id}`,
  );
  if (session && (session.id !== id || session.gezelId !== gezelId))
    throw new Error('Session identity does not match its file');
  return session;
}
export async function writeSession(
  repo: PortableRepository,
  raw: ChatSession,
  options: { sentDraftId?: string } = {},
): Promise<void> {
  const session = ChatSessionSchema.parse(raw);
  await requireGezel(repo, session.gezelId);
  const project = await requireProject(repo, session.projectId);
  const writes = new Map([[sessionPath(session.gezelId, session.id), repo.json(session)]]);
  if (!(project.gezelIds ?? []).includes(session.gezelId))
    writes.set(
      `${projectRoot(project.id)}/project.json`,
      repo.json(
        ProjectSchema.parse({
          ...project,
          gezelIds: [...(project.gezelIds ?? []), session.gezelId],
          updatedAt: repo.now(),
        }),
      ),
    );
  if (options.sentDraftId) {
    if (!isPromptDraftId(options.sentDraftId)) throw new Error('Invalid draft identifier');
    const path = `${projectRoot(session.projectId)}/artifacts/prompts/${options.sentDraftId}/draft.json`;
    const draft = await repo.record(path, PromptDraftMetaSchema);
    if (!draft || !draftMatchesSession(draft, session) || draft.status !== 'draft')
      throw new Error('This draft is not available to send in this conversation');
    const message = session.messages.at(-1);
    if (message?.role !== 'user' || message.draftId !== draft.id)
      throw new Error('The sent message must reference its draft');
    writes.set(
      path,
      repo.json(
        sentDraftMeta(draft, { sessionId: session.id, at: repo.now(), messageAt: message.at }),
      ),
    );
  }
  await repo.transactions.commit(writes);
}
export async function createSession(
  repo: PortableRepository,
  input: CreatePortableSession,
): Promise<ChatSession> {
  const gezel = await requireGezel(repo, input.gezelId);
  const projectId = input.projectId ?? 'default';
  let stepActivationId: string | undefined;
  if (input.taskRef) {
    const task = await getTask(repo, input.taskRef);
    if (!task || task.projectId !== projectId)
      throw new Error('Task does not belong to this project');
    if (input.stepId && !task.craftbook.steps.some((step) => step.id === input.stepId))
      throw new Error('Task step not found');
    const lifecycle = await getTaskLifecycle(repo, task.ref);
    if (input.stepId && lifecycle?.stepId === input.stepId)
      stepActivationId = lifecycle.activationId;
  } else if (input.stepId || input.craftbookRef) throw new Error('Task context requires a task');
  const config = await readConfig(repo);
  const id = repo.createId();
  if (await repo.exists(sessionPath(input.gezelId, id)))
    throw new Error('Session identifier already exists');
  const at = repo.now();
  const session = ChatSessionSchema.parse({
    version: 1,
    id,
    gezelId: input.gezelId,
    projectId,
    taskRef: input.taskRef,
    stepId: input.stepId,
    stepActivationId,
    craftbookRef: input.craftbookRef,
    providerName: input.providerName ?? gezel.provider ?? config.provider ?? 'llama-cpp',
    ...((input.model ?? gezel.model) ? { model: input.model ?? gezel.model } : {}),
    title: input.title ?? NEW_THREAD_TITLE,
    createdAt: at,
    lastActivityAt: at,
    roleBasedNameOnlyMode: input.roleBasedNameOnlyMode ?? config.roleBasedNameOnlyMode,
    messages: [],
    providerState: {},
    aboutSnapshot: gezel.about,
  });
  await writeSession(repo, session);
  return session;
}
export async function listSessions(
  repo: PortableRepository,
  options: { gezelId?: string; projectId?: string } = {},
): Promise<ChatSessionSummary[]> {
  const gezelIds = options.gezelId
    ? [options.gezelId]
    : (await listGezels(repo)).map((gezel) => gezel.id);
  const sessions: ChatSessionSummary[] = [];
  for (const gezelId of gezelIds)
    for (const entry of await repo.list(`${gezelRoot(gezelId)}/sessions`)) {
      if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!isSafeEntityId(id)) continue;
      const session = await repo.listed(`session ${gezelId}/${id}`, () =>
        getSession(repo, gezelId, id),
      );
      if (session && (!options.projectId || session.projectId === options.projectId))
        sessions.push(sessionSummary(session));
    }
  return sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
