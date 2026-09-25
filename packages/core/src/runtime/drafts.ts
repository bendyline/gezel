/**
 * Prompt drafts: the messages a user is still writing.
 *
 * One implementation for both hosts, over a small storage port scoped to a
 * project's `artifacts/prompts` folder. A draft is a folder named by its id,
 * holding `draft.json`, `message.md` and `message_files/`; the folder name is
 * the record, so a folder renamed by hand to something that is not an id
 * stops being listed while its files stay put.
 *
 * Two invariants the caller keeps:
 *
 * - Allocation and every metadata change run serialized per project. The id
 *   is `max(existing sequence) + 1` read off the listing, with no counter
 *   file to corrupt, which is only safe if two creates cannot read the same
 *   maximum. The desktop takes a per-project lock; the portable host runs
 *   every store operation under one lock.
 * - The project record is never touched. Autosave writes here about once a
 *   second while someone types, and `project.updatedAt` means "this project
 *   saw activity" elsewhere. Structurally guaranteed: the port cannot reach
 *   outside the prompts folder.
 */
import { createLogger } from '../log.js';
import {
  PROMPT_DRAFT_FILES_DIR_NAME,
  PROMPT_DRAFT_MESSAGE_FILE,
  PROMPT_DRAFT_META_FILE,
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
  type PromptDraftStatus,
  type PromptDraftSummary,
  type WritePromptDraftContentResponse,
} from '../schemas/prompt-draft.js';
import type { PromptDraftTaskLaunch } from '../schemas/task-launch.js';

const log = createLogger('prompt-drafts');

/** Storage for one project's prompts folder. Paths are relative to that folder. */
export interface PromptDraftFiles {
  /** Entries of a folder; `''` is the prompts folder itself. Empty when missing. */
  list(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  /** Every path under a folder, recursively. Empty when missing. */
  tree(dir: string): Promise<Array<{ path: string; isDirectory: boolean }>>;
  /**
   * Make a change: folders created, then writes in insertion order, then
   * removals. One journalled commit on a host that has one; ordered
   * operations elsewhere. A write's parent folder is created as needed.
   */
  apply(change: {
    mkdirs?: readonly string[];
    writes?: ReadonlyMap<string, Uint8Array | string>;
    removes?: readonly string[];
  }): Promise<void>;
}

export interface PromptDraftRecipient {
  gezelId: string;
  sessionId: string | null;
  taskRef?: string;
  craftbookRef?: string;
}

export interface PromptDraftHost {
  /** The clock every timestamp reads. */
  now(): string;
  /** The date a new id is minted under. Defaults to `now()`. */
  allocatedAt?(): string;
  /** Names that must not keep an otherwise empty draft alive (`.DS_Store`). */
  isJunkName?(name: string): boolean;
  /** Refuse a draft addressed to a gezel, thread or task the project does not have. */
  validateRecipient?(projectId: string, input: PromptDraftRecipient): Promise<void>;
}

export interface PromptDraftListFilter {
  gezelId?: string;
  /** `undefined` matches any thread; `null` matches only new-thread drafts. */
  sessionId?: string | null;
  status?: PromptDraftStatus;
  scope?: string;
}

export class PromptDraftNotFoundError extends Error {
  readonly code = 'prompt-draft-not-found' as const;
  constructor(draftId: string) {
    super(`prompt draft not found: ${draftId}`);
    this.name = 'PromptDraftNotFoundError';
  }
}

/**
 * An edit that reached a draft after it was sent. A client conflict, not a
 * fault: a composer's last autosave or thread adoption can lose the race
 * against the send that retired the draft.
 */
export class PromptDraftSentError extends Error {
  readonly code = 'prompt-draft-sent' as const;
  constructor(draftId: string) {
    super(`A sent draft cannot be edited: ${draftId}`);
    this.name = 'PromptDraftSentError';
  }
}

export class PromptDraftInvalidIdError extends Error {
  readonly code = 'prompt-draft-invalid-id' as const;
  constructor(draftId: string) {
    super(`not a prompt draft id: ${draftId}`);
    this.name = 'PromptDraftInvalidIdError';
  }
}

function requireId(id: string): string {
  if (!isPromptDraftId(id)) throw new PromptDraftInvalidIdError(id);
  return id;
}
const metaPath = (id: string) => `${id}/${PROMPT_DRAFT_META_FILE}`;
const messagePath = (id: string) => `${id}/${PROMPT_DRAFT_MESSAGE_FILE}`;
const filesDir = (id: string) => `${id}/${PROMPT_DRAFT_FILES_DIR_NAME}`;
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function listPromptDraftIds(files: PromptDraftFiles): Promise<string[]> {
  return (await files.list(''))
    .filter((entry) => entry.isDirectory && isPromptDraftId(entry.name))
    .map((entry) => entry.name);
}

/** `max(existing sequence) + 1`, dated by `at`. Run serialized per project. */
export async function allocatePromptDraftId(files: PromptDraftFiles, at: string): Promise<string> {
  let max = 0;
  for (const entry of await files.list('')) {
    const seq = parsePromptDraftId(entry.name)?.seq ?? 0;
    if (seq > max) max = seq;
  }
  return formatPromptDraftId(new Date(at), max + 1);
}

/**
 * A draft's metadata, or null. Unreadable JSON is logged and treated as
 * absent rather than failing a listing; a record whose identity disagrees
 * with the folder it sits in is refused, because the folder is the record.
 */
export async function readPromptDraftMeta(
  files: PromptDraftFiles,
  projectId: string,
  id: string,
): Promise<PromptDraftMeta | null> {
  const raw = await files.readText(metaPath(requireId(id)));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`unreadable draft metadata at ${projectId}/${id}: ${describe(err)}`);
    return null;
  }
  const result = PromptDraftMetaSchema.safeParse(parsed);
  if (!result.success) {
    log.warn(`unreadable draft metadata at ${projectId}/${id}: ${result.error.message}`);
    return null;
  }
  if (result.data.id !== id || result.data.projectId !== projectId)
    throw new Error('Prompt draft identity does not match its directory');
  return result.data;
}

async function countFiles(files: PromptDraftFiles, host: PromptDraftHost, id: string) {
  let count = 0;
  for (const entry of await files.tree(filesDir(id))) {
    if (entry.isDirectory) continue;
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (host.isJunkName?.(name)) continue;
    count += 1;
  }
  return count;
}

function derived(
  content: string,
  fileCount: number,
): Pick<PromptDraftSummary, 'title' | 'hasFiles' | 'fileCount'> {
  return { title: derivePromptDraftTitle(content), hasFiles: fileCount > 0, fileCount };
}

/**
 * A copied draft keeps its attached task but not its uploaded inputs: the
 * originals' staging areas were adopted by a launch or swept, so the copy
 * would point at folders that are gone. The person re-picks those files.
 */
function duplicatedTaskLaunch(launch: PromptDraftTaskLaunch): PromptDraftTaskLaunch {
  if (!launch.inputs) return launch;
  const inputs: NonNullable<PromptDraftTaskLaunch['inputs']> = Object.fromEntries(
    Object.entries(launch.inputs).filter(([, source]) => source.from !== 'upload'),
  );
  const inputLabels = launch.inputLabels
    ? Object.fromEntries(Object.entries(launch.inputLabels).filter(([key]) => key in inputs))
    : undefined;
  const { inputs: _inputs, inputLabels: _labels, ...rest } = launch;
  return {
    ...rest,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(inputLabels && Object.keys(inputLabels).length > 0 ? { inputLabels } : {}),
  };
}

function metaBytes(meta: PromptDraftMeta): string {
  return `${JSON.stringify(PromptDraftMetaSchema.parse(meta), null, 2)}\n`;
}

export async function getPromptDraft(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  id: string,
): Promise<PromptDraft | null> {
  const meta = await readPromptDraftMeta(files, projectId, id);
  if (!meta) return null;
  const content = (await files.readText(messagePath(id))) ?? '';
  return { ...meta, ...derived(content, await countFiles(files, host, id)), content };
}

async function requireDraft(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  id: string,
): Promise<PromptDraft> {
  const draft = await getPromptDraft(files, host, projectId, id);
  if (!draft) throw new PromptDraftNotFoundError(id);
  return draft;
}

export async function listPromptDrafts(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  filter: PromptDraftListFilter = {},
): Promise<PromptDraftSummary[]> {
  const out: PromptDraftSummary[] = [];
  for (const id of await listPromptDraftIds(files)) {
    const draft = await getPromptDraft(files, host, projectId, id);
    if (!draft) continue;
    if (filter.gezelId && draft.gezelId !== filter.gezelId) continue;
    if (filter.sessionId !== undefined && draft.sessionId !== filter.sessionId) continue;
    if (filter.status && draft.status !== filter.status) continue;
    if (filter.scope && draft.scope !== filter.scope) continue;
    const { content: _content, ...summary } = draft;
    out.push(summary);
  }
  // Most recently touched first, with the sequence as the tie-break so two
  // drafts saved in the same millisecond still have a stable order.
  out.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return (parsePromptDraftId(b.id)?.seq ?? 0) - (parsePromptDraftId(a.id)?.seq ?? 0);
  });
  return out;
}

export async function createPromptDraft(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  raw: CreatePromptDraftRequest,
): Promise<PromptDraft> {
  const input = CreatePromptDraftRequestSchema.parse(raw);
  await host.validateRecipient?.(projectId, {
    gezelId: input.gezelId,
    sessionId: input.sessionId ?? null,
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
    ...(input.craftbookRef ? { craftbookRef: input.craftbookRef } : {}),
  });
  const at = host.now();
  const id = await allocatePromptDraftId(files, host.allocatedAt?.() ?? at);
  const meta: PromptDraftMeta = {
    id,
    projectId,
    gezelId: input.gezelId,
    sessionId: input.sessionId ?? null,
    ...(input.taskRef ? { taskRef: input.taskRef } : {}),
    ...(input.craftbookRef ? { craftbookRef: input.craftbookRef } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.taskLaunch ? { taskLaunch: input.taskLaunch } : {}),
    createdAt: at,
    updatedAt: at,
    status: 'draft',
  };
  // The message lands before the metadata: a folder without `draft.json`
  // is unlisted rather than a half-written record.
  await files.apply({
    mkdirs: [filesDir(id)],
    writes: new Map<string, string>([
      [messagePath(id), input.content ?? ''],
      [metaPath(id), metaBytes(meta)],
    ]),
  });
  return (await getPromptDraft(files, host, projectId, id))!;
}

/**
 * Save the draft's text. A draft with nothing in it and nothing attached is
 * deleted rather than kept: the composer clears itself on send and on
 * discard, and a husk left behind would show as a blank row forever.
 */
export async function writePromptDraftContent(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  id: string,
  content: string,
): Promise<WritePromptDraftContentResponse & { meta: PromptDraftMeta }> {
  const draft = await requireDraft(files, host, projectId, id);
  if (draft.status !== 'draft') throw new PromptDraftSentError(id);
  const { content: _content, title: _t, hasFiles: _h, fileCount: _f, ...meta } = draft;
  // An attached task is as much "something in it" as a file: a person who
  // configured a craftbook and has not typed yet still owns a draft.
  if (!content.trim() && !draft.hasFiles && !draft.taskLaunch) {
    await files.apply({ removes: [id] });
    return { draft: null, deleted: true, meta: { ...meta, updatedAt: host.now() } };
  }
  const next: PromptDraftMeta = { ...meta, updatedAt: host.now() };
  await files.apply({
    writes: new Map<string, string>([
      [messagePath(id), content],
      [metaPath(id), metaBytes(next)],
    ]),
  });
  return { draft: { ...next, ...derived(content, draft.fileCount) }, deleted: false, meta: next };
}

/** Re-file a draft. An explicit `null` clears an optional ref. */
export async function patchPromptDraft(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  id: string,
  raw: PatchPromptDraftRequest,
): Promise<PromptDraft> {
  const before = await requireDraft(files, host, projectId, id);
  if (before.status !== 'draft') throw new PromptDraftSentError(id);
  const patch = PatchPromptDraftRequestSchema.parse(raw);
  const { content: _content, title: _t, hasFiles: _h, fileCount: _f, ...meta } = before;
  const next: PromptDraftMeta = { ...meta, updatedAt: host.now() };
  if (patch.gezelId !== undefined) next.gezelId = patch.gezelId;
  if (patch.sessionId !== undefined) next.sessionId = patch.sessionId;
  for (const key of ['taskRef', 'craftbookRef', 'scope'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (patch.taskLaunch !== undefined) {
    if (patch.taskLaunch === null) delete next.taskLaunch;
    else next.taskLaunch = patch.taskLaunch;
  }
  await host.validateRecipient?.(projectId, next);
  await files.apply({ writes: new Map([[metaPath(id), metaBytes(next)]]) });
  return (await getPromptDraft(files, host, projectId, id))!;
}

/** The one transition a send makes: adopt the thread, mark sent, stamp times. */
export function sentDraftMeta(
  meta: PromptDraftMeta,
  info: { sessionId: string; at: string; messageAt?: string },
): PromptDraftMeta {
  return {
    ...meta,
    sessionId: meta.sessionId ?? info.sessionId,
    status: 'sent',
    updatedAt: info.at,
    sentAt: info.at,
    sentSessionId: info.sessionId,
    ...(info.messageAt ? { sentMessageAt: info.messageAt } : {}),
  };
}

/**
 * Record that this draft was sent. `content` is the ORIGINAL
 * document-relative markdown, not the rewritten form the transcript
 * carries: the draft stays an editable document.
 */
export async function markPromptDraftSent(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  id: string,
  info: { sessionId: string; content?: string; messageAt?: string },
): Promise<PromptDraft> {
  const before = await requireDraft(files, host, projectId, id);
  const { content: _content, title: _t, hasFiles: _h, fileCount: _f, ...meta } = before;
  await host.validateRecipient?.(projectId, { ...meta, sessionId: info.sessionId });
  const next = sentDraftMeta(meta, {
    sessionId: info.sessionId,
    at: host.now(),
    messageAt: info.messageAt,
  });
  const writes = new Map<string, string>();
  if (info.content !== undefined) writes.set(messagePath(id), info.content);
  writes.set(metaPath(id), metaBytes(next));
  await files.apply({ writes });
  return (await getPromptDraft(files, host, projectId, id))!;
}

/**
 * Stamp the `at` of the persisted user message. Quiet when the draft is
 * gone: the send is accepted before the turn writes its message, so this
 * lands a beat later and nothing gates on it.
 */
export async function stampPromptDraftSentMessageAt(
  files: PromptDraftFiles,
  projectId: string,
  id: string,
  at: string,
): Promise<void> {
  const meta = await readPromptDraftMeta(files, projectId, id);
  if (!meta) return;
  await files.apply({
    writes: new Map([[metaPath(id), metaBytes({ ...meta, sentMessageAt: at })]]),
  });
}

/** "Use again": copy a draft's text and files into a fresh open draft, in one change. */
export async function duplicatePromptDraft(
  files: PromptDraftFiles,
  host: PromptDraftHost,
  projectId: string,
  sourceId: string,
  raw: DuplicatePromptDraftRequest = {},
): Promise<PromptDraft> {
  const options = DuplicatePromptDraftRequestSchema.parse(raw);
  const source = await requireDraft(files, host, projectId, sourceId);
  const sessionId = options.sessionId === undefined ? source.sessionId : options.sessionId;
  await host.validateRecipient?.(projectId, {
    gezelId: source.gezelId,
    sessionId,
    ...(source.taskRef ? { taskRef: source.taskRef } : {}),
    ...(source.craftbookRef ? { craftbookRef: source.craftbookRef } : {}),
  });
  const at = host.now();
  const id = await allocatePromptDraftId(files, host.allocatedAt?.() ?? at);
  const meta: PromptDraftMeta = {
    id,
    projectId,
    gezelId: source.gezelId,
    sessionId,
    ...(source.taskRef ? { taskRef: source.taskRef } : {}),
    ...(source.craftbookRef ? { craftbookRef: source.craftbookRef } : {}),
    ...(source.scope ? { scope: source.scope } : {}),
    ...(source.taskLaunch ? { taskLaunch: duplicatedTaskLaunch(source.taskLaunch) } : {}),
    createdAt: at,
    updatedAt: at,
    status: 'draft',
  };
  const writes = new Map<string, Uint8Array | string>([
    [messagePath(id), source.content],
    [metaPath(id), metaBytes(meta)],
  ]);
  const mkdirs = [filesDir(id)];
  const sourceFiles = filesDir(sourceId);
  for (const entry of await files.tree(sourceFiles)) {
    const destination = `${filesDir(id)}${entry.path.slice(sourceFiles.length)}`;
    if (entry.isDirectory) mkdirs.push(destination);
    else {
      const bytes = await files.readBytes(entry.path);
      if (bytes === null) throw new Error('A draft attachment disappeared while copying');
      writes.set(destination, bytes);
    }
  }
  await files.apply({ mkdirs, writes });
  return (await getPromptDraft(files, host, projectId, id))!;
}

export async function deletePromptDraft(
  files: PromptDraftFiles,
  projectId: string,
  id: string,
): Promise<{ deleted: boolean; meta: PromptDraftMeta | null }> {
  const meta = await readPromptDraftMeta(files, projectId, id);
  if (!meta) return { deleted: false, meta: null };
  await files.apply({ removes: [id] });
  return { deleted: true, meta };
}

/**
 * A thread was deleted. Its sent drafts go with it, because they record a
 * conversation that no longer exists; its unsent ones are detached rather
 * than destroyed, because those words are still the user's.
 */
export function planSessionCleanup(
  drafts: ReadonlyArray<Pick<PromptDraftSummary, 'id' | 'sessionId' | 'status'>>,
  sessionId: string,
): { delete: string[]; detach: string[] } {
  const plan = { delete: [] as string[], detach: [] as string[] };
  for (const draft of drafts) {
    if (draft.sessionId !== sessionId) continue;
    (draft.status === 'sent' ? plan.delete : plan.detach).push(draft.id);
  }
  return plan;
}

/** Sent drafts last sent before `cutoffIso`. Unsent drafts are never swept. */
export function sweepableSentDrafts(
  drafts: ReadonlyArray<Pick<PromptDraftSummary, 'id' | 'status' | 'sentAt' | 'updatedAt'>>,
  cutoffIso: string,
): string[] {
  return drafts
    .filter((draft) => draft.status === 'sent' && (draft.sentAt ?? draft.updatedAt) < cutoffIso)
    .map((draft) => draft.id);
}
