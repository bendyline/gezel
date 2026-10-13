import type { ChatSession } from './schemas/session.js';
import type { Task } from './schemas/task.js';

type ScheduleFields = Pick<Task, 'cron' | 'nightShift'>;

/**
 * Whether a task runs because a schedule fired (a Night Shift task, a cron
 * host, or a child a cron host spawned) rather than because someone asked
 * for it just now. Pass the host for a spawned child: the child itself
 * carries no cron of its own.
 */
export function isScheduledTaskRun(task: ScheduleFields, host?: ScheduleFields | null): boolean {
  const scheduled = (t: ScheduleFields) => Boolean(t.cron || t.nightShift?.enabled);
  return scheduled(task) || (host ? scheduled(host) : false);
}

/**
 * Whether a chat session is a scheduled run's working session. Home's
 * conversation leaves these out: the person never asked for them there, and
 * on a new install a failed overnight review would otherwise replace the
 * Meester's welcome. Older Night Shift sessions only carry `nightShift`.
 */
export function isScheduledRunSession(
  session: Pick<ChatSession, 'nightShift' | 'scheduledRun'>,
): boolean {
  return session.scheduledRun === true || session.nightShift === true;
}
