import type { RequestTrack } from '../schemas/request-track.js';
import type { Task } from '../schemas/task.js';
import { taskPersonName } from '../task-person-name.js';

/**
 * Name each request's work the way the person would: the title of the task
 * it is on, unless that is only the plan's name. The finished-work card leads
 * with it, so a proposal reads "One-page catering proposal for Harbor Books"
 * where it used to read `report.docx`.
 */
export function withRequestTitles(
  tracks: readonly RequestTrack[],
  tasks: readonly Task[],
): RequestTrack[] {
  const byRef = new Map(tasks.map((task) => [task.ref, task]));
  return tracks.map((track) => {
    const task = track.actual ? byRef.get(track.actual.taskRef) : undefined;
    const title = task ? taskPersonName(task) : undefined;
    return title ? { ...track, title } : track;
  });
}
