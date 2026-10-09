import type { StepGate, Task } from '@bendyline/gezel';
import { REPORT_ACTION_AUTHORING_GUIDE, createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { TaskManager } from '../tasks/manager.js';

const log = createLogger('night-shift');

/**
 * Stable title used to detect the already-installed bundled task. Inline
 * craftbooks get a generated id, so the title is the durable sentinel.
 */
const OVERSIGHT_TITLE = 'Night-shift oversight: project review';
const OVERSIGHT_STEP_ID = 'oversight';
const OVERSIGHT_REPORT_PATH = 'night-shift-report.md';

/**
 * `advanceWhen` alone drives the auto-advance watcher; it is not consulted
 * when the assignee calls `advance_task_step` itself, and `completeStep`
 * only rejects a step that carries a real `gate`. Without one, a run that
 * never wrote the report advanced anyway and re-armed for the next night —
 * observed at attempt 7 on a Meester whose roster had no write channel
 * (see the orchestration-clamp fix in chat/session-tool-surface.ts), which
 * talked itself into "the report was already written in a prior attempt".
 *
 * The floor is deliberately existence + substance. There is no
 * freshness check kind, so this cannot tell tonight's report from last
 * night's; `advanceWhen.requireChange` covers that for the watcher path
 * only. Catching the absent deliverable is what closes the observed hole.
 */
const OVERSIGHT_GATE: StepGate = {
  at: 'completion',
  checks: [
    {
      kind: 'minBytes',
      file: OVERSIGHT_REPORT_PATH,
      bytes: 200,
      artifact: true,
    },
  ],
  // A perpetual nightly task should fail visibly and cheaply rather than
  // spend the night looping: exhausting the budget pauses it for the user.
  maxAttempts: 3,
};

/**
 * What `ask_user_question` answers the review instead of posting a card. The
 * tool is a workflow safety tool that no step policy may remove, so the
 * runtime declines it here. On 2026-10-08 a re-driven run asked the person
 * how to settle a mismatch between two runtime guards: a question about the
 * review's own plumbing that only a developer could answer.
 */
export const OVERSIGHT_QUESTION_DECLINED =
  'Nobody is awake to answer during the nightly review, so this question was not posted. Write what blocked you in the report, then finish the run with advance_task_step.';

const OVERSIGHT_PROMPT = `You are running the nightly **Meester oversight** review. The machine is idle and this is low-priority background work — be thorough but do not kick any project back into action.

For EACH active project:
1. Read its \`about.md\` and \`missionObjectives.md\` (the documents tools), plus recent history/artifacts, to gauge progress toward the stated objectives.
2. Note where the project is drifting, stuck, or where its structure could be improved — craftbook structure, project layout, a stale \`about.md\`, recurring problems that deserve a documented solution.

**The Default project is a deliberate catch-all and gets a narrower review.** Unrelated one-off items live there by design, so review only the state of its artifacts and loose work items — stale, half-finished, superseded, misfiled, or grown big enough to deserve a project of their own. Do NOT critique its structure, coherence, or objectives, do NOT judge its items against each other, and do NOT report its \`about.md\` or \`missionObjectives.md\` as thin, generic, or missing: they say "this is a grab bag" on purpose. This report itself lives in the Default project — its own scaffolding is not a finding.

Then write ONE consolidated report to \`artifacts/${OVERSIGHT_REPORT_PATH}\` (overwrite any prior copy). Structure it as a list of concrete, approvable recommendations grouped by project, each with: what to change, why, and (where useful) a short ready-to-apply draft (e.g. a rewritten about.md paragraph). These are suggestions for the user to approve in the morning — do NOT apply them, do NOT message voormen, do NOT start or advance tasks.

## Actionable recommendations

${REPORT_ACTION_AUTHORING_GUIDE}

Every action block MUST name its target project via \`projectId\` (this report lives in the Default project but recommends work elsewhere). For apply-edits, write each sidecar diff under \`night-shift-report/edits/\` in THIS project's artifacts. Only emit an action block when the recommendation is genuinely one-click-ready; prose recommendations without a block are fine.

Suggest changes that genuinely move projects toward their objectives; do not gild the lily — if a project is healthy, say so in a line rather than inventing busywork.

Nobody is awake to answer questions, so never ask the user anything. If something blocks you, say what in the report and finish.

When the report is written, call \`advance_task_step\` to finish this run. The task re-arms automatically for tomorrow night.`;

/**
 * The bundled review is the runtime's own work, not the person's: it never
 * files a "paused for help" card and never asks them anything.
 */
export function isNightShiftOversightTask(task: Pick<Task, 'projectId' | 'title'>): boolean {
  return task.projectId === 'default' && task.title === OVERSIGHT_TITLE;
}

/** The bundled oversight task, when installed. */
export async function findNightShiftOversightTask(
  store: Pick<Store, 'listProjectTasks'>,
): Promise<Task | null> {
  const tasks = await store.listProjectTasks('default').catch(() => []);
  return tasks.find((t) => t.title === OVERSIGHT_TITLE) ?? null;
}

/**
 * Start each night's review from nothing. The step loops back to itself when a
 * run finishes, so the next night's dispatch found last night's session, still
 * holding a transcript in which the report was already written, and resumed it
 * as an interrupted run. It read the old report back and advanced on it, and
 * the gate (the report exists and is long enough) passed on yesterday's file
 * (2026-10-08). So before the night's first dispatch: archive the review's
 * sessions (without a memory summary, which would be a long model turn of its
 * own), and date last night's report aside, so only a report written tonight
 * can satisfy the gate. A night whose review already ran is left alone.
 */
export async function prepareReviewForNight(
  deps: {
    store: Pick<
      Store,
      | 'listProjectTasks'
      | 'listSessions'
      | 'readProjectArtifact'
      | 'writeProjectArtifact'
      | 'deleteProjectArtifact'
    >;
    archiveSession: (sessionId: string) => Promise<unknown>;
  },
  windowKey: string,
): Promise<void> {
  const task = await findNightShiftOversightTask(deps.store);
  if (!task || task.nightShift?.lastRunDay === windowKey) return;
  let archived = 0;
  for (const session of await deps.store.listSessions({ projectId: 'default' })) {
    if (session.taskRef !== task.ref || session.archived) continue;
    await deps.archiveSession(session.id);
    archived++;
  }
  const previous = await deps.store.readProjectArtifact('default', OVERSIGHT_REPORT_PATH);
  if (previous !== null) {
    const day = task.nightShift?.lastRunDay ?? 'earlier';
    await deps.store.writeProjectArtifact('default', `night-shift-report-${day}.md`, previous);
    await deps.store.deleteProjectArtifact('default', OVERSIGHT_REPORT_PATH);
  }
  log.info(
    `[night-shift] review ready for ${windowKey}: ${archived} earlier session(s) archived${previous !== null ? ', last report dated aside' : ''}`,
  );
}

/**
 * Ensure the always-present bundled night-shift task exists: a single
 * perpetual, self-looping step assigned to the Meester that produces a
 * daily project-oversight report. Flagged `{ enabled, onceADay }` so it
 * runs at most once per calendar day, and only while Night Shift is ON.
 *
 * Idempotent — guards on the sentinel title in the Default project. When
 * the task already exists but its step prompt or deliverable declaration
 * predates the current constants, it is UPDATED IN PLACE (the installer
 * used to early-return forever, which meant shipping a new prompt never
 * reached existing installs).
 */
export async function ensureNightShiftOversightTask(
  store: Store,
  tasks: TaskManager,
): Promise<void> {
  const config = await store.readConfig().catch(() => null);
  const meesterId = config?.meesterGezelId;
  if (!meesterId) return; // no meester yet; ensureDefaultMeester runs first, so rare

  const installed = await findNightShiftOversightTask(store);
  if (installed) {
    await migrateOversightTask(store, installed.num).catch((err) => {
      log.warn(
        '[night-shift] failed to update oversight task in place:',
        err instanceof Error ? err.message : err,
      );
    });
    await releasePausedReview(store, tasks, installed.num).catch((err) => {
      log.warn(
        '[night-shift] failed to resume the paused oversight task:',
        err instanceof Error ? err.message : err,
      );
    });
    await withdrawReviewQuestions(store, installed.ref).catch((err) => {
      log.warn(
        '[night-shift] failed to withdraw the oversight task questions:',
        err instanceof Error ? err.message : err,
      );
    });
    return;
  }

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
          // Deliverable declaration: feeds the morning review's report
          // discovery AND lets the run self-advance on the written file.
          advanceWhen: { file: OVERSIGHT_REPORT_PATH, artifact: true, requireChange: true },
          // Enforced on `advance_task_step`, unlike `advanceWhen` above.
          gate: OVERSIGHT_GATE,
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

/**
 * Update-in-place migration for an already-installed oversight task:
 * refresh the step prompt + deliverable declaration when they differ from
 * the current constants. Writes the task record directly (the step-update
 * request surface doesn't cover advanceWhen edits on self-looping inline
 * steps) — a targeted, idempotent stamp.
 */
async function migrateOversightTask(store: Store, num: number): Promise<void> {
  const task = await store.readTask('default', num);
  if (!task) return;
  const step = task.craftbook.steps.find((s) => s.id === OVERSIGHT_STEP_ID);
  if (!step) return;
  const promptCurrent = step.prompt === OVERSIGHT_PROMPT;
  const advanceCurrent =
    step.advanceWhen?.file === OVERSIGHT_REPORT_PATH && step.advanceWhen?.artifact === true;
  // Installs that predate the completion gate carry a step that advances on
  // an unwritten report; stamping it is the whole point of the in-place
  // migration existing.
  const gateCurrent = JSON.stringify(step.gate) === JSON.stringify(OVERSIGHT_GATE);
  if (promptCurrent && advanceCurrent && gateCurrent) return;
  const steps = task.craftbook.steps.map((s) =>
    s.id === OVERSIGHT_STEP_ID
      ? {
          ...s,
          prompt: OVERSIGHT_PROMPT,
          advanceWhen: {
            file: OVERSIGHT_REPORT_PATH,
            artifact: true,
            requireChange: true,
          },
          gate: OVERSIGHT_GATE,
        }
      : s,
  );
  await store.writeTask({
    ...task,
    craftbook: { ...task.craftbook, steps },
    updatedAt: new Date().toISOString(),
  });
  log.info('[night-shift] oversight task prompt/deliverable updated in place');
}

/**
 * Resume a paused review. It runs at boot and when each window opens, so a
 * review that paused (its gate spent, a stalled step, a restart budget) gets a
 * fresh try the next night with no one asked. The morning card says it will
 * retry; the person never has to press Resume on the runtime's own work
 * (2026-10-08). A review that keeps failing costs one night's attempts a
 * night, which is what it costs when it works.
 */
async function releasePausedReview(store: Store, tasks: TaskManager, num: number): Promise<void> {
  const task = await store.readTask('default', num);
  if (!task || task.status !== 'paused') return;
  await tasks.resetStepRecoveryBudget('default', num, OVERSIGHT_STEP_ID, {
    redriveCount: 0,
    clearGateAttempts: true,
    clearRestartResumes: true,
  });
  await tasks.setStatus('default', num, 'active');
  log.info(`[night-shift] resumed ${task.ref} for the next window`);
}

/**
 * Close every open question the review left: its own "paused for help" cards
 * from earlier builds, and anything a run asked before the question tool was
 * taken away. Closed silently: none of them were the person's to answer.
 */
async function withdrawReviewQuestions(store: Store, taskRef: string): Promise<void> {
  const at = new Date().toISOString();
  let closed = 0;
  for (const question of await store.listProjectQuestions('default')) {
    if (question.answer) continue;
    const ownCard = question.intent?.kind === 'task-paused' && question.intent.taskRef === taskRef;
    if (!ownCard && question.taskRef !== taskRef) continue;
    await store.writeQuestion({ ...question, answer: { silentSkip: true, at } });
    closed++;
  }
  if (closed > 0) log.info(`[night-shift] withdrew ${closed} question(s) left by ${taskRef}`);
}
