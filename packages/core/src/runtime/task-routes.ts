import { z } from 'zod';
import {
  type TaskExecutionMode,
  effectiveGeneralistModeSetting,
  resolveTaskExecutionMode,
} from '../generalist-mode.js';
import type { Craftbook } from '../schemas/craftbook.js';
import { type ScriptRef, type ScriptRun, normalizeScriptRefs } from '../schemas/script.js';
import {
  AppendTaskNoteRequestSchema,
  CompleteStepRequestSchema,
  CreateTaskRequestSchema,
  SetTaskStatusRequestSchema,
  type Task,
  type TaskCraftbookStep,
  TaskStatusSchema,
  UpdateTaskRequestSchema,
} from '../schemas/task.js';
import { scriptShouldAutoAdvance } from '../scripts/predicates.js';
import { type AwakeBudget, acquireSuspendMonitor, createAwakeTimeout } from '../suspend-clock.js';
import { json } from './http/json.js';
import type { PortableStore } from './store.js';
import { taskActiveAssignee } from './tasks.js';
import type { PortableTaskGateResult } from './tasks.js';

export interface PortableTaskRunnerOptions {
  store: PortableStore;
  runStep(task: Task, activationId?: string): Promise<void>;
  cancelStep?(): Promise<void>;
  canRun?(): void;
  evaluateGate?(
    task: Task,
    step: TaskCraftbookStep,
    signal: AbortSignal,
  ): Promise<PortableTaskGateResult>;
  runScript?(
    task: Task,
    step: TaskCraftbookStep,
    moment: 'onEnter' | 'onExit',
    ref: ScriptRef,
    signal: AbortSignal,
  ): Promise<ScriptRun>;
  shouldContinue?(task: Task): Promise<boolean>;
  maxSteps?: number;
  maxDurationMs?: number;
  resolveCraftbook?(
    id: string,
    sourceId?: string,
    version?: string,
  ): Promise<Craftbook | undefined>;
  onChange?(task: Task): void;
  resolveStepRole?(projectId: string, role: string): Promise<string>;
  resolveAssignee?(
    projectId: string,
    book?: Craftbook,
    executionMode?: TaskExecutionMode,
  ): Promise<string>;
}
/** Trusted in-process execution only; request JSON never supplies these callbacks. */
export interface PortableTaskCompletionExecution {
  signal: AbortSignal;
  runScript: NonNullable<PortableTaskRunnerOptions['runScript']>;
  evaluateGate: NonNullable<PortableTaskRunnerOptions['evaluateGate']>;
  authorize(task: Task): Promise<void>;
}
/** Foreground host of ordinary task routes. No work resumes implicitly at boot. */
export class PortableTaskRunner {
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly completing = new Set<string>();
  private readonly retryHooks = new Set<string>();
  private admitting = false;
  isBusy(): boolean {
    return this.admitting || this.running.size > 0 || this.completing.size > 0;
  }
  constructor(private readonly options: PortableTaskRunnerOptions) {}
  async initialize() {
    for (const task of await this.options.store.recoverTasks()) this.options.onChange?.(task);
  }
  /** Called synchronously by the host before it cancels inference/scripts. Never calls back into the host. */
  cancelActive(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }
  async run(ref: string, retryInterruptedHooks = false) {
    if (this.isBusy()) throw new Error('Wait for the current task to finish');
    this.options.canRun?.();
    this.admitting = true;
    const controller = new AbortController();
    this.controllers.set(ref, controller);
    if (retryInterruptedHooks) this.retryHooks.add(ref);
    try {
      let task = await this.options.store.getTask(ref);
      if (!task) throw new Error('Task not found');
      task = await this.resolveActiveRole(task);
      if (await this.awaitingAnswer(task))
        throw new Error('Answer the task’s outstanding question before continuing');
      if (taskActiveAssignee(task).kind === 'user' && !this.hasEntryHooks(task))
        throw new Error('This step awaits the user');
      if (controller.signal.aborted) throw new Error('Task work stopped');
      const started = await this.options.store.beginTaskRun(ref);
      this.options.onChange?.(started.task);
      const promise = this.drive(started, controller).finally(() => {
        this.running.delete(ref);
        this.controllers.delete(ref);
        this.retryHooks.delete(ref);
      });
      this.running.set(ref, promise);
      void promise.catch(() => {});
      return { task: started.task, dispatched: true as const };
    } catch (error) {
      this.controllers.delete(ref);
      this.retryHooks.delete(ref);
      throw error;
    } finally {
      this.admitting = false;
    }
  }
  private async drive(
    first: Awaited<ReturnType<PortableStore['beginTaskRun']>>,
    controller: AbortController,
  ) {
    const releaseMonitor = acquireSuspendMonitor();
    const timeout = createAwakeTimeout(this.options.maxDurationMs ?? 30 * 60_000);
    const stop = () => {
      controller.abort();
      // The native model host must stop too; aborting the task alone only stops hooks.
      void this.options.cancelStep?.().catch(() => {});
    };
    timeout.signal.addEventListener('abort', stop, { once: true });
    try {
      await this.driveSteps(first, controller, timeout.budget);
    } finally {
      timeout.signal.removeEventListener('abort', stop);
      timeout.dispose();
      releaseMonitor();
    }
  }
  private async driveSteps(
    first: Awaited<ReturnType<PortableStore['beginTaskRun']>>,
    controller: AbortController,
    budget: AwakeBudget,
  ) {
    const store = this.options.store;
    let started = first;
    const maxSteps = Math.max(1, Math.min(100, this.options.maxSteps ?? 12));
    for (let count = 0; count < maxSteps; count++) {
      const { task, runId } = started;
      const activation = (await store.getTaskLifecycle(task.ref))?.activationId;
      let error: string | undefined;
      try {
        this.check(controller.signal);
        const step = task.craftbook.steps.find((item) => item.id === task.activeStepId)!;
        const autoAdvance = await this.hooks(task, step, 'onEnter', controller.signal);
        this.check(controller.signal);
        const waitingForAnswer = await this.awaitingAnswer(task);
        if (!waitingForAnswer && autoAdvance) await this.complete(task.ref, step.id);
        else if (!waitingForAnswer && taskActiveAssignee(task).kind !== 'user') {
          await this.options.runStep(task, activation);
          this.check(controller.signal);
          const current = await store.getTask(task.ref);
          if (
            current?.status === 'active' &&
            current.activeStepId === step.id &&
            step.advanceWhen &&
            (await store.getTaskLifecycle(task.ref))?.activationId === activation &&
            !(await this.awaitingAnswer(current))
          )
            await this.complete(task.ref, step.id);
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // Failed saves deliberately leave the intent running for boot recovery. Never rerun work to repair a save.
      const updated = await store.finishTaskRun(task.ref, runId, error);
      this.options.onChange?.(updated);
      if (
        error ||
        controller.signal.aborted ||
        updated.status !== 'active' ||
        !updated.activeStepId
      )
        return;
      const nextActivation = (await store.getTaskLifecycle(task.ref))?.activationId;
      if (
        nextActivation === activation ||
        (taskActiveAssignee(updated).kind === 'user' && !this.hasEntryHooks(updated)) ||
        (await this.awaitingAnswer(updated))
      )
        return;
      if (this.options.shouldContinue && !(await this.options.shouldContinue(updated))) return;
      if (count + 1 >= maxSteps || budget.expired()) {
        const paused = await store.pauseTaskIfActive(task.ref);
        this.options.onChange?.(paused);
        return;
      }
      const next = await this.resolveActiveRole(updated);
      if (taskActiveAssignee(next).kind === 'user' && !this.hasEntryHooks(next)) return;
      this.check(controller.signal);
      started = await store.beginTaskRun(task.ref);
      this.options.onChange?.(started.task);
    }
  }
  async pause(ref: string, status: 'paused' | 'canceled' = 'paused') {
    const controller = this.controllers.get(ref);
    const running = this.running.get(ref);
    // Stop is an execution revocation even when disk is full. Persist the
    // requested status independently, and retain its failure for the caller.
    controller?.abort();
    const stopping = controller
      ? Promise.resolve().then(() => this.options.cancelStep?.())
      : Promise.resolve();
    const [saved, stopped, finished] = await Promise.allSettled([
      this.options.store.setTaskStatus(ref, status),
      stopping,
      running,
    ]);
    if (saved.status === 'rejected') throw saved.reason;
    if (stopped.status === 'rejected') throw stopped.reason;
    if (finished.status === 'rejected') throw finished.reason;
    const task = saved.value;
    this.options.onChange?.(task);
    return task;
  }
  private async awaitingAnswer(task: Task) {
    return (
      await this.options.store.listQuestions({ projectId: task.projectId, pending: true })
    ).some((question) => question.taskRef === task.ref);
  }
  private questionHold(task: Task) {
    return {
      task,
      gate: {
        decision: 'reject' as const,
        message: 'Answer the task’s outstanding question before completing this step.',
        attempt: 0,
        maxAttempts: 1,
        paused: false,
      },
    };
  }
  private hasEntryHooks(task: Task): boolean {
    return (
      normalizeScriptRefs(
        task.craftbook.steps.find((step) => step.id === task.activeStepId)?.onEnter,
      ).length > 0
    );
  }
  private check(signal: AbortSignal) {
    if (signal.aborted)
      throw new Error('Task work stopped; review saved work before choosing Try again');
  }
  private async resolveActiveRole(task: Task): Promise<Task> {
    if (task.status !== 'active') return task;
    const step = task.craftbook.steps.find((candidate) => candidate.id === task.activeStepId);
    if (!step?.suggestedRole || step.assignee || step.suggestedGezelId) return task;
    if (!this.options.resolveStepRole)
      throw new Error(`This step needs a ${step.suggestedRole} gezel`);
    const gezelId = await this.options.resolveStepRole(task.projectId, step.suggestedRole);
    return this.options.store.resolveTaskStepRole(task.ref, step.id, gezelId);
  }
  private async hooks(
    task: Task,
    step: TaskCraftbookStep,
    moment: 'onEnter' | 'onExit',
    signal: AbortSignal,
    runScript = this.options.runScript,
  ) {
    const refs = normalizeScriptRefs(step[moment]);
    let autoAdvance = false;
    if (refs.length && !runScript) throw new Error('This task requires the script executor');
    for (const [index, ref] of refs.entries()) {
      this.check(signal);
      const admission = await this.options.store.beginTaskHook(
        task.ref,
        step.id,
        moment,
        index,
        ref,
        this.retryHooks.has(task.ref),
      );
      if (admission.skipped) {
        if (scriptShouldAutoAdvance(ref, admission.output)) autoAdvance = true;
        continue;
      }
      let run: Pick<ScriptRun, 'id' | 'status' | 'error' | 'output'>;
      try {
        this.check(signal);
        run = await runScript!(task, step, moment, ref, signal);
      } catch (error) {
        run = {
          id: '',
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await this.options.store.finishTaskHook(task.ref, admission.activationId, admission.id, run);
      if (run.status !== 'ok')
        throw new Error(run.error ?? `The ${moment} script ${ref.name} failed`);
      if (scriptShouldAutoAdvance(ref, run.output)) autoAdvance = true;
      this.check(signal);
    }
    return autoAdvance;
  }
  async complete(
    ref: string,
    stepId: string,
    next?: string,
    force = false,
    execution?: PortableTaskCompletionExecution,
  ) {
    if (this.completing.has(ref)) throw new Error('Task completion is already being checked');
    const existing = this.controllers.get(ref);
    const controller = existing ?? new AbortController();
    this.controllers.set(ref, controller);
    this.completing.add(ref);
    const abort = () => controller.abort();
    execution?.signal.addEventListener('abort', abort, { once: true });
    if (execution?.signal.aborted) abort();
    try {
      const task = await this.options.store.getTask(ref);
      if (!task) throw new Error('Task not found');
      const step = task.craftbook.steps.find((item) => item.id === stepId);
      if (!step || task.activeStepId !== stepId || task.status !== 'active')
        throw new Error('Task step is not active');
      this.check(controller.signal);
      await execution?.authorize(task);
      if (await this.awaitingAnswer(task)) return this.questionHold(task);
      let gate: PortableTaskGateResult | undefined;
      if (step.gate || step.advanceWhen) {
        if (force) gate = { approved: true };
        else {
          const evaluateGate = execution?.evaluateGate ?? this.options.evaluateGate;
          if (!evaluateGate) throw new Error('This step needs a gate evaluator');
          gate = await evaluateGate(task, step, controller.signal);
        }
      }
      this.check(controller.signal);
      await execution?.authorize(task);
      if (await this.awaitingAnswer(task)) return this.questionHold(task);
      if (!gate || gate.approved) {
        try {
          await this.hooks(task, step, 'onExit', controller.signal, execution?.runScript);
        } catch (error) {
          const paused = await this.options.store.pauseTaskIfActive(ref);
          this.options.onChange?.(paused);
          return {
            task: paused,
            gate: {
              decision: 'reject' as const,
              message: error instanceof Error ? error.message : String(error),
              attempt: 0,
              maxAttempts: 1,
              paused: true,
              infrastructureError: true,
              hook: 'onExit' as const,
            },
          };
        }
      }
      this.check(controller.signal);
      await execution?.authorize(task);
      const result = await this.options.store.completeTaskStep(ref, stepId, {
        expectedTask: task,
        next,
        gate,
      });
      if (result.gate?.decision !== 'reject' || result.task.activeStepId !== task.activeStepId)
        result.task = await this.resolveActiveRole(result.task);
      this.options.onChange?.(result.task);
      return result;
    } finally {
      execution?.signal.removeEventListener('abort', abort);
      this.completing.delete(ref);
      if (!existing) this.controllers.delete(ref);
    }
  }
  async create(projectId: string, body: unknown, beforeSave?: () => Promise<void>) {
    const request = CreateTaskRequestSchema.parse(body);
    const book = request.craftbookId
      ? await this.options.resolveCraftbook?.(
          request.craftbookId,
          request.craftbookSourceId,
          request.craftbookVersion,
        )
      : undefined;
    const entry =
      book?.steps.find((step) => step.id === book.entryStepId) ??
      request.steps?.find((step) => step.id === request.entryStepId) ??
      request.steps?.[0];
    const config = await this.options.store.readConfig();
    const mode =
      request.executionMode && request.executionMode !== 'auto'
        ? request.executionMode
        : resolveTaskExecutionMode(
            effectiveGeneralistModeSetting(config),
            config.provider ?? 'llama-cpp',
          );
    if (
      !request.assignee &&
      !entry?.assignee &&
      !entry?.suggestedGezelId &&
      !book?.defaultAssignee &&
      this.options.resolveAssignee
    )
      request.assignee = {
        kind: 'gezel',
        gezelId: await this.options.resolveAssignee(projectId, book, mode),
      };
    await beforeSave?.();
    let task = await this.options.store.createTask(projectId, request, book);
    task = await this.resolveActiveRole(task);
    this.options.onChange?.(task);
    return task;
  }
  async update(ref: string, input: unknown, expectedActiveStepId?: string) {
    const task = await this.options.store.updateTask(
      ref,
      UpdateTaskRequestSchema.parse(input),
      expectedActiveStepId,
    );
    this.options.onChange?.(task);
    return task;
  }
  /** Called from the already authenticated product Fetch adapter. */
  async route(
    method: string,
    pathname: string,
    body: unknown,
    query = new URLSearchParams(),
  ): Promise<Response | null> {
    const store = this.options.store;
    const match = /^\/api\/projects\/([^/]+)\/tasks(?:\/([1-9]\d*))?(?:\/(.*))?$/.exec(pathname);
    if (pathname === '/api/tasks' && method === 'GET') {
      return json({
        tasks: await store.listTasks({
          status: query.has('status') ? TaskStatusSchema.parse(query.get('status')) : undefined,
          assignee: query.get('assignee') ?? undefined,
        }),
      });
    }
    if (!match) return null;
    const projectId = decodeURIComponent(match[1]!);
    const num = match[2];
    const action = match[3];
    if (!num) {
      if (method === 'GET')
        return json({
          tasks: await store.listTasks({
            projectId,
            status: query.has('status') ? TaskStatusSchema.parse(query.get('status')) : undefined,
            assignee: query.get('assignee') ?? undefined,
          }),
        });
      if (method === 'POST') {
        const request = CreateTaskRequestSchema.parse(body);
        const task = await this.create(projectId, request);
        if (request.dispatchEntry) await this.run(task.ref);
        return json(task, 201);
      }
    }
    const ref = `${projectId}/${num}`;
    const task = await store.getTask(ref);
    if (!task) return json({ error: 'Task not found' }, 404);
    if (!action && method === 'GET') return json(task);
    if (!action && method === 'PATCH') {
      const updated = await this.update(ref, body);
      return json(updated);
    }
    if (action === 'status' && method === 'POST') {
      const { status } = SetTaskStatusRequestSchema.parse(body);
      if (status === 'paused' || status === 'canceled') return json(await this.pause(ref, status));
      const updated = await store.setTaskStatus(ref, status);
      this.options.onChange?.(updated);
      return json(updated);
    }
    if ((action === 'retry' || action === 'activate') && method === 'POST') {
      await store.setTaskStatus(ref, 'active');
      const started = await this.run(ref, action === 'retry');
      return json(action === 'activate' ? started.task : started);
    }
    if (action === 'steps' && method === 'POST') {
      const updated = await store.addTaskStep(ref, body);
      this.options.onChange?.(updated);
      return json(updated);
    }
    if (action === 'craftbook/steps/order' && method === 'PATCH') {
      const { order } = z.object({ order: z.array(z.string()) }).parse(body);
      const updated = await store.reorderTaskSteps(ref, order);
      this.options.onChange?.(updated);
      return json({ task: updated });
    }
    if (action === 'craftbook' && method === 'PATCH') {
      const updated = await store.updateTaskCraftbook(
        ref,
        body as Parameters<PortableStore['updateTaskCraftbook']>[1],
      );
      this.options.onChange?.(updated);
      return json({ task: updated });
    }
    const edit = /^steps\/([^/]+)(?:\/(activate))?$/.exec(action ?? '');
    if (edit && ['PATCH', 'DELETE', 'POST'].includes(method)) {
      const stepId = decodeURIComponent(edit[1]!);
      if (method === 'POST' && edit[2]) {
        const updated = await store.activateTaskStep(ref, stepId);
        this.options.onChange?.(updated);
        return json(updated);
      }
      if (!edit[2] && (method === 'PATCH' || method === 'DELETE')) {
        const updated =
          method === 'PATCH'
            ? await store.updateTaskStep(
                ref,
                stepId,
                body as Parameters<PortableStore['updateTaskStep']>[2],
              )
            : await store.removeTaskStep(ref, stepId);
        this.options.onChange?.(updated);
        return json({ task: updated });
      }
    }
    const noteEdit = /^notes\/([^/]+)$/.exec(action ?? '');
    if (noteEdit && method === 'PATCH')
      return json({
        note: await store.updateTaskNote(ref, decodeURIComponent(noteEdit[1]!), body),
      });
    if (noteEdit && method === 'DELETE') {
      await store.deleteTaskNote(ref, decodeURIComponent(noteEdit[1]!));
      return json({ ok: true });
    }
    const complete = /^steps\/([^/]+)\/complete$/.exec(action ?? '');
    if (complete && method === 'POST') {
      const request = CompleteStepRequestSchema.parse(body ?? {});
      return json(
        await this.complete(ref, decodeURIComponent(complete[1]!), request.next, request.force),
      );
    }
    if (action === 'notes' && method === 'GET')
      return json({
        notes: (await store.listTaskNotes(ref)).filter(
          (note) => !query.get('step') || note.stepId === query.get('step'),
        ),
      });
    if (action === 'notes' && method === 'POST') {
      const note = AppendTaskNoteRequestSchema.parse(body);
      return json({ note: await store.appendTaskNote(ref, note.text, note.stepId) });
    }
    if (action === 'sessions' && method === 'GET')
      return json({
        sessions: (await store.listSessions({ projectId })).filter(
          (session) => session.taskRef === ref,
        ),
      });
    if (action === 'children' && method === 'GET') return json({ tasks: [] });
    return json({ error: 'This task operation is not available on this host' }, 501);
  }
}
