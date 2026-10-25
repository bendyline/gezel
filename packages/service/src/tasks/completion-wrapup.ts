import { randomUUID } from 'node:crypto';
import {
  type ChatMessage,
  type ChatSession,
  type Question,
  type ReferencedFile,
  type Task,
  type TaskDeliverable,
  deliverableFormatNoun,
  isOwnerLaunchedCompletion,
  outputsWithDeliverableFirst,
  taskDeliverableCandidates,
  taskPersonName,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';
import { type FigureReview, renderFigureReview } from './figure-review.js';

/**
 * The owner's wrap-up when a task they launched from a chat finishes.
 *
 * Without it, the last thing in the thread was the worker's tool receipt —
 * `Completed step "finish" on default/2. Active step is now "(none)". Task
 * is now complete (terminal step).` — and nothing told the owner the work
 * was done or where it was. The wrap-up is composed here rather than by a
 * model turn: it must be true, it must be instant, and it must name the real
 * files, so it lists what the task's sessions actually wrote.
 */

const ARTIFACT_WRITERS: ReadonlySet<string> = new Set(['write_artifact']);
const WORKSPACE_WRITERS: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'insert_at_marker',
  'apply_patch',
  // How a book lands a binary deliverable in the workspace (the PowerPoint
  // book's deck). Its receipt carries the destination as `path`.
  'copy_artifact_to_workspace',
]);

/** Most outputs a wrap-up names; the task page has the rest. */
export const WRAP_UP_MAX_FILES = 6;

/**
 * Whether a finished task earns a wrap-up. Only work the owner asked for in
 * a chat does: scheduled hosts, night-shift runs, system jobs and fanout
 * children settle without one (the host's own wrap-up covers its crew).
 */
export function wantsWrapUp(task: Task, outcome: 'complete' | 'canceled'): boolean {
  return isOwnerLaunchedCompletion(task, outcome);
}

function canonicalArtifactPath(path: string): string {
  let out = path.trim().replace(/^\.?\/+/, '');
  while (/^artifacts\/+/i.test(out)) out = out.replace(/^artifacts\/+/i, '');
  return out;
}

/**
 * Files the task's sessions wrote, newest write first, one entry per file.
 * Task inputs are the owner's own files, never an output.
 */
export function collectTaskOutputs(
  sessions: readonly ChatSession[],
  opts: { inputsPrefix?: string } = {},
): ReferencedFile[] {
  const writes: Array<{ at: string; file: ReferencedFile }> = [];
  for (const session of sessions) {
    for (const message of session.messages) {
      for (const call of message.toolCalls ?? []) {
        if (!call.success) continue;
        const kind = ARTIFACT_WRITERS.has(call.name)
          ? 'artifact'
          : WORKSPACE_WRITERS.has(call.name)
            ? 'workspace'
            : null;
        if (!kind) continue;
        const raw = call.paths && call.paths.length > 0 ? call.paths : call.path ? [call.path] : [];
        for (const p of raw) {
          const path = kind === 'artifact' ? canonicalArtifactPath(p) : p.replace(/^\.?\/+/, '');
          if (!path) continue;
          if (kind === 'artifact' && opts.inputsPrefix && path.startsWith(opts.inputsPrefix)) {
            continue;
          }
          writes.push({ at: call.at ?? message.at, file: { kind, path } });
        }
      }
    }
  }
  writes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const seen = new Set<string>();
  const out: ReferencedFile[] = [];
  for (const { file } of writes) {
    const key = `${file.kind}:${file.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

export type TaskOutputStore = Pick<
  Store,
  | 'listSessions'
  | 'getSession'
  | 'listProjectArtifactsRecursive'
  | 'projectArtifactSize'
  | 'statProjectWorkspacePath'
  | 'statProjectArtifactPath'
>;

/**
 * What a task has made so far, newest write first: files its sessions wrote,
 * then anything else in its artifacts folder. A file written and later
 * removed is not something it made. Read by the wrap-up and by the owner's
 * review card, which shows the work under review.
 */
export async function loadTaskOutputs(
  store: TaskOutputStore,
  task: Task,
): Promise<ReferencedFile[]> {
  const artifactDir = task.artifactDir ?? `tasks/${task.num}`;
  const inputsPrefix = `${artifactDir}/inputs/`;
  const summaries = await store.listSessions({ projectId: task.projectId }).catch(() => []);
  const sessions: ChatSession[] = [];
  for (const summary of summaries) {
    if (summary.taskRef !== task.ref) continue;
    const session = await store.getSession(summary.gezelId, summary.id).catch(() => null);
    if (session) sessions.push(session);
  }
  const inFolder = (
    await store
      .listProjectArtifactsRecursive(task.projectId, { subpath: artifactDir })
      .catch(() => [])
  )
    .filter((entry) => !entry.isDirectory && !entry.path.startsWith(inputsPrefix))
    .map((entry): ReferencedFile => ({ kind: 'artifact', path: entry.path }));
  const outputs: ReferencedFile[] = [];
  const seen = new Set<string>();
  for (const file of [...collectTaskOutputs(sessions, { inputsPrefix }), ...inFolder]) {
    const key = `${file.kind}:${file.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exists =
      file.kind === 'artifact'
        ? (await store.projectArtifactSize(task.projectId, file.path).catch(() => null)) !== null
        : (
            await store
              .statProjectWorkspacePath(task.projectId, file.path)
              .catch(() => ({ kind: 'missing' as const }))
          ).kind === 'file';
    if (exists) outputs.push(file);
  }
  return outputs;
}

/** Most deliverable candidates stat'd per task; a book names a handful. */
const MAX_DELIVERABLE_PROBES = 16;

/**
 * The file the task hands its owner, or null while it has made none. Only
 * a file that exists qualifies: a book that promised `deck.pptx` and never
 * published it has no deliverable, whatever its steps say.
 */
export async function resolveTaskDeliverable(
  store: TaskOutputStore,
  task: Task,
  outputs: readonly ReferencedFile[],
): Promise<TaskDeliverable | null> {
  const candidates = taskDeliverableCandidates(task, outputs).slice(0, MAX_DELIVERABLE_PROBES);
  for (const file of candidates) {
    const stat =
      file.kind === 'artifact'
        ? await store
            .statProjectArtifactPath(task.projectId, file.path)
            .catch(() => ({ kind: 'missing' as const }))
        : await store
            .statProjectWorkspacePath(task.projectId, file.path)
            .catch(() => ({ kind: 'missing' as const }));
    if (stat.kind !== 'file') continue;
    return {
      kind: file.kind,
      path: file.path,
      ...('size' in stat && stat.size !== undefined ? { bytes: stat.size } : {}),
      ...('mtime' in stat && stat.mtime ? { modifiedAt: stat.mtime } : {}),
    };
  }
  return null;
}

/**
 * Say where a task's deliverable lives and how to open it: its own project
 * (a wrap-up can land in another project's thread, and opened the file there)
 * and the project's Output page when the file is data that page reads. A
 * trip's `trip.json` is opened as the trip board, not as JSON.
 */
export async function placeTaskDeliverable(
  store: Pick<Store, 'getProject'>,
  catalog: Pick<CatalogService, 'get'>,
  task: Task,
  deliverable: TaskDeliverable,
): Promise<TaskDeliverable> {
  const placed: TaskDeliverable = { ...deliverable, projectId: task.projectId };
  if (deliverable.kind !== 'workspace') return placed;
  try {
    const type = (await store.getProject(task.projectId))?.projectType;
    if (!type) return placed;
    const manifest = (await catalog.get('project-type', type.id, undefined, type.version))
      ?.manifest;
    if (manifest?.kind !== 'project-type') return placed;
    const read = manifest.pages?.reads?.some(
      (r) => r.source === 'workspace' && r.path === deliverable.path,
    );
    return read ? { ...placed, view: 'output-page' } : placed;
  } catch {
    return placed;
  }
}

/** What a task has made: the deliverable, and every output with it first. */
export async function loadTaskResult(
  store: TaskOutputStore,
  task: Task,
): Promise<{ deliverable: TaskDeliverable | null; outputs: ReferencedFile[] }> {
  const outputs = await loadTaskOutputs(store, task);
  const deliverable = await resolveTaskDeliverable(store, task, outputs).catch(() => null);
  return { deliverable, outputs: outputsWithDeliverableFirst(outputs, deliverable) };
}

/**
 * The first output a question card can preview. Cards read their document as
 * text, so a deck or an image would render as bytes; those stay in the list.
 */
export function previewableArtifact(files: readonly ReferencedFile[]): string | undefined {
  return files.find(
    (file) => file.kind === 'artifact' && /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(file.path),
  )?.path;
}

function fileLabel(file: ReferencedFile): string {
  return file.kind === 'artifact' ? `\`${file.path}\`` : `\`${file.path}\` (in the project folder)`;
}

function sameFile(a: ReferencedFile, b: ReferencedFile): boolean {
  return a.kind === b.kind && a.path.toLowerCase() === b.path.toLowerCase();
}

/**
 * The Updates card that sits beside the wrap-up until the owner dismisses it.
 * It lives in the wrap-up thread's project so "Open in chat" lands on the
 * wrap-up; the preview is attached only when that project also holds the
 * artifact, since `documentPath` resolves against the card's project.
 */
export function taskFinishedQuestion(opts: {
  task: Task;
  thread: { id: string; gezelId: string; projectId: string };
  outputs: readonly ReferencedFile[];
  at: string;
  figures?: FigureReview | null;
  deliverable?: ReferencedFile | null;
}): Question {
  const { task, thread, deliverable } = opts;
  const outputs = outputsWithDeliverableFirst(opts.outputs, deliverable);
  // A board's data file is not a thing to hand over: `trip.json` under
  // "is finished" read as a filename for a trip.
  const board = Boolean(deliverable && 'view' in deliverable && deliverable.view === 'output-page');
  const shown = board ? [] : outputs.slice(0, 3);
  const name = taskPersonName(task);
  const lines = [
    board
      ? `${name ? `**${name}** is` : 'It is'} ready to look at on the project's Output page.`
      : name
        ? `**${name}** is finished.`
        : deliverable
          ? `Your ${deliverableFormatNoun(deliverable.path)} is finished.`
          : 'The work is finished.',
  ];
  if (shown.length > 0) {
    lines.push(
      '',
      ...shown.map((file) =>
        deliverable && sameFile(file, deliverable)
          ? `- **\`${file.path}\`**`
          : `- \`${file.path}\``,
      ),
    );
    if (outputs.length > shown.length) lines.push(`- …and ${outputs.length - shown.length} more`);
  }
  const checks = renderFigureReview(opts.figures, 'Before you send anything, check:');
  if (checks.length > 0) lines.push('', ...checks);
  // The card previews its document as text. When the deliverable is a deck
  // or a page, previewing the outline instead would present a working paper
  // as the result, so the card shows no preview at all.
  const previewFrom = deliverable ? [deliverable] : outputs;
  const preview =
    thread.projectId === task.projectId ? previewableArtifact(previewFrom) : undefined;
  return {
    id: randomUUID(),
    projectId: thread.projectId,
    gezelId: thread.gezelId,
    sessionId: thread.id,
    prompt: lines.join('\n'),
    choices: ['Dismiss'],
    allowWriteIn: false,
    multiSelect: false,
    taskRef: task.ref,
    ...(preview ? { documentPath: preview } : {}),
    intent: { kind: 'task-finished', taskRef: task.ref },
    createdAt: opts.at,
  };
}

/** Longest question a wrap-up quotes; a longer one is the maker's to explain. */
const MAKER_QUESTION_MAX_CHARS = 280;

/**
 * The question the maker ended on, from the last two sentences of their
 * final reply, or undefined when they asked nothing.
 */
export function closingQuestion(text: string): string | undefined {
  const plain = text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = (plain.match(/[^.!?]+[.!?]+/g) ?? []).map((part) => part.trim());
  for (const sentence of sentences.slice(-2).reverse()) {
    if (sentence.endsWith('?')) {
      return sentence.length <= MAKER_QUESTION_MAX_CHARS ? sentence : undefined;
    }
  }
  return undefined;
}

/**
 * What the maker asked at the end of their work, read from the task's own
 * threads. A Reisleider that planned one day of a week asked whether to go
 * on; the owner, told the plan was done, never saw the question.
 */
export async function loadMakerQuestion(
  store: Pick<Store, 'listSessions' | 'getSession'>,
  task: Task,
  makerGezelId: string,
): Promise<string | undefined> {
  const summaries = await store.listSessions({ projectId: task.projectId }).catch(() => []);
  let latest: { at: string; content: string } | undefined;
  for (const summary of summaries) {
    if (summary.taskRef !== task.ref || summary.gezelId !== makerGezelId) continue;
    const session = await store.getSession(summary.gezelId, summary.id).catch(() => null);
    for (const message of session?.messages ?? []) {
      if (message.role !== 'assistant' || message.synthetic || !message.content?.trim()) continue;
      if (!latest || message.at > latest.at) latest = { at: message.at, content: message.content };
    }
  }
  return latest ? closingQuestion(latest.content) : undefined;
}

/**
 * The message itself: warm, short, and only true things. With a deliverable
 * it names that file by what it is ("Your PDF for **Invoices** is ready") and
 * leaves the path to the card that closes the bubble; the working files the
 * task made on the way stay on the task. The bakery's wrap-up had listed
 * `pdf/task-2/report.md` and two outlines under the book's name. A board is
 * "ready to look at", never "finished": its kickoff ends at a first draft.
 * The maker's open question is passed on in their words. What the next model
 * turn needs (the ref and the paths) rides in {@link wrapUpModelNote}.
 */
export function composeTaskWrapUp(
  task: Task,
  outputs: readonly ReferencedFile[],
  figures?: FigureReview | null,
  deliverable?: (ReferencedFile & { view?: 'output-page' }) | null,
  ask?: { name: string; question: string } | null,
): string {
  // A project type's page reads the file; the page is what to look at.
  const board = deliverable?.view === 'output-page';
  const name = taskPersonName(task);
  const lines = [wrapUpHeadline(name, deliverable, board)];
  if (!deliverable) {
    const shown = outputs.slice(0, WRAP_UP_MAX_FILES);
    if (shown.length === 1) {
      lines.push('', `Here's what it made: ${fileLabel(shown[0]!)}`);
    } else if (shown.length > 1) {
      lines.push('', "Here's what it made:", '', ...shown.map((file) => `- ${fileLabel(file)}`));
      const more = outputs.length - shown.length;
      if (more > 0) lines.push('', `…and ${more} more on the task page.`);
    }
  }
  const checks = renderFigureReview(figures, 'Before you send anything, check:');
  if (checks.length > 0) lines.push('', ...checks);
  if (ask) {
    lines.push(
      '',
      `${ask.name} asks: “${ask.question}”`,
      '',
      deliverable
        ? `Answer ${ask.name} with **Make changes**, or open it to see it first.`
        : `Answer ${ask.name} in the project's chat, or tell me what you would like.`,
    );
    return lines.join('\n');
  }
  lines.push(
    '',
    board
      ? 'Open the project to see it, or tell me what you would like changed.'
      : deliverable
        ? 'Open it to review, or tell me what you would like changed.'
        : outputs.length > 0
          ? 'Open any of them to review, or tell me what you would like changed.'
          : 'The task page has every step. Tell me if you would like anything changed.',
  );
  return lines.join('\n');
}

function wrapUpHeadline(
  name: string | undefined,
  deliverable: ReferencedFile | null | undefined,
  board: boolean,
): string {
  if (board) {
    return `${name ? `**${name}** is` : 'It is'} ready to look at on the project's Output page.`;
  }
  if (deliverable) {
    const noun = deliverableFormatNoun(deliverable.path);
    return name ? `Your ${noun} for **${name}** is ready.` : `Your ${noun} is ready.`;
  }
  return name ? `All done — **${name}** is finished.` : 'All done — the work is finished.';
}

/**
 * The facts a wrap-up leaves to its card and the task page, for the model
 * reading the thread back: the task ref, the deliverable and the other files.
 * Derived from the message's own fields, so a rebuilt session replays the
 * same bytes every time.
 */
export function wrapUpModelNote(message: {
  referencedTasks?: readonly string[] | undefined;
  referencedFiles?: readonly ReferencedFile[] | undefined;
  deliverable?: ReferencedFile | undefined;
}): string | null {
  const ref = message.referencedTasks?.[0];
  const deliverable = message.deliverable;
  const others = (message.referencedFiles ?? []).filter(
    (file) => !deliverable || !sameFile(file, deliverable),
  );
  const parts: string[] = [];
  if (ref) parts.push(`Task ${ref}`);
  if (deliverable) parts.push(`deliverable ${fileLabel(deliverable)}`);
  if (others.length > 0) parts.push(`other files: ${others.map(fileLabel).join(', ')}`);
  return parts.length > 0 ? `[${parts.join('; ')}]` : null;
}

/** `content` with {@link wrapUpModelNote} after it when `message` is a wrap-up. */
export function withWrapUpNote(
  message: Pick<ChatMessage, 'synthetic' | 'referencedTasks' | 'referencedFiles' | 'deliverable'>,
  content: string,
): string {
  if (message.synthetic !== 'task-wrapup') return content;
  const note = wrapUpModelNote(message);
  return note ? `${content}\n\n${note}` : content;
}
