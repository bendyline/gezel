import { isEngagementAllowed } from '../engagement.js';
import type { ScriptRef } from '../schemas/script.js';
import {
  CreateTaskRequestSchema,
  type Task,
  type TaskCraftbookStep,
  UpdateTaskRequestSchema,
} from '../schemas/task.js';
import { roleToolNames } from '../tools/access.js';
import { applyStepToolPolicy } from '../tools/step-policy.js';
import type { PortableScriptTaskContext } from './script-host.js';
import type { PortableStore } from './store.js';
import { assertPortableTaskSessionActive } from './task-authority.js';
import { evaluatePortableTaskGate } from './task-gates.js';
import type { PortableTaskRunner } from './task-routes.js';
import { taskActiveAssignee } from './tasks.js';

export interface PortableScriptTaskActions {
  create(context: PortableScriptTaskContext, input: unknown): Promise<Task>;
  update(context: PortableScriptTaskContext, ref: string, input: unknown): Promise<Task>;
  advance(context: PortableScriptTaskContext, ref: string, next?: string): Promise<unknown>;
}
/** Existing product task transitions, reached only through the script capability dispatcher. */
export function createPortableScriptTaskActions(
  store: PortableStore,
  tasks: PortableTaskRunner,
): PortableScriptTaskActions {
  const check = (context: PortableScriptTaskContext) => {
    if (context.signal.aborted) throw new Error('Script execution cancelled');
  };
  const taskFor = async (context: PortableScriptTaskContext, raw: string) => {
    const ref = raw.includes('/') ? raw : `${context.projectId}/${raw}`;
    const task = await store.getTask(ref);
    if (!task || task.projectId !== context.projectId)
      throw new Error('Task is outside this project');
    return task;
  };
  const authorize = async (
    context: PortableScriptTaskContext,
    method: 'create_task' | 'update_task' | 'advance_task_step',
    task?: Task,
  ) => {
    check(context);
    await context.authorizeMethod?.(
      method === 'create_task'
        ? 'task.create'
        : method === 'update_task'
          ? 'task.update'
          : 'task.advance',
    );
    const project = await store.getProject(context.projectId);
    if (
      !project ||
      project.archived ||
      project.status === 'readonly' ||
      project.status === 'inactive'
    )
      throw new Error('This project does not accept task changes');
    const trigger = context.trigger;
    if (trigger?.kind === 'step')
      throw new Error(
        'Task fields and progression cannot change inside a lifecycle or gate script. Use task notes and the hook’s auto-advance output.',
      );
    if (trigger?.kind === 'manual') return undefined;
    if (trigger?.kind !== 'chat')
      throw new Error('Task mutation requires a user action or a current script session');
    if (!isEngagementAllowed(await store.readConfig())) throw new Error('AI engagement is off');
    const session = await store.getSession(trigger.gezelId, trigger.sessionId);
    if (!session || session.projectId !== context.projectId)
      throw new Error('The script session is out of scope');
    const current = await assertPortableTaskSessionActive(store, session);
    const step = current?.craftbook.steps.find((item) => item.id === session.stepId);
    if (session.taskRef && (!task || task.ref !== session.taskRef))
      throw new Error('Change only the current task from this conversation');
    const gezel = await store.getGezel(trigger.gezelId);
    if (!gezel) throw new Error('The script gezel is unavailable');
    if (!applyStepToolPolicy(roleToolNames(gezel.role, project.mode), step)?.has(method))
      throw new Error(`Tool ${method} is unavailable to this gezel`);
    if (task && method === 'advance_task_step') {
      const assignee = taskActiveAssignee(task);
      if (assignee.kind === 'user') throw new Error('This step awaits the user');
      if (assignee.gezelId !== gezel.id && project.voormanGezelId !== gezel.id)
        throw new Error('Only the active step assignee or project lead can advance this task');
    }
    check(context);
    return session;
  };
  return {
    async create(context, input) {
      const session = await authorize(context, 'create_task');
      if (input && typeof input === 'object' && Object.hasOwn(input, 'projectId'))
        throw new Error('Create tasks only in the script project');
      const request = CreateTaskRequestSchema.parse(input);
      if (request.dispatchEntry)
        throw new Error(
          'Create the task without dispatchEntry, then start it after this script finishes',
        );
      return tasks.create(
        context.projectId,
        {
          ...request,
          createdBy: session ? { kind: 'gezel', gezelId: session.gezelId } : { kind: 'user' },
          launchSessionId: session?.id,
        },
        async () => {
          await authorize(context, 'create_task');
          check(context);
        },
      );
    },
    async update(context, ref, input) {
      const task = await taskFor(context, ref);
      const session = await authorize(context, 'update_task', task);
      const patch = UpdateTaskRequestSchema.strict().parse(input);
      check(context);
      return tasks.update(task.ref, patch, session?.stepId);
    },
    async advance(context, ref, next) {
      const task = await taskFor(context, ref);
      await authorize(context, 'advance_task_step', task);
      if (!task.activeStepId) throw new Error('This task has no active step');
      const runScript = async (
        current: Task,
        step: TaskCraftbookStep,
        moment: 'onEnter' | 'onExit' | 'gate',
        script: ScriptRef,
        signal: AbortSignal,
      ) => {
        await authorize(context, 'advance_task_step', await taskFor(context, ref));
        if (!context.runTaskScript)
          throw new Error('Task completion scripts require the isolated child executor');
        return context.runTaskScript({
          scriptName: script.name,
          scope: script.scope,
          inputs: script.inputs,
          trigger: {
            kind: 'step',
            taskRef: current.ref,
            stepId: step.id,
            moment: moment === 'gate' ? 'gate' : moment === 'onEnter' ? 'enter' : 'exit',
          },
          signal,
        });
      };
      const result = await tasks.complete(task.ref, task.activeStepId, next, false, {
        signal: context.signal,
        authorize: async () => {
          await authorize(context, 'advance_task_step', await taskFor(context, ref));
        },
        runScript,
        evaluateGate: (current, step, signal) =>
          evaluatePortableTaskGate(store, current, step, (script, owner, part) =>
            runScript(owner, part, 'gate', script, signal),
          ),
      });
      return { status: result.gate?.decision === 'reject' ? 'held' : 'advanced', ...result };
    },
  };
}
