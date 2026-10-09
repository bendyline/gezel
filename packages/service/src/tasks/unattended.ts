import type { Task } from '@bendyline/gezel';
import {
  OVERSIGHT_QUESTION_DECLINED,
  isNightShiftOversightTask,
} from '../meester/night-shift-oversight.js';

type UnattendedTask = Pick<Task, 'projectId' | 'title' | 'origin' | 'nightShift' | 'parentTaskRef'>;

/**
 * The night fix planner's host: filed for open Boekwachter issues, once a
 * night. A person's own "fix with AI" run carries the same origin but no
 * night-shift binding.
 */
function isNightFixHost(task: UnattendedTask): boolean {
  return task.origin?.kind === 'boekwachter-issue' && task.nightShift?.onceADay === true;
}

/**
 * The runtime's own unattended night work: the nightly review, and the fix
 * sweeps the night planner files with the shards they spawn. Nobody asked for
 * any of it by name and nobody is awake while it runs, so it never asks the
 * person anything and the Meester's status line never turns it into chores.
 * A fix sweep asked for write access at night (2026-10-09), and the status
 * line drafted follow-up tasks about paused sweeps (2026-10-08, 2026-10-09).
 *
 * A shard copies its host's night binding but not its origin, so pass the
 * parent (`parentTaskRef`) when there is one.
 */
export function unattendedNightWork(
  task: UnattendedTask,
  parent?: UnattendedTask | null,
): 'review' | 'night-fix' | null {
  if (isNightShiftOversightTask(task)) return 'review';
  if (task.nightShift?.enabled !== true) return null;
  if (isNightFixHost(task)) return 'night-fix';
  if (task.parentTaskRef && parent && isNightFixHost(parent)) return 'night-fix';
  return null;
}

const NIGHT_WORK_QUESTION_DECLINED =
  'Nobody is awake to answer during the night, so this question was not posted. Leave out what you cannot settle without the person, say why in a task note, and carry on with the rest of the step.';

/** What `ask_user_question` returns to unattended night work instead of posting. */
export function unattendedQuestionDecline(kind: 'review' | 'night-fix'): string {
  return kind === 'review' ? OVERSIGHT_QUESTION_DECLINED : NIGHT_WORK_QUESTION_DECLINED;
}
