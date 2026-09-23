import type { ChatSession } from './schemas/session.js';
import type { Task, TaskAssignee, TaskCraftbookStep } from './schemas/task.js';

/**
 * Pin one gezel as the owner of every step (generalist mode). For each step
 * that is not explicitly a human's (`assignee.kind === 'user'`) and not
 * explicitly another gezel's, drop any role-resolved `suggestedGezelId` and
 * set `assignee` to the owner. `suggestedRole` is deliberately KEPT: it still
 * carries the step's capability floor, research intent and gate kit, and
 * `maybeResolveStepRole` short-circuits on the explicit assignee, so no
 * specialist is recruited. Mutates in place, like `interpolateStepsContext`.
 *
 * This is the solo-project `collapseToGezelId` transform (mcp `server.ts`)
 * minus its overwrite of user steps — a human-in-the-loop step stays one.
 */
export function pinCraftbookOwner(steps: TaskCraftbookStep[], ownerGezelId: string): void {
  for (const step of steps) {
    if (step.assignee?.kind === 'user') continue;
    if (step.assignee?.kind === 'gezel' && step.assignee.gezelId !== ownerGezelId) continue;
    delete step.suggestedGezelId;
    step.assignee = { kind: 'gezel', gezelId: ownerGezelId };
  }
}

/**
 * The prompt did not fit the model's context. Covers the desktop engines and
 * every on-device provider: the native llama.cpp bridge, Apple's system model
 * (`CONTEXT_LIMIT`), and Android's ML Kit model, which reports by message only.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === 'context-overflow' || code === 'CONTEXT_LIMIT') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ran out of working memory|exceeds the available context size|prompt plus requested output exceeds the context|exceeds apple on-device ai's context budget|too long for (?:apple|android's) on-device ai/i.test(
    msg,
  );
}

/**
 * True when a session's most recent turn ended because its accumulated
 * context was the problem — a compaction-loop halt (the per-send compaction
 * budget ran out without progress) or a context overflow. Resuming such a
 * transcript replays the failure; a generalist retry starts fresh instead.
 */
export function sessionContextPoisoned(record: ChatSession): boolean {
  if (record.lastTurnError && isContextOverflowError(record.lastTurnError)) return true;
  for (let i = record.messages.length - 1; i >= 0; i -= 1) {
    const message = record.messages[i]!;
    if (message.role === 'assistant') return message.synthetic === 'context-loop-halt';
  }
  return false;
}

/** Same step-first ownership on both hosts; an explicit human handoff stays human. */
export function taskActiveAssignee(task: Task): TaskAssignee {
  const step = task.craftbook.steps.find((candidate) => candidate.id === task.activeStepId);
  return (
    step?.assignee ??
    (step?.suggestedGezelId ? { kind: 'gezel', gezelId: step.suggestedGezelId } : task.assignee)
  );
}

export interface TaskSessionContinuation {
  task: Task;
  gezelId: string;
  providerName: string;
  model?: string;
  roleBasedNameOnlyMode?: boolean;
  nightShift?: boolean;
}
/** Transcript compatibility is independent of platform/native engine ownership. */
export function taskTranscriptCompatible(
  prior: ChatSession,
  next: Omit<TaskSessionContinuation, 'task' | 'gezelId'>,
): boolean {
  return (
    prior.providerName === next.providerName &&
    (next.model === undefined || prior.model === next.model) &&
    Boolean(prior.nightShift) === Boolean(next.nightShift) &&
    Boolean(prior.roleBasedNameOnlyMode) === Boolean(next.roleBasedNameOnlyMode)
  );
}
/** Called only after the previous foreground turn has settled. It grants no authority. */
export function taskSessionCanContinue(prior: ChatSession, next: TaskSessionContinuation): boolean {
  const owner = taskActiveAssignee(next.task);
  return (
    next.task.status === 'active' &&
    !!next.task.activeStepId &&
    owner.kind === 'gezel' &&
    owner.gezelId === next.gezelId &&
    !prior.archived &&
    !prior.turnStartedAt &&
    prior.taskRef === next.task.ref &&
    prior.projectId === next.task.projectId &&
    prior.gezelId === next.gezelId &&
    (next.task.executionMode === 'generalist' || prior.stepId !== next.task.activeStepId) &&
    taskTranscriptCompatible(prior, next) &&
    !sessionContextPoisoned(prior)
  );
}
