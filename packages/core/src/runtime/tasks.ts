import { z } from 'zod';
import {
  assertCraftbookParamRequirements,
  craftbookParamDefaults,
  interpolateContextDeep,
  resolveCraftbookParamDefaults,
  resolveRuntimeTokensInParams,
} from '../craftbook-params.js';
import { assertSafeEntityId } from '../entity-id.js';
import { CreateProjectRequestSchema } from '../schemas/api.js';
import { type Craftbook, CraftbookSchema, resolveSteps } from '../schemas/craftbook.js';
import { type GateScriptResult, normalizeStepGate } from '../schemas/gate.js';
import { ProjectSchema } from '../schemas/project.js';
import { QuestionSchema } from '../schemas/question.js';
import {
  type ScriptRef,
  ScriptRefSchema,
  type ScriptRun,
  normalizeScriptRefs,
} from '../schemas/script.js';
import {
  type CompleteStepGateInfo,
  type CompleteStepResponse,
  type CreateTaskRequest,
  CreateTaskRequestSchema,
  type Task,
  type TaskNote,
  TaskNoteSchema,
  TaskSchema,
  type TaskStatus,
  TaskStatusSchema,
  type UpdateTaskRequest,
  UpdateTaskRequestSchema,
  parseTaskRef,
} from '../schemas/task.js';
import { isSharedLibraryProject } from '../shared-project.js';
import { pinCraftbookOwner } from '../task-execution.js';
import { slugifyEntityName } from './entities.js';
import { encodeText } from './files.js';
import { requireGezel } from './gezels.js';
import {
  getProject,
  listProjects,
  projectRoot,
  projectWrites,
  requireProject,
} from './projects.js';
import type { PortableRepository } from './repository.js';
import { stageCraftbookScriptSources } from './script-sources.js';
import { resolvePortableTaskExecution } from './task-execution.js';

export { taskActiveAssignee } from '../task-execution.js';

export interface PortableTaskFilter {
  projectId?: string;
  status?: TaskStatus;
  assignee?: string;
}
export interface PortableTaskGateResult {
  approved: boolean;
  message?: string;
  next?: string;
  handoff?: GateScriptResult['handoff'];
  infrastructureError?: true;
  scriptRuns?: CompleteStepGateInfo['scriptRuns'];
}
export interface PortableTaskCompletion {
  next?: string;
  gate?: PortableTaskGateResult;
  /** Snapshot judged by the gate; prevents a concurrent edit changing its meaning. */
  expectedTask?: Task;
}
const RunSchema = z
  .object({
    runId: z.string().min(1),
    taskRef: z.string(),
    stepId: z.string(),
    state: z.enum(['running', 'finished', 'interrupted']),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export function taskLocation(ref: string) {
  const parts = parseTaskRef(ref);
  if (!parts || !Number.isSafeInteger(parts.num)) throw new Error('Invalid task reference');
  assertSafeEntityId(parts.projectId);
  return { ...parts, root: `${projectRoot(parts.projectId)}/tasks/${parts.num}` };
}
async function writable(repo: PortableRepository, projectId: string) {
  const project = await requireProject(repo, projectId);
  if (isSharedLibraryProject(project))
    throw new Error('The shared library is not a task workspace');
  if (project.status === 'readonly' || project.archived)
    throw new Error('This project does not accept task changes');
}
async function assigneeExists(repo: PortableRepository, task: Pick<Task, 'assignee'>) {
  if (task.assignee.kind === 'gezel') await requireGezel(repo, task.assignee.gezelId);
}
function taskWrites(repo: PortableRepository, input: Task): Map<string, Uint8Array> {
  const { description, effectiveStatus: _effective, ...record } = TaskSchema.parse(input);
  const root = taskLocation(input.ref).root;
  return new Map([
    [`${root}/task.json`, repo.json(record)],
    [`${root}/about.md`, encodeText(description ?? '')],
  ]);
}
async function write(repo: PortableRepository, task: Task, extra?: Map<string, Uint8Array>) {
  const writes = taskWrites(repo, task);
  for (const [path, bytes] of extra ?? []) writes.set(path, bytes);
  await repo.transactions.commit(writes);
  return task;
}
export async function getTask(repo: PortableRepository, ref: string): Promise<Task | null> {
  const { root, projectId, num } = taskLocation(ref);
  const task = await repo.tolerantRecord(`${root}/task.json`, TaskSchema, `task ${root}`);
  if (!task) return null;
  if (task.projectId !== projectId || task.num !== num || task.ref !== ref)
    throw new Error('Task identity does not match its file');
  return { ...task, description: (await repo.text(`${root}/about.md`)) ?? task.description };
}
async function requireTask(repo: PortableRepository, ref: string) {
  const task = await getTask(repo, ref);
  if (!task) throw new Error('Task not found');
  return task;
}
/** Internal structure-editor boundary. User edits cannot race an executing step. */
export async function editTaskStructure(
  repo: PortableRepository,
  ref: string,
  edit: (task: Task) => Promise<void> | void,
  reactivate = false,
) {
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  const run = await repo.record(`${taskLocation(ref).root}/execution.json`, RunSchema);
  if (run?.state === 'running') throw new Error('Pause the task before editing its steps');
  const lifecycle = await getTaskLifecycle(repo, ref);
  if (task.status === 'active' && lifecycle && hasPendingHooks(lifecycle))
    throw new Error('Pause the task before editing its hooks');
  const hookIdentity = () =>
    JSON.stringify(task.craftbook.steps.map((step) => [step.id, step.onEnter, step.onExit]));
  const beforeHooks = hookIdentity();
  const priorStep = task.activeStepId;
  await edit(task);
  if (
    task.status !== 'draft' &&
    task.executionMode === 'generalist' &&
    task.assignee.kind === 'gezel'
  )
    pinCraftbookOwner(task.craftbook.steps, task.assignee.gezelId);
  task.updatedAt = repo.now();
  task.craftbook.updatedAt = repo.now();
  return write(
    repo,
    task,
    reactivate || priorStep !== task.activeStepId || beforeHooks !== hookIdentity()
      ? await resetTaskLifecycle(repo, ref, task.activeStepId)
      : undefined,
  );
}
export async function listTasks(repo: PortableRepository, filter: PortableTaskFilter = {}) {
  const projects = filter.projectId
    ? [await requireProject(repo, filter.projectId)]
    : await listProjects(repo);
  const tasks: Task[] = [];
  for (const project of projects) {
    for (const entry of await repo.list(`${projectRoot(project.id)}/tasks`)) {
      if (!entry.isDirectory || !/^[1-9]\d*$/.test(entry.name)) continue;
      const task = await getTask(repo, `${project.id}/${entry.name}`);
      if (!task || (filter.status && task.status !== filter.status)) continue;
      const assignee = task.assignee.kind === 'user' ? 'user' : task.assignee.gezelId;
      if (filter.assignee && filter.assignee !== assignee) continue;
      tasks.push(task);
    }
  }
  return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.num - a.num);
}
export function assertPortableCraftbookSupported(book: Craftbook) {
  if (
    book.spawn ||
    book.hooks?.length ||
    book.commands?.length ||
    book.connectors?.length ||
    book.toolsets?.length ||
    book.requirements?.length ||
    book.capabilityFloor
  )
    throw new Error('This craftbook requires desktop execution capabilities');
  for (const step of book.steps) {
    if (
      [
        ...normalizeScriptRefs(step.onEnter),
        ...normalizeScriptRefs(step.onExit),
        ...(step.gate ? (normalizeStepGate(step.gate).scripts ?? []) : []),
      ].some((ref) => ref.scope === 'craftbook' && !Object.hasOwn(book.scripts ?? {}, ref.name))
    )
      throw new Error(
        `Step ${step.name} references an embedded craftbook script missing from its snapshot`,
      );
    if (
      step.spawnFanout ||
      step.branches?.length ||
      step.capabilityFloor ||
      step.advanceWhen?.requireChange
    )
      throw new Error(`Step ${step.name} requires unsupported lifecycle or branching behavior`);
    if (
      step.gate &&
      (normalizeStepGate(step.gate).at !== 'completion' ||
        normalizeStepGate(step.gate).reviewer ||
        (normalizeStepGate(step.gate).onReject &&
          normalizeStepGate(step.gate).onReject !== step.id))
    )
      throw new Error('Activation gates are not supported by this foreground task runner');
  }
}
interface NewProjectTaskStage {
  writes: Map<string, Uint8Array>;
  directories: string[];
}
export async function createTask(
  repo: PortableRepository,
  projectId: string,
  input: CreateTaskRequest,
  resolved?: Craftbook,
) {
  return createTaskInternal(repo, projectId, input, resolved);
}
async function createTaskInternal(
  repo: PortableRepository,
  projectId: string,
  input: CreateTaskRequest,
  resolved?: Craftbook,
  staged?: NewProjectTaskStage,
) {
  const request = CreateTaskRequestSchema.parse(input);
  if (!staged) await writable(repo, projectId);
  if (
    request.cron ||
    request.fanout ||
    request.nightShift ||
    request.spawnsSteps ||
    request.spawnsCraftbookId ||
    request.parentTaskRef ||
    request.deliveryMode === 'propose'
  )
    throw new Error('Scheduled, spawned, and change-proposal tasks require desktop execution');
  if (request.craftbookId && (!resolved || resolved.id !== request.craftbookId))
    throw new Error('This craftbook is not bundled for offline execution');
  const base = `${projectRoot(projectId)}/tasks`;
  const previous = (await repo.text(`${base}/.next-id`))?.trim() ?? '0';
  if (!/^\d+$/.test(previous)) throw new Error('Task number record is invalid');
  const existing = staged ? [] : await listTasks(repo, { projectId });
  const num = Math.max(Number(previous), ...existing.map((task) => task.num), 0) + 1;
  if (!Number.isSafeInteger(num)) throw new Error('Task number limit reached');
  const artifactDir = `tasks/${num}`;
  const runtime = {
    'task.dir': artifactDir,
    'task.num': String(num),
    'task.ref': `${projectId}/${num}`,
    'task.projectId': projectId,
  };
  const overrides = resolveRuntimeTokensInParams(request.craftbookParams ?? {}, runtime);
  const params = {
    ...resolveCraftbookParamDefaults(
      craftbookParamDefaults(resolved?.paramSchema),
      overrides,
      runtime,
    ),
    ...overrides,
  };
  assertCraftbookParamRequirements(resolved?.id ?? `task-${num}`, resolved?.paramSchema, params);
  const steps = resolved?.steps ?? resolveSteps(request.steps!);
  // Inline steps without edges follow the same convenient linear default.
  if (!resolved)
    steps.forEach((step, index) => {
      if (!step.next && !step.terminal && !step.branches?.length) {
        if (index + 1 < steps.length) step.next = steps[index + 1]!.id;
        else step.terminal = true;
      }
    });
  const book = CraftbookSchema.parse({
    ...interpolateContextDeep(
      resolved
        ? { ...resolved, scripts: undefined }
        : {
            id: `task-${num}`,
            name: request.title,
            createdAt: repo.now(),
            updatedAt: repo.now(),
            steps,
            entryStepId: request.entryStepId ?? steps[0]!.id,
          },
      { ...params, ...runtime },
    ),
    ...(resolved?.scripts ? { scripts: structuredClone(resolved.scripts) } : {}),
  });
  assertPortableCraftbookSupported(book);
  const now = repo.now();
  const entry = book.steps.find((step) => step.id === book.entryStepId)!;
  const assignee =
    request.assignee ??
    entry.assignee ??
    (entry.suggestedGezelId
      ? { kind: 'gezel' as const, gezelId: entry.suggestedGezelId }
      : (book.defaultAssignee ?? { kind: 'user' as const }));
  await assigneeExists(repo, { assignee });
  for (const step of book.steps) {
    if (step.suggestedGezelId) await requireGezel(repo, step.suggestedGezelId);
    if (step.assignee) await assigneeExists(repo, { assignee: step.assignee });
  }
  const task = TaskSchema.parse({
    projectId,
    num,
    ref: `${projectId}/${num}`,
    title: request.title,
    description: request.description,
    plan: request.plan ?? book.plan,
    outcomes: request.outcomes,
    status: request.status ?? 'active',
    assignee,
    executionMode: request.executionMode === 'auto' ? undefined : request.executionMode,
    activeStepId: book.entryStepId,
    artifactDir,
    launchSessionId: request.launchSessionId,
    craftbookParams: params,
    sourceCraftbookIds: resolved
      ? [
          {
            role: 'main',
            catalogId: resolved.id,
            version: resolved.version,
            sourceId: request.craftbookSourceId,
          },
        ]
      : [],
    craftbook: {
      ...book,
      steps: book.steps.map((step) => ({ ...step, createdAt: now })),
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    createdBy: request.createdBy ?? { kind: 'user' },
  });
  if (task.status !== 'draft') await resolvePortableTaskExecution(repo, task);
  const writes = taskWrites(repo, task);
  await stageCraftbookScriptSources(repo, projectId, task.craftbook, writes);
  writes.set(`${base}/.next-id`, encodeText(`${num}\n`));
  const directory = `${projectRoot(projectId)}/artifacts/${artifactDir}`;
  if (staged) {
    for (const [path, bytes] of writes) staged.writes.set(path, bytes);
    staged.directories.push(directory);
  } else await repo.transactions.commit(writes, [], [directory]);
  return task;
}
export async function updateTask(
  repo: PortableRepository,
  ref: string,
  input: UpdateTaskRequest,
  expectedActiveStepId?: string,
) {
  const patch = UpdateTaskRequestSchema.parse(input);
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (
    expectedActiveStepId &&
    (task.status !== 'active' || task.activeStepId !== expectedActiveStepId)
  )
    throw new Error('The task step has stopped or changed');
  if (patch.cron || patch.nightShift || patch.fanout || patch.spawnsCraftbookParams)
    throw new Error('Background and spawned tasks require desktop execution');
  if (patch.assignee) {
    const execution = await repo.record(`${taskLocation(ref).root}/execution.json`, RunSchema);
    const lifecycle = await getTaskLifecycle(repo, ref);
    if (
      JSON.stringify(patch.assignee) !== JSON.stringify(task.assignee) &&
      (execution?.state === 'running' || (lifecycle && hasPendingHooks(lifecycle)))
    )
      throw new Error('Pause the task before changing its assignee');
    await assigneeExists(repo, { assignee: patch.assignee });
  }
  const values = {
    ...task,
    ...patch,
    outcomes: patch.outcomes === null ? undefined : (patch.outcomes ?? task.outcomes),
    updatedAt: repo.now(),
  };
  for (const key of ['cron', 'nightShift', 'fanout', 'spawnsCraftbookParams'] as const)
    if (values[key] === null) delete values[key];
  return write(repo, TaskSchema.parse(values));
}
export async function setTaskStatus(repo: PortableRepository, ref: string, value: TaskStatus) {
  const status = TaskStatusSchema.parse(value);
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (status === 'complete' && task.craftbook.steps.some((step) => !step.completedAt))
    throw new Error('Complete the task steps and their gates first');
  if (task.status === 'complete' || task.status === 'canceled') {
    if (status !== task.status) throw new Error('Create a new task to repeat finished work');
  }
  if (status === 'active' && task.status === 'draft')
    await resolvePortableTaskExecution(repo, task);
  if (status === 'active' && task.status === 'paused') {
    const step = task.craftbook.steps.find((item) => item.id === task.activeStepId);
    if (step) step.gateAttempts = 0;
  }
  return write(repo, { ...task, status, updatedAt: repo.now() });
}
export async function completeTaskStep(
  repo: PortableRepository,
  ref: string,
  stepId: string,
  options: PortableTaskCompletion = {},
): Promise<CompleteStepResponse> {
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (options.expectedTask && JSON.stringify(task) !== JSON.stringify(options.expectedTask))
    throw new Error('The task changed during its completion check. Review and try again.');
  if (task.status !== 'active' || task.activeStepId !== stepId)
    throw new Error('Only the active task step can complete');
  // Questions live outside task.json, so the task snapshot alone cannot notice
  // one created while a gate/hook was running. This check shares the commit lock.
  const questions =
    (await repo.record(`${projectRoot(task.projectId)}/questions.json`, z.array(QuestionSchema))) ??
    [];
  if (questions.some((question) => question.taskRef === ref && !question.answer))
    return {
      task,
      gate: {
        decision: 'reject',
        message: 'Answer the task’s outstanding question before completing this step.',
        attempt: 0,
        maxAttempts: 1,
        paused: false,
      },
    };
  const step = task.craftbook.steps.find((value) => value.id === stepId)!;
  const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
  if ((gate || step.advanceWhen) && !options.gate)
    throw new Error('The step requires its completion check');
  if (options.gate && !options.gate.approved) {
    const infrastructureError = options.gate.infrastructureError === true;
    if (!infrastructureError) step.gateAttempts = (step.gateAttempts ?? 0) + 1;
    const paused = infrastructureError || (step.gateAttempts ?? 0) >= (gate?.maxAttempts ?? 3);
    let extra = new Map<string, Uint8Array>();
    if (paused) task.status = 'paused';
    else {
      const targetId = options.gate.next ?? gate?.onReject;
      if (targetId) {
        const target = task.craftbook.steps.find((candidate) => candidate.id === targetId);
        if (!target) throw new Error('This task does not declare that gate rejection step');
        task.activeStepId = target.id;
        delete target.completedAt;
        // A fresh activation is not a fresh rejection budget for self-loops.
        if (target.id !== step.id) target.gateAttempts = 0;
        extra = await resetTaskLifecycle(repo, ref, target.id);
      }
    }
    task.updatedAt = repo.now();
    if (infrastructureError) {
      const diagnostics = (options.gate.scriptRuns ?? [])
        .map(
          (run) =>
            `${run.scriptName}${run.runId ? ` (run ${run.runId})` : ''}: ${run.error ?? ''}${run.logsTail ? `\n${run.logsTail}` : ''}`,
        )
        .join('\n');
      extra = await taskNoteWrites(
        repo,
        ref,
        {
          text: `# Gate unavailable — task paused\n\n${options.gate.message ?? 'The completion gate could not run.'}${diagnostics ? `\n\n${diagnostics}` : ''}\n\nNo completion attempt was consumed. Fix the gate or runtime, then set the task active and retry.`,
          stepId: step.id,
        },
        extra,
      );
    }
    await write(repo, task, extra);
    return {
      task,
      gate: {
        decision: 'reject',
        message: options.gate.message ?? 'The step needs more work',
        attempt: step.gateAttempts ?? 0,
        maxAttempts: gate?.maxAttempts ?? 3,
        paused,
        ...(infrastructureError ? { infrastructureError: true } : {}),
        ...(options.gate.scriptRuns ? { scriptRuns: options.gate.scriptRuns } : {}),
      },
    };
  }
  // Match desktop: an explicit jump may name any existing step. A model
  // cannot invent one, and every gate above must still pass before the jump.
  const next =
    options.next && options.next !== 'next'
      ? options.next
      : (options.gate?.next ??
        gate?.onApprove ??
        step.advanceWhen?.goto ??
        (step.terminal
          ? undefined
          : (step.next ?? task.craftbook.steps[task.craftbook.steps.indexOf(step) + 1]?.id)));
  if (next && !task.craftbook.steps.some((candidate) => candidate.id === next))
    throw new Error('This task does not declare that next step');
  step.completedAt = repo.now();
  if (next) {
    task.activeStepId = next;
    const following = task.craftbook.steps.find((value) => value.id === next)!;
    delete following.completedAt;
    delete following.gateAttempts;
  } else {
    task.status = 'complete';
    delete task.activeStepId;
  }
  task.updatedAt = repo.now();
  let extra = await resetTaskLifecycle(repo, ref, task.activeStepId);
  const handoff = options.gate?.handoff;
  if (handoff) {
    task.lastGateHandoff = {
      fromStepId: step.id,
      toStepId: task.activeStepId,
      ...handoff,
      at: repo.now(),
    };
    if (task.activeStepId) {
      const params = Object.entries(handoff.params ?? {})
        .map(
          ([key, value]) =>
            `- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join('\n');
      extra = await taskNoteWrites(
        repo,
        ref,
        {
          text: `# Handoff from gate on "${step.name}"\n\n${handoff.message}${params ? `\n\n${params}` : ''}`,
          stepId: task.activeStepId,
        },
        extra,
      );
    }
  }
  await write(repo, task, extra);
  return { task };
}
/** Persist the active specialist without changing the task's stable owner. */
export async function resolveTaskStepRole(
  repo: PortableRepository,
  ref: string,
  stepId: string,
  gezelId: string,
) {
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (task.status !== 'active' || task.activeStepId !== stepId)
    throw new Error('The active task step changed during role resolution');
  const step = task.craftbook.steps.find((candidate) => candidate.id === stepId)!;
  if (step.assignee || step.suggestedGezelId) return task;
  await requireGezel(repo, gezelId);
  step.suggestedGezelId = gezelId;
  task.updatedAt = repo.now();
  return write(repo, task);
}
export async function beginTaskRun(repo: PortableRepository, ref: string) {
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (task.status !== 'active' || !task.activeStepId)
    throw new Error('Activate the task before running its step');
  const root = taskLocation(ref).root;
  const prior = await repo.record(`${root}/execution.json`, RunSchema);
  if (prior?.state === 'running') throw new Error('This task step is already running');
  const step = task.craftbook.steps.find((item) => item.id === task.activeStepId)!;
  step.attemptCount = (step.attemptCount ?? 0) + 1;
  step.lastActivatedAt = repo.now();
  task.updatedAt = repo.now();
  const run = RunSchema.parse({
    runId: repo.createId(),
    taskRef: ref,
    stepId: step.id,
    state: 'running',
    startedAt: repo.now(),
  });
  const lifecycle = await getTaskLifecycle(repo, ref);
  const extra =
    lifecycle?.stepId === step.id
      ? new Map<string, Uint8Array>()
      : await resetTaskLifecycle(repo, ref, step.id);
  extra.set(`${root}/execution.json`, repo.json(run));
  await write(repo, task, extra);
  return { task, runId: run.runId };
}
export async function finishTaskRun(
  repo: PortableRepository,
  ref: string,
  runId: string,
  error?: string,
) {
  const task = await requireTask(repo, ref);
  const root = taskLocation(ref).root;
  const run = await repo.record(`${root}/execution.json`, RunSchema);
  if (!run || run.runId !== runId || run.state !== 'running')
    throw new Error('Task run ownership changed');
  const next = RunSchema.parse({
    ...run,
    state: error ? 'interrupted' : 'finished',
    endedAt: repo.now(),
    ...(error ? { error } : {}),
  });
  if (error && task.status === 'active') task.status = 'paused';
  task.updatedAt = repo.now();
  await write(repo, task, new Map([[`${root}/execution.json`, repo.json(next)]]));
  return task;
}
/** Hook failure may hold active work, but must preserve a concurrent user stop. */
export async function pauseTaskIfActive(repo: PortableRepository, ref: string) {
  const task = await requireTask(repo, ref);
  return task.status === 'active' ? setTaskStatus(repo, ref, 'paused') : task;
}
export async function recoverTasks(repo: PortableRepository) {
  const recovered: Task[] = [];
  for (const task of await listTasks(repo)) {
    const run = await repo.record(`${taskLocation(task.ref).root}/execution.json`, RunSchema);
    if (run?.state === 'running')
      recovered.push(
        await finishTaskRun(
          repo,
          task.ref,
          run.runId,
          'The app closed during this step. Review saved work before choosing Try again.',
        ),
      );
  }
  for (const task of await listTasks(repo)) {
    const lifecycle = await getTaskLifecycle(repo, task.ref);
    if (task.status === 'active' && lifecycle && hasPendingHooks(lifecycle)) {
      const paused = await setTaskStatus(repo, task.ref, 'paused');
      if (!recovered.some((item) => item.ref === paused.ref)) recovered.push(paused);
    }
  }
  return recovered;
}
const HookEntrySchema = z.object({
  id: z.string(),
  key: z.string(),
  moment: z.enum(['onEnter', 'onExit']),
  index: z.number().int(),
  script: ScriptRefSchema,
  state: z.enum(['started', 'ok', 'error']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  runId: z.string().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
});
const LifecycleSchema = z.object({
  activationId: z.string(),
  stepId: z.string().optional(),
  entries: z.array(HookEntrySchema).max(1000),
});
function hasPendingHooks(lifecycle: z.infer<typeof LifecycleSchema>) {
  const latest = new Map(lifecycle.entries.map((entry) => [entry.key, entry]));
  return [...latest.values()].some((entry) => entry.state === 'started');
}
export async function getTaskLifecycle(repo: PortableRepository, ref: string) {
  await requireTask(repo, ref);
  return repo.record(`${taskLocation(ref).root}/lifecycle.json`, LifecycleSchema);
}
async function resetTaskLifecycle(repo: PortableRepository, ref: string, stepId?: string) {
  const root = taskLocation(ref).root;
  const previous = await repo.record(`${root}/lifecycle.json`, LifecycleSchema);
  const writes = new Map<string, Uint8Array>();
  if (previous) writes.set(`${root}/lifecycle/${previous.activationId}.json`, repo.json(previous));
  writes.set(
    `${root}/lifecycle.json`,
    repo.json({ activationId: repo.createId(), stepId, entries: [] }),
  );
  return writes;
}
export async function beginTaskHook(
  repo: PortableRepository,
  ref: string,
  stepId: string,
  moment: 'onEnter' | 'onExit',
  index: number,
  script: ScriptRef,
  retryInterrupted = false,
) {
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (task.status !== 'active' || task.activeStepId !== stepId)
    throw new Error('Task step stopped or changed before its hook');
  let lifecycle = await getTaskLifecycle(repo, ref);
  if (!lifecycle || lifecycle.stepId !== stepId) {
    await repo.transactions.commit(await resetTaskLifecycle(repo, ref, stepId));
    lifecycle = (await getTaskLifecycle(repo, ref))!;
  }
  const key = taskHookKey(moment, index, script);
  const previous = [...lifecycle.entries].reverse().find((entry) => entry.key === key);
  if (previous?.state === 'ok')
    return {
      skipped: true as const,
      activationId: lifecycle.activationId,
      id: previous.id,
      output: previous.output,
    };
  if (previous && !retryInterrupted)
    throw new Error(
      `The ${moment} hook ${script.name} was interrupted or failed. Review its saved work, then choose Try again to retry explicitly.`,
    );
  if (lifecycle.entries.length >= 1000) throw new Error('Task hook history limit reached');
  const entry = HookEntrySchema.parse({
    id: repo.createId(),
    key,
    moment,
    index,
    script,
    state: 'started',
    startedAt: repo.now(),
  });
  lifecycle.entries.push(entry);
  await repo.transactions.commit(
    new Map([[`${taskLocation(ref).root}/lifecycle.json`, repo.json(lifecycle)]]),
  );
  return { skipped: false as const, activationId: lifecycle.activationId, id: entry.id };
}
export function taskHookKey(moment: 'onEnter' | 'onExit', index: number, script: ScriptRef) {
  return JSON.stringify([moment, index, ScriptRefSchema.parse(script)]);
}
export async function finishTaskHook(
  repo: PortableRepository,
  ref: string,
  activationId: string,
  id: string,
  result: Pick<ScriptRun, 'id' | 'status' | 'error' | 'output'>,
) {
  const lifecycle = await getTaskLifecycle(repo, ref);
  if (!lifecycle || lifecycle.activationId !== activationId)
    throw new Error('Task hook activation changed');
  const entry = lifecycle.entries.find((entry) => entry.id === id);
  if (!entry || entry.state !== 'started') throw new Error('Task hook ownership changed');
  entry.state = result.status === 'ok' ? 'ok' : 'error';
  entry.runId = result.id || undefined;
  entry.error = result.error;
  entry.output = result.output;
  entry.finishedAt = repo.now();
  await repo.transactions.commit(
    new Map([[`${taskLocation(ref).root}/lifecycle.json`, repo.json(lifecycle)]]),
  );
}
export async function listTaskNotes(repo: PortableRepository, ref: string): Promise<TaskNote[]> {
  await requireTask(repo, ref);
  const raw = await repo.text(`${taskLocation(ref).root}/notes.jsonl`);
  return raw
    ? raw
        .split('\n')
        .filter(Boolean)
        .map((line) => TaskNoteSchema.parse(JSON.parse(line)))
    : [];
}
/** Stage gate notes with the transition so recovery cannot lose its handoff. */
async function taskNoteWrites(
  repo: PortableRepository,
  ref: string,
  input: Pick<TaskNote, 'text' | 'stepId'>,
  writes = new Map<string, Uint8Array>(),
) {
  const notes = await listTaskNotes(repo, ref);
  notes.push(
    TaskNoteSchema.parse({
      id: repo.createId(),
      at: repo.now(),
      author: { kind: 'user' },
      ...input,
    }),
  );
  writes.set(
    `${taskLocation(ref).root}/notes.jsonl`,
    encodeText(`${notes.map((note) => JSON.stringify(note)).join('\n')}\n`),
  );
  return writes;
}
export async function appendTaskNote(
  repo: PortableRepository,
  ref: string,
  text: string,
  stepId?: string,
  actorGezelId?: string,
  expectedActiveStepId?: string,
) {
  const task = await requireTask(repo, ref);
  await writable(repo, task.projectId);
  if (
    expectedActiveStepId &&
    (task.status !== 'active' || task.activeStepId !== expectedActiveStepId)
  )
    throw new Error('The task step has stopped or changed');
  if (!text.trim() || text.length > 64_000)
    throw new Error('A task note must contain 1–64000 characters');
  if (stepId && !task.craftbook.steps.some((step) => step.id === stepId))
    throw new Error('Task step not found');
  const author = actorGezelId ? await requireGezel(repo, actorGezelId) : undefined;
  const notes = await listTaskNotes(repo, ref);
  const note = TaskNoteSchema.parse({
    id: repo.createId(),
    at: repo.now(),
    author: author ? { kind: 'gezel', gezelId: author.id, name: author.name } : { kind: 'user' },
    text,
    stepId,
  });
  notes.push(note);
  await repo.transactions.commit(
    new Map([
      [
        `${taskLocation(ref).root}/notes.jsonl`,
        encodeText(`${notes.map((item) => JSON.stringify(item)).join('\n')}\n`),
      ],
    ]),
  );
  return note;
}

export interface PortableStartProject {
  name: string;
  about?: string;
  missionObjectives?: string;
  taskDescription: string;
  taskTitle?: string;
  leadGezelId: string;
}
/** One published journal owns the project, initial crew, task and work folder. */
export async function startProject(repo: PortableRepository, input: PortableStartProject) {
  const parsed = CreateProjectRequestSchema.parse(input);
  await requireGezel(repo, input.leadGezelId);
  const id = await repo.uniqueId('projects', slugifyEntityName(parsed.name) || repo.createId());
  const root = projectRoot(id);
  const project = ProjectSchema.parse({
    id,
    name: parsed.name.trim(),
    createdAt: repo.now(),
    updatedAt: repo.now(),
    gezelIds: [input.leadGezelId],
    voormanGezelId: input.leadGezelId,
  });
  if (!project.name) throw new Error('A project name is required');
  const stage = {
    writes: projectWrites(repo, project, parsed.about, parsed.missionObjectives),
    directories: [`${root}/workspace`, `${root}/artifacts`],
  };
  const task = await createTaskInternal(
    repo,
    id,
    {
      title: input.taskTitle ?? parsed.name,
      description: input.taskDescription,
      assignee: { kind: 'gezel', gezelId: input.leadGezelId },
      steps: [
        { name: 'Complete the project brief', prompt: input.taskDescription, terminal: true },
      ],
    },
    undefined,
    stage,
  );
  await repo.transactions.commit(stage.writes, [], stage.directories);
  return { project: (await getProject(repo, id))!, task };
}
