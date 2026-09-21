import { normalizeScriptRefs } from '../schemas/script.js';
import type { ChatSession } from '../schemas/session.js';
import type { PortableStore } from './store.js';
import { taskHookKey } from './tasks.js';

/** A repeated step is a new activation even when its id and owner stay the same. */
export async function portableTaskSessionState(store: PortableStore, session: ChatSession) {
  if (!session.taskRef) return { task: undefined, active: true, restarted: false, prepared: true };
  const task = await store.getTask(session.taskRef);
  const lifecycle = task ? await store.getTaskLifecycle(task.ref) : undefined;
  const restarted = session.stepActivationId !== lifecycle?.activationId;
  const step = task?.craftbook.steps.find((step) => step.id === session.stepId);
  const checkpoints = new Map(lifecycle?.entries.map((entry) => [entry.key, entry]));
  const prepared = normalizeScriptRefs(step?.onEnter).every(
    (script, index) => checkpoints.get(taskHookKey('onEnter', index, script))?.state === 'ok',
  );
  return {
    task,
    restarted,
    prepared,
    active:
      !!task &&
      task.projectId === session.projectId &&
      task.status === 'active' &&
      task.activeStepId === session.stepId &&
      !restarted &&
      prepared,
  };
}

export async function assertPortableTaskSessionActive(store: PortableStore, session: ChatSession) {
  const state = await portableTaskSessionState(store, session);
  if (!state.active)
    throw new Error(
      !state.prepared && !state.restarted
        ? 'This task step’s setup has not finished. Continue from Tasks.'
        : 'The current task step has stopped or changed activation. Continue from Tasks.',
    );
  return state.task;
}
