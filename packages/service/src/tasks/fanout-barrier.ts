/**
 * The post-fanout barrier: a spawn host's step after its fanout waits for the
 * crew it spawned, because that step's gate reads files only the crew writes.
 *
 * The barrier counted only ACTIVE children, and a pause is not a settle, so a
 * child that paused for help fell out of it. With no one left active, the
 * stuck-step sweep read the host's step as stalled and re-drove it into a gate
 * only the paused child could satisfy, three times over half an hour, before
 * pausing it with a card that never named the child. A host whose crew has
 * nobody working and someone paused now pauses for help itself, naming them.
 * Try again on its card restarts the paused children and keeps the host at
 * the barrier (`retry.ts`); canceling a child settles it, which is how a
 * person lets the run go on without that part.
 */
import {
  type Task,
  type TaskCraftbookStep,
  createLogger,
  taskEffectiveStatus,
} from '@bendyline/gezel';
import type { TaskManager } from './manager.js';

const log = createLogger('tasks');

type HostShape = Pick<Task, 'spawnsCraftbook' | 'cron'>;

/** The host's current step is the one after its fanout, so it waits on its crew. */
export function waitsOnFanoutCrew(
  host: Pick<Task, 'spawnsCraftbook'>,
  step: Pick<TaskCraftbookStep, 'spawnFanout'> | undefined,
): boolean {
  return Boolean(host.spawnsCraftbook && step && !step.spawnFanout);
}

/**
 * Whether a paused child holds this host. A schedule host's children are
 * separate runs, not a crew it waits on, and pausing a schedule host stops
 * its schedule for good.
 */
export function pausesForPausedCrew(
  host: HostShape,
  step: Pick<TaskCraftbookStep, 'spawnFanout'> | undefined,
): boolean {
  return waitsOnFanoutCrew(host, step) && !host.cron;
}

/** A child cloned from a host's spawn template that the host waits on. */
export function isFanoutShard(
  child: Pick<Task, 'parentTaskRef'>,
  parent: (HostShape & Pick<Task, 'ref'>) | null | undefined,
): boolean {
  return Boolean(
    parent && child.parentTaskRef === parent.ref && parent.spawnsCraftbook && !parent.cron,
  );
}

export interface FanoutCrew {
  active: Task[];
  paused: Task[];
}

/**
 * The host's unsettled children by their OWN status. A paused host masks its
 * children as paused, and that pause is the host's, not theirs.
 */
export async function fanoutCrew(
  tasks: Pick<TaskManager, 'listChildren'>,
  hostRef: string,
): Promise<FanoutCrew> {
  const children = await tasks.listChildren(hostRef).catch(() => [] as Task[]);
  return {
    active: children.filter((child) => child.status === 'active'),
    paused: children.filter((child) => child.status === 'paused'),
  };
}

export type FanoutBarrierVerdict =
  | { kind: 'open' }
  | { kind: 'held'; active: number }
  /** The crew left is paused for help; the host was paused for it. */
  | { kind: 'paused-crew'; paused: number };

type BarrierTasks = Pick<
  TaskManager,
  'listChildren' | 'get' | 'appendNote' | 'setStatus' | 'emitNeedsHelp'
>;

/**
 * One reading of the barrier for every entrance to a host's post-fanout step:
 * the activation hook (which the last child's settle re-fires), the stuck-step
 * sweep, and a child's own pause.
 */
export async function checkFanoutBarrier(
  tasks: BarrierTasks,
  host: Task,
  step: TaskCraftbookStep | undefined,
): Promise<FanoutBarrierVerdict> {
  if (!step || !waitsOnFanoutCrew(host, step)) return { kind: 'open' };
  const crew = await fanoutCrew(tasks, host.ref);
  if (crew.active.length > 0) return { kind: 'held', active: crew.active.length };
  if (crew.paused.length === 0 || !pausesForPausedCrew(host, step)) return { kind: 'open' };
  await pauseHostForPausedCrew(tasks, host, step.id, crew.paused);
  return { kind: 'paused-crew', paused: crew.paused.length };
}

/** Hosts being paused right now, so two entrances racing write one note. */
const pausing = new Set<string>();

/**
 * Pause a host whose crew has nobody left working and someone paused for
 * help. Returns whether this call paused it; a host already paused, moved
 * on, or no longer active is left alone.
 */
export async function pauseHostForPausedCrew(
  tasks: Pick<TaskManager, 'get' | 'appendNote' | 'setStatus' | 'emitNeedsHelp'>,
  host: Pick<Task, 'projectId' | 'num' | 'ref'>,
  stepId: string,
  paused: readonly Pick<Task, 'ref' | 'title'>[],
): Promise<boolean> {
  if (paused.length === 0 || pausing.has(host.ref)) return false;
  pausing.add(host.ref);
  try {
    const current = await tasks.get(host.projectId, host.num);
    if (
      !current ||
      current.status !== 'active' ||
      taskEffectiveStatus(current) !== 'active' ||
      current.activeStepId !== stepId
    ) {
      return false;
    }
    const stepName = current.craftbook.steps.find((step) => step.id === stepId)?.name ?? stepId;
    await tasks
      .appendNote(host.projectId, host.num, {
        text: pausedCrewNote(stepName, stepId, paused),
        author: { kind: 'user' },
        stepId,
      })
      .catch(() => {});
    const pausedHost = await tasks.setStatus(host.projectId, host.num, 'paused');
    await tasks.emitNeedsHelp({
      projectId: host.projectId,
      task: pausedHost,
      stepId,
      reason: 'step_stalled',
      detail: `Step "${stepName}" is waiting on ${paused.length === 1 ? 'a part' : `${paused.length} parts`} of this run that paused for help: ${paused.map((child) => child.ref).join(', ')}.`,
    });
    log.warn(
      `[fanout] ${host.ref} step "${stepId}": ${paused.length} child(ren) paused for help and none still working (${paused.map((child) => child.ref).join(', ')}) — paused the host for help`,
    );
    return true;
  } finally {
    pausing.delete(host.ref);
  }
}

export function pausedCrewNote(
  stepName: string,
  stepId: string,
  paused: readonly Pick<Task, 'ref' | 'title'>[],
): string {
  const one = paused.length === 1;
  const list = paused.map((child) => `- \`${child.ref}\` "${child.title}"`).join('\n');
  return [
    '# Waiting on a part of this run that stopped — paused for help',
    '',
    `Step "${stepName}" (\`${stepId}\`) needs every part of this run to finish, and ${one ? 'one part has' : `${paused.length} parts have`} paused for help:`,
    '',
    list,
    '',
    `Try again restarts the paused ${one ? 'part' : 'parts'}, and this step goes on once ${one ? 'it finishes' : 'they finish'}. To go on without a part, cancel it, then choose Try again here.`,
  ].join('\n');
}
