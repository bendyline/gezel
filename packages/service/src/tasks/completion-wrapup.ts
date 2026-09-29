import { randomUUID } from 'node:crypto';
import type { ChatSession, Question, ReferencedFile, Task } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

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
]);

/** Most outputs a wrap-up names; the task page has the rest. */
export const WRAP_UP_MAX_FILES = 6;

/**
 * Whether a finished task earns a wrap-up. Only work the owner asked for in
 * a chat does: scheduled hosts, night-shift runs, system jobs and fanout
 * children settle without one (the host's own wrap-up covers its crew).
 */
export function wantsWrapUp(task: Task, outcome: 'complete' | 'canceled'): boolean {
  if (outcome !== 'complete') return false;
  if (!task.launchSessionId) return false;
  if (task.parentTaskRef || task.cron || task.nightShift) return false;
  if (task.origin?.kind === 'system-job') return false;
  return true;
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
}): Question {
  const { task, thread, outputs } = opts;
  const shown = outputs.slice(0, 3);
  const lines = [`**${task.title}** is finished.`];
  if (shown.length > 0) {
    lines.push('', ...shown.map((file) => `- \`${file.path}\``));
    if (outputs.length > shown.length) lines.push(`- …and ${outputs.length - shown.length} more`);
  }
  const preview = thread.projectId === task.projectId ? previewableArtifact(outputs) : undefined;
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

/** The message itself: warm, short, and only true things. */
export function composeTaskWrapUp(task: Task, outputs: readonly ReferencedFile[]): string {
  const lines = [`All done — **${task.title}** is finished.`];
  const shown = outputs.slice(0, WRAP_UP_MAX_FILES);
  if (shown.length === 1) {
    lines.push('', `Here's what it made: ${fileLabel(shown[0]!)}`);
  } else if (shown.length > 1) {
    lines.push('', "Here's what it made:", '', ...shown.map((file) => `- ${fileLabel(file)}`));
    const more = outputs.length - shown.length;
    if (more > 0) lines.push('', `…and ${more} more on the task page (${task.ref}).`);
  }
  lines.push(
    '',
    shown.length > 0
      ? 'Open any of them to review, or tell me what you would like changed.'
      : `The task page (${task.ref}) has every step. Tell me if you would like anything changed.`,
  );
  return lines.join('\n');
}
