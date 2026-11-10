import { type Task, isSharedLibraryProject } from '@bendyline/gezel';

const DEFAULT_PROJECT_ID = 'default';

export interface ThreadWorkProjectInput {
  /** The Default thread new work is being started from. */
  sessionId: string;
  tasks: ReadonlyArray<Pick<Task, 'projectId' | 'launchSessionId' | 'requestRef'>>;
  projects: ReadonlyArray<{
    id: string;
    status?: string;
    archived?: boolean;
    properties?: Record<string, string>;
  }>;
}

/**
 * The project work started from a Default thread belongs in when nobody named
 * one: the single project that thread already set up work in.
 *
 * A bakery owner asked the Meester to set up their office, then asked in the
 * same thread for a catering proposal. It ran in Default, away from the
 * project that knows the business, and the document never named the bakery
 * (default/2, 2026-11-09). The project's own prompt context carries its name
 * and about, so the work only has to land there.
 *
 * Undefined when the thread has set up work in no project, or in more than
 * one: which of those the person means is theirs to say. A project the person
 * set aside (read-only or archived) never takes new work this way.
 */
export function threadWorkProject(input: ThreadWorkProjectInput): string | undefined {
  if (!input.sessionId) return undefined;
  const open = new Set(
    input.projects
      .filter(
        (p) =>
          p.id !== DEFAULT_PROJECT_ID &&
          !isSharedLibraryProject(p) &&
          !p.archived &&
          p.status !== 'inactive' &&
          p.status !== 'readonly',
      )
      .map((p) => p.id),
  );
  const started = new Set<string>();
  for (const task of input.tasks) {
    const fromThread =
      task.requestRef?.sessionId === input.sessionId || task.launchSessionId === input.sessionId;
    if (fromThread && open.has(task.projectId)) started.add(task.projectId);
  }
  return started.size === 1 ? [...started][0] : undefined;
}
