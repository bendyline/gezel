import type { RunRecording, RunRecordingActor, RunRecordingScene } from '@bendyline/gezel';

/**
 * The crew and the plan of a run, read off the whole recording (not just
 * the scenes a cut keeps), so every block of a movie can draw the same
 * cast in the same places and show where the work is.
 */

/** Most members a frame can name legibly. */
const MAX_MEMBERS = 7;

export interface CrewMember {
  id: string;
  actor: RunRecordingActor | undefined;
  name: string;
  role?: string;
  /** Steps of the plan this member owned, in order. */
  steps: string[];
  /** Who handed this member the work (another member's id), when known. */
  fromId?: string;
}

export interface PlanStep {
  stepId: string;
  name: string;
  ownerId?: string;
  completed: boolean;
}

export interface CrewModel {
  /** In order of first appearance: the user (when they asked) first. */
  members: CrewMember[];
  /** The task's steps in the order they ran; empty for a run without a plan. */
  plan: PlanStep[];
}

export function crewModel(recording: RunRecording): CrewModel {
  const actors = new Map(recording.actors.map((actor) => [actor.id, actor]));
  const plan = planOf(recording.scenes, recording.trial?.success !== false);
  const ownerOfStep = new Map(plan.map((step) => [step.stepId, step.ownerId]));

  const order: string[] = [];
  const fromOf = new Map<string, string>();
  let lastActor: string | undefined;
  const meet = (id: string | undefined, from: string | undefined): void => {
    if (!id || order.includes(id)) return;
    const actor = actors.get(id);
    if (id !== 'user' && actor?.kind !== 'gezel') return;
    order.push(id);
    const source = from ?? lastActor;
    if (source && source !== id) fromOf.set(id, source);
  };
  for (const scene of recording.scenes) {
    if (scene.kind === 'user-prompt') {
      meet('user', undefined);
      lastActor ??= 'user';
      continue;
    }
    if (scene.kind === 'delegation') {
      meet(scene.actorId, undefined);
      meet(scene.toActorId, scene.actorId);
      if (scene.actorId) lastActor = scene.actorId;
      continue;
    }
    const id =
      scene.kind === 'step-transition'
        ? (scene.actorId ?? ownerOfStep.get(scene.stepId))
        : scene.actorId;
    meet(id, undefined);
    if (id) lastActor = id;
  }

  const members = order.slice(0, MAX_MEMBERS).map((id): CrewMember => {
    const actor = actors.get(id);
    const fromId = fromOf.get(id);
    return {
      id,
      actor,
      name: actor?.name ?? (id === 'user' ? 'You' : id),
      ...(actor?.role ? { role: actor.role } : {}),
      steps: plan.filter((step) => step.ownerId === id).map((step) => step.name),
      ...(fromId && order.slice(0, MAX_MEMBERS).includes(fromId) ? { fromId } : {}),
    };
  });
  return { members, plan };
}

/**
 * Steps in activation order. The owner is whoever completed it, else
 * whoever it was handed to, else the first gezel to act after it began.
 * In a run that passed, trailing steps that never completed (a craftbook's
 * bookkeeping "Finish") are dropped; in one that did not, a step someone
 * was working on when it stopped stays.
 */
function planOf(scenes: readonly RunRecordingScene[], passed: boolean): PlanStep[] {
  const steps: PlanStep[] = [];
  const byId = new Map<string, PlanStep>();
  let current: PlanStep | undefined;
  for (const scene of scenes) {
    if (scene.kind === 'step-transition') {
      let step = byId.get(scene.stepId);
      if (!step) {
        step = { stepId: scene.stepId, name: scene.stepName ?? scene.stepId, completed: false };
        byId.set(scene.stepId, step);
        steps.push(step);
      }
      if (scene.phase === 'activated') {
        current = step;
        if (scene.actorId && !step.ownerId) step.ownerId = scene.actorId;
      }
      if (scene.phase === 'completed') {
        step.completed = true;
        if (scene.actorId) step.ownerId = scene.actorId;
        if (current === step) current = undefined;
      }
      continue;
    }
    if (current && !current.ownerId && scene.actorId && scene.actorId !== 'user') {
      current.ownerId = scene.actorId;
    }
  }
  // In a run that passed, a step still open at the end is the craftbook's
  // wrap-up, whoever happened to speak after it opened.
  while (steps.length > 1) {
    const last = steps[steps.length - 1]!;
    if (last.completed || (!passed && last.ownerId)) break;
    if (!steps.some((step) => step.completed)) break;
    steps.pop();
  }
  return steps;
}

/** Who is on stage in a scene: the speaker, and for a hand-off its receiver. */
export function activeIds(scene: RunRecordingScene, crew: CrewModel): Set<string> {
  const ids = new Set<string>();
  if (scene.kind === 'user-prompt') ids.add(scene.actorId ?? 'user');
  else if (scene.actorId) ids.add(scene.actorId);
  if (scene.kind === 'delegation') ids.add(scene.toActorId);
  if (scene.kind === 'step-transition' && !scene.actorId) {
    const owner = crew.plan.find((step) => step.stepId === scene.stepId)?.ownerId;
    if (owner) ids.add(owner);
  }
  return ids;
}
