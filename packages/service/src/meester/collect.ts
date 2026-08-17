import { createHash } from 'node:crypto';
import {
  type HistoryEvent,
  type HistoryEventKind,
  type Project,
  type Task,
  isSharedLibraryProject,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import type { ActivityTracker } from '../fs/activity-tracker.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';

/**
 * Cross-project survey shared by the meester's ambient generators (the
 * status report and the ambient dashboard): every ambient-work project
 * with its recent activity, open tasks, pending questions, history
 * events, and chat titles, capped per project so the prompt stays flat.
 */

export const MAX_EVENTS_PER_PROJECT = 15;
export const MAX_TASKS_PER_PROJECT = 8;
export const MAX_SESSIONS_PER_PROJECT = 5;
export const EVENT_WINDOW_MS = 48 * 60 * 60_000;

export interface ProjectContext {
  project: Project;
  lastActivityAt: string | null;
  voormanName: string | null;
  openTasks: Task[];
  pendingQuestions: number;
  events: HistoryEvent[];
  sessionTitles: string[];
}

export interface CollectProjectContextsDeps {
  store: Store;
  history: HistoryManager;
  activity: ActivityTracker;
}

export interface CollectProjectContextsOptions {
  now: Date;
  /**
   * Event kinds invisible to this caller — always its own generated
   * kind, or every run would see "new activity" it produced itself and
   * the input hash would never converge (the digest-generator lesson).
   */
  excludeEventKinds: readonly HistoryEventKind[];
}

export async function collectProjectContexts(
  deps: CollectProjectContextsDeps,
  opts: CollectProjectContextsOptions,
): Promise<ProjectContext[]> {
  const projects = await deps.store.listProjects().catch(() => [] as Project[]);
  // The shared library is a reference shelf, not a jobsite: it has no
  // voorman, no progress to chase, and an ambient check-in saying so
  // every idle period is pure noise. Deliberate task work filed there
  // still runs — only these ambient surveys skip it.
  const ambient = projects.filter((p) => projectAllowsAmbientWork(p) && !isSharedLibraryProject(p));
  const from = new Date(opts.now.getTime() - EVENT_WINDOW_MS).toISOString();
  const out: ProjectContext[] = [];
  for (const project of ambient) {
    const [lastActivityAt, tasks, questions, rawEvents, sessions] = await Promise.all([
      deps.activity.lastActivityAt(project.id),
      deps.store.listProjectTasks(project.id).catch(() => [] as Task[]),
      deps.store.listProjectQuestions(project.id).catch(() => []),
      deps.history
        .listEvents({ projectId: project.id, from, limit: MAX_EVENTS_PER_PROJECT * 2 })
        .catch(() => [] as HistoryEvent[]),
      deps.store.listSessions({ projectId: project.id }).catch(() => []),
    ]);
    const voorman = project.voormanGezelId
      ? await deps.store.getGezel(project.voormanGezelId).catch(() => null)
      : null;
    out.push({
      project,
      lastActivityAt,
      voormanName: voorman?.name ?? null,
      openTasks: tasks
        .filter((t) => t.status === 'active' || t.status === 'paused' || t.status === 'draft')
        .slice(0, MAX_TASKS_PER_PROJECT),
      pendingQuestions: questions.filter((q) => !q.answer).length,
      events: rawEvents
        .filter((e) => !opts.excludeEventKinds.includes(e.kind))
        .slice(0, MAX_EVENTS_PER_PROJECT),
      sessionTitles: sessions
        .slice()
        .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
        .slice(0, MAX_SESSIONS_PER_PROJECT)
        .map((s) => s.title),
    });
  }
  return out;
}

/**
 * Change fingerprint over what the prompt actually sees. Two runs over
 * an unchanged workshop hash identically and skip the second LLM call.
 */
export function hashProjectContexts(candidates: ProjectContext[]): string {
  const lines = candidates.flatMap((c) => [
    `${c.project.id}:${c.lastActivityAt ?? ''}`,
    ...c.openTasks.map((t) => `${t.ref}:${t.status}`),
    ...c.events.map((e) => e.id),
  ]);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** One markdown section per project — the shared prompt-input body. */
export function renderProjectContextSections(candidates: ProjectContext[]): string[] {
  return candidates.map((c) => {
    const lines: string[] = [`## Project "${c.project.name}" (id: ${c.project.id})`];
    if (c.project.description) lines.push(c.project.description);
    if (c.voormanName) lines.push(`Voorman: ${c.voormanName}`);
    if (c.lastActivityAt) lines.push(`Last activity: ${c.lastActivityAt}`);
    if (c.pendingQuestions > 0) {
      lines.push(`${c.pendingQuestions} question(s) waiting on the user.`);
    }
    if (c.openTasks.length > 0) {
      lines.push('Open tasks:', ...c.openTasks.map((t) => `- [${t.status}] ${t.ref} ${t.title}`));
    }
    if (c.events.length > 0) {
      lines.push('Recent activity:', ...c.events.map((e) => `- ${e.at.slice(0, 16)} ${e.summary}`));
    }
    if (c.sessionTitles.length > 0) {
      lines.push('Recent chats:', ...c.sessionTitles.map((t) => `- ${t}`));
    }
    return lines.join('\n');
  });
}
