/**
 * Pure XP math for gezel growth. XP measures accumulated LEARNING, not
 * activity: deduplicated kind-tagged memories (preferences and decisions
 * encode learning, so they outweigh facts; status notes barely count),
 * distilled lessons, completed task work, and delivered consultations
 * (daily-capped so chatter can't farm them). Message counts never enter.
 *
 * Signals are lifetime totals with a per-field RATCHET: the engine
 * recomputes from the live corpus and takes max(stored, recomputed), so
 * memory compaction merging/discarding old entries never lowers XP.
 */

import type { GrowthSignals, Task } from '@bendyline/gezel';
import type { MemoryKind } from '../memory/daily-markdown.js';

export const XP_WEIGHTS = {
  memory: { pref: 6, decision: 6, fact: 3, status: 1 } satisfies Record<MemoryKind, number>,
  lessonsUpdate: 15,
  stepCompleted: 10,
  taskCompleted: 25,
  consultationDelivered: 2,
} as const;

/** Anti-gaming: at most this many consultations count per calendar day. */
export const CONSULT_DAILY_CAP = 5;

export interface XpInputs {
  /** Gezel-scope memory entries only — project scope has no author attribution. */
  memoryEntries: ReadonlyArray<{ kind: MemoryKind }>;
  /** Count of `memory.lessons-updated` history events for this gezel. */
  lessonsUpdates: number;
  /** Completed craftbook steps attributed to this gezel. */
  completedSteps: number;
  /** Completed tasks assigned to this gezel. */
  completedTasks: number;
  /** `gezel.message.delivered` events grouped by YYYY-MM-DD day. */
  consultationsByDay: ReadonlyMap<string, number>;
}

export function computeSignals(inputs: XpInputs): GrowthSignals {
  let memoryXp = 0;
  for (const e of inputs.memoryEntries) {
    memoryXp += XP_WEIGHTS.memory[e.kind] ?? XP_WEIGHTS.memory.fact;
  }
  let consults = 0;
  for (const count of inputs.consultationsByDay.values()) {
    consults += Math.min(count, CONSULT_DAILY_CAP);
  }
  return {
    memoryXp,
    lessonsXp: inputs.lessonsUpdates * XP_WEIGHTS.lessonsUpdate,
    taskXp:
      inputs.completedSteps * XP_WEIGHTS.stepCompleted +
      inputs.completedTasks * XP_WEIGHTS.taskCompleted,
    consultXp: consults * XP_WEIGHTS.consultationDelivered,
  };
}

/** Per-field max(old, new) — recomputation can only raise XP, never lower it. */
export function ratchetSignals(prev: GrowthSignals, next: GrowthSignals): GrowthSignals {
  return {
    memoryXp: Math.max(prev.memoryXp, next.memoryXp),
    lessonsXp: Math.max(prev.lessonsXp, next.lessonsXp),
    taskXp: Math.max(prev.taskXp, next.taskXp),
    consultXp: Math.max(prev.consultXp, next.consultXp),
  };
}

export function totalXp(signals: GrowthSignals): number {
  return signals.memoryXp + signals.lessonsXp + signals.taskXp + signals.consultXp;
}

/**
 * Count completed steps + completed tasks attributed to a gezel from
 * task records. Used instead of `task.step.completed` history events,
 * which carry no gezelId. A step credits the gezel when it has
 * `completedAt` and is assigned to them (explicit `assignee`, or
 * `suggestedGezelId` when no explicit assignee was set).
 */
export function countTaskWork(
  tasks: ReadonlyArray<Task>,
  gezelId: string,
): { completedSteps: number; completedTasks: number } {
  let completedSteps = 0;
  let completedTasks = 0;
  for (const task of tasks) {
    if (
      task.status === 'complete' &&
      task.assignee.kind === 'gezel' &&
      task.assignee.gezelId === gezelId
    ) {
      completedTasks++;
    }
    for (const step of task.craftbook.steps) {
      if (!step.completedAt) continue;
      const assignedTo =
        step.assignee?.kind === 'gezel'
          ? step.assignee.gezelId
          : step.assignee === undefined
            ? step.suggestedGezelId
            : undefined;
      if (assignedTo === gezelId) completedSteps++;
    }
  }
  return { completedSteps, completedTasks };
}
