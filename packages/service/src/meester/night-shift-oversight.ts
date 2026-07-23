import { createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { TaskManager } from '../tasks/manager.js';

const log = createLogger('night-shift');

/**
 * Stable title used to detect the already-installed bundled task. Inline
 * craftbooks get a generated id, so the title is the durable sentinel.
 */
const OVERSIGHT_TITLE = 'Night-shift oversight: project review';
const OVERSIGHT_STEP_ID = 'oversight';

const OVERSIGHT_PROMPT = `You are running the nightly **Meester oversight** review. The machine is idle and this is low-priority background work — be thorough but do not kick any project back into action.

For EACH active project:
1. Read its \`about.md\` and \`missionObjectives.md\` (the documents tools), plus recent history/artifacts, to gauge progress toward the stated objectives.
2. Note where the project is drifting, stuck, or where its structure could be improved — craftbook structure, project layout, a stale \`about.md\`, recurring problems that deserve a documented solution.

Then write ONE consolidated report to \`artifacts/night-shift-report.md\` (overwrite any prior copy). Structure it as a list of concrete, approvable recommendations grouped by project, each with: what to change, why, and (where useful) a short ready-to-apply draft (e.g. a rewritten about.md paragraph). These are suggestions for the user to approve in the morning — do NOT apply them, do NOT message voormen, do NOT start or advance tasks.

Suggest changes that genuinely move projects toward their objectives; do not gild the lily — if a project is healthy, say so in a line rather than inventing busywork.

When the report is written, call \`advance_task_step\` to finish this run. The task re-arms automatically for tomorrow night.`;

/**
 * Ensure the always-present bundled night-shift task exists: a single
 * perpetual, self-looping step assigned to the Meester that produces a
 * daily project-oversight report. Flagged `{ enabled, onceADay }` so it
 * runs at most once per calendar day, and only while Night Shift is ON.
 *
 * Idempotent — guards on the sentinel title in the Default project so it
 * isn't duplicated across restarts.
 */
export async function ensureNightShiftOversightTask(
  store: Store,
  tasks: TaskManager,
): Promise<void> {
  const config = await store.readConfig().catch(() => null);
  const meesterId = config?.meesterGezelId;
  if (!meesterId) return; // no meester yet; ensureDefaultMeester runs first, so rare

  const existing = await store.listProjectTasks('default').catch(() => []);
  if (existing.some((t) => t.title === OVERSIGHT_TITLE)) return;

  try {
    await tasks.create('default', {
      title: OVERSIGHT_TITLE,
      description:
        'Nightly Meester review of every active project against its objectives, producing an approvable report of suggested changes.',
      assignee: { kind: 'gezel', gezelId: meesterId },
      steps: [
        {
          id: OVERSIGHT_STEP_ID,
          name: 'Review active projects',
          prompt: OVERSIGHT_PROMPT,
          // Self-loop: completing the step re-activates it, re-arming for
          // the next night. The `onceADay` guard (lastRunDay) holds it
          // from re-dispatching until tomorrow.
          next: OVERSIGHT_STEP_ID,
        },
      ],
      entryStepId: OVERSIGHT_STEP_ID,
      nightShift: { enabled: true, onceADay: true },
      createdBy: { kind: 'user' },
    });
    log.info('[night-shift] installed bundled meester oversight task');
  } catch (err) {
    log.warn(
      '[night-shift] failed to install oversight task:',
      err instanceof Error ? err.message : err,
    );
  }
}
