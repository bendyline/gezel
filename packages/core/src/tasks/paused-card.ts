import type { TaskPausedReason } from '../schemas/question.js';

const PAUSE_REASON_TEXT: Record<TaskPausedReason, string> = {
  gate_exhausted: "The work didn't pass its checks after several tries.",
  gate_plateau: 'The work stopped getting closer to passing its checks.',
  gate_unsatisfiable:
    "This step needs to change files in the project folder, and Gezel isn't allowed to write there.",
  gate_infrastructure:
    "Gezel couldn't check this step's work, so it stopped instead of guessing. The problem is in Gezel or the plan, not the work, so trying again may not help.",
  step_exit_infrastructure:
    "Gezel couldn't finish wrapping up this step. The problem is in Gezel or the plan, not the work, so trying again may not help.",
  step_stalled: "Gezel tried this step several times and couldn't finish it.",
  budget_exhausted: 'It ran longer than it is allowed to without finishing.',
};

/** Why a task paused, as one sentence a person can read; the tracker shows it under its line. */
export function taskPausedReasonText(reason: TaskPausedReason): string {
  return PAUSE_REASON_TEXT[reason];
}

/**
 * What a "paused for help" card says to the person. Each pause also writes
 * a note for whoever looks closer, in the gezel's terms: a gate verdict, a
 * script error. That detail once reached the card verbatim and read
 * "checks[0] minBytes.file ({{workPath}}) still contains an unresolved
 * template placeholder" (squisq/22, 2026-10-31).
 */
export function taskPausedCardText(opts: {
  title: string;
  stepName?: string;
  reason: TaskPausedReason;
}): string {
  const where = opts.stepName ? ` at "${opts.stepName}"` : '';
  return `"${opts.title}" stopped${where}. ${PAUSE_REASON_TEXT[opts.reason]}${TASK_POINTER}`;
}

const TASK_POINTER = ' Open the task to see what happened.';

/**
 * The card's sentence for a row that already shows the task's title and a
 * way to open it: `Stopped at "Write the report". The work didn't pass…`.
 * In Activity the full sentence said the title twice and pointed at a link
 * one line above it. Text this module did not write is returned unchanged.
 */
export function taskPausedCardDetail(text: string): string {
  const opened = /^".*" stopped(?= at "|\. )/.exec(text);
  if (!opened) return text;
  const rest = text.slice(opened[0].length);
  return `Stopped${rest.endsWith(TASK_POINTER) ? rest.slice(0, -TASK_POINTER.length) : rest}`;
}
