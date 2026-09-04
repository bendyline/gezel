import { type Task, type TaskNoteAuthor, createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { TaskManager } from '../tasks/manager.js';

/**
 * The boekwachter's control surface: a service-installed system task that
 * makes background indexing visible, pausable, and auditable in the ordinary
 * Tasks UI. The task never dispatches to a model (assignee is the user, so
 * the runner skips it) — the actual work runs in the service loops
 * (WorkspaceIndexManager, IndexEnrichmentManager, ProjectDigestGenerator),
 * which consult {@link IndexingJobControl.isPaused} each tick. Progress lands
 * as task notes, giving the job an activity trail without a chat session.
 */

const log = createLogger('indexing-job');

/** Stable sentinel title — inline craftbooks get generated ids, so the title
 *  is the durable "already installed" marker (same as the oversight task). */
export const INDEXING_JOB_TITLE = 'Boekwachter: workspace indexing & enrichment';
export const INDEXING_JOB_ID = 'boekwachter-indexing';
const STEP_ID = 'index';
const PAUSE_CACHE_MS = 15_000;

/**
 * Where the job task lives, and the installed task if it exists. New
 * installs home it in the shared library project — the boekwachter is that
 * project's resident gezel, and a brand-new Default project's task list must
 * not lead with a system job (2026-09-02 UX review). Installs that already
 * carry the task in `default` keep it there: honoring it in place beats a
 * migration that renumbers a task the user may have paused or annotated.
 * With no shared project (machine-engine role, tests), `default` remains
 * the home so the control surface always exists somewhere.
 */
async function resolveJobHome(
  store: Store,
): Promise<{ homeId: string; installed: { projectId: string; task: Task } | null }> {
  const shared = await store.sharedProjectId().catch(() => null);
  const candidates = shared && shared !== 'default' ? [shared, 'default'] : ['default'];
  for (const projectId of candidates) {
    const tasks = await store.listProjectTasks(projectId).catch(() => []);
    const task = tasks.find((t) => t.title === INDEXING_JOB_TITLE);
    if (task) return { homeId: shared ?? 'default', installed: { projectId, task } };
  }
  return { homeId: shared ?? 'default', installed: null };
}

export async function ensureIndexingJobTask(store: Store, tasks: TaskManager): Promise<void> {
  const { homeId, installed: found } = await resolveJobHome(store);
  const configuredId = (await store.readConfig().catch(() => null))?.boekwachterGezelId;
  const installed = found?.task;
  if (installed) {
    const origin = {
      kind: 'system-job' as const,
      jobId: INDEXING_JOB_ID,
      ...(configuredId ? { managedByGezelId: configuredId } : {}),
    };
    if (
      installed.assignee.kind !== 'user' ||
      (installed.status !== 'active' && installed.status !== 'paused') ||
      JSON.stringify(installed.origin) !== JSON.stringify(origin)
    ) {
      await store.writeTask({
        ...installed,
        // Keep the system loop out of TaskRunner while surfacing the real
        // gezel through provenance in the UI.
        assignee: { kind: 'user' },
        status: installed.status === 'paused' ? 'paused' : 'active',
        origin,
        updatedAt: new Date().toISOString(),
      });
    }
    return;
  }
  try {
    await tasks.create(
      homeId,
      {
        title: INDEXING_JOB_TITLE,
        description:
          'System job: the boekwachter indexes project workspaces in the background — symbols and search while idle, AI summaries, folder rollups, and weekly digests in bulk during Night Shift. Pausing this task stops the AI passes; the cheap structural scan keeps search working. Sources of truth are never modified.',
        assignee: { kind: 'user' },
        steps: [
          {
            id: STEP_ID,
            name: 'Index & enrich workspaces',
            prompt:
              'System-run: workspace scans, enrichment summaries, area rollups, and weekly digests execute inside the service itself — no model turn. This task is the control surface: pause it to stop the AI indexing passes.',
            next: STEP_ID,
          },
        ],
        entryStepId: STEP_ID,
        createdBy: { kind: 'user' },
      },
      {
        origin: {
          kind: 'system-job',
          jobId: INDEXING_JOB_ID,
          ...(configuredId ? { managedByGezelId: configuredId } : {}),
        },
      },
    );
    log.info('installed boekwachter indexing job task');
  } catch (err) {
    log.warn('failed to install indexing job task:', err instanceof Error ? err.message : err);
  }
}

export class IndexingJobControl {
  private cachedPaused = false;
  private cachedAt = 0;

  constructor(
    private readonly store: Store,
    private readonly tasks?: TaskManager,
  ) {}

  /** Read (with a short cache) whether the job task is paused. Missing task
   *  or read failure means "not paused" — indexing must not silently stop
   *  because the control surface is absent. */
  async isPaused(): Promise<boolean> {
    const now = Date.now();
    if (now - this.cachedAt < PAUSE_CACHE_MS) return this.cachedPaused;
    const { installed } = await resolveJobHome(this.store);
    this.cachedPaused = installed?.task.status === 'paused';
    this.cachedAt = now;
    return this.cachedPaused;
  }

  /** Drop the pause cache (tests). */
  invalidate(): void {
    this.cachedAt = 0;
  }

  /** Append a progress note to the job task — the visible activity trail. */
  async note(text: string): Promise<void> {
    if (!this.tasks) return;
    try {
      const { installed } = await resolveJobHome(this.store);
      if (!installed) return;
      const author = await this.noteAuthor();
      await this.tasks.appendNote(installed.projectId, installed.task.num, {
        text,
        author,
        stepId: STEP_ID,
      });
    } catch (err) {
      log.warn('progress note failed:', err instanceof Error ? err.message : err);
    }
  }

  private async noteAuthor(): Promise<TaskNoteAuthor> {
    const configuredId = (await this.store.readConfig().catch(() => null))?.boekwachterGezelId;
    if (!configuredId) return { kind: 'user' };
    const gezel = await this.store.getGezel(configuredId).catch(() => null);
    return gezel ? { kind: 'gezel', gezelId: gezel.id, name: gezel.name } : { kind: 'user' };
  }
}
