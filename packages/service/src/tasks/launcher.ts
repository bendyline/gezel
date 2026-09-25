import type { CreateTaskRequest, Task } from '@bendyline/gezel';
import { ConnectorPrepError } from '../connectors/task-prep.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { taskInputErrorBody } from '../http/routes/task-inputs.js';
import { type EntryDispatchResult, dispatchTaskEntry } from './entry-dispatch.js';
import { TaskInputError } from './inputs/resolve.js';
import {
  ConnectorSetupRequiredError,
  CraftbookSetupRequiredError,
  type TaskManager,
} from './manager.js';
import type { TaskRunner } from './runner.js';

/**
 * The one way a task is created-and-started from an HTTP surface. The
 * project-tasks POST route and the chat composer's launch route both go
 * through here so invocation-key dedupe, the in-flight coalescing, and the
 * entry dispatch cannot drift between them.
 *
 * Idempotency has two layers on purpose. A durable one: a live task whose
 * `origin` carries the same invocation key is returned instead of a second
 * launch, which survives restarts. And a process-local one: concurrent
 * requests for the same key before the first write lands share one create
 * promise, because a provider that repeats a tool call repeats it within
 * milliseconds and the durable check alone would let both through.
 */
export interface TaskLaunchDeps {
  tasks: Pick<TaskManager, 'create' | 'list'>;
  store: Pick<Store, 'getProject' | 'getGezel'>;
  taskRunner: Pick<TaskRunner, 'enqueueHandoff'>;
  history?: Pick<HistoryManager, 'log'>;
}

export interface TaskLaunchOptions {
  craftbookInvocationKey?: string;
  dispatchEntry?: boolean;
}

export interface TaskLaunchResult {
  task: Task;
  /** True when an earlier launch with the same key answered instead. */
  reused: boolean;
  /** Present only when this call performed the entry dispatch. */
  dispatch?: EntryDispatchResult;
}

export type TaskLaunchRequest = Omit<
  CreateTaskRequest,
  'dispatchEntry' | 'craftbookInvocationKey' | 'description'
> & {
  description?: string;
};

const LIVE_STATUSES = new Set<Task['status']>(['draft', 'active', 'paused']);

export class TaskLauncher {
  private readonly inflight = new Map<string, Promise<Task>>();

  constructor(private readonly deps: TaskLaunchDeps) {}

  async launch(
    projectId: string,
    body: TaskLaunchRequest,
    options: TaskLaunchOptions = {},
  ): Promise<TaskLaunchResult> {
    const key = options.craftbookInvocationKey;
    if (key) {
      const existing = await this.findLive(projectId, key);
      if (existing) return { task: existing, reused: true };
      const inflightKey = `${projectId}:${key}`;
      const pending = this.inflight.get(inflightKey);
      if (pending) return { task: await pending, reused: true };
      const create = this.deps.tasks.create(projectId, body, {
        origin: { kind: 'craftbook-invocation', key },
      });
      this.inflight.set(inflightKey, create);
      let task: Task;
      try {
        task = await create;
      } finally {
        this.inflight.delete(inflightKey);
      }
      return this.finish(task, options);
    }
    const task = await this.deps.tasks.create(projectId, body);
    return this.finish(task, options);
  }

  /** A live task already carrying this invocation key, if any. */
  async findLive(projectId: string, craftbookInvocationKey: string): Promise<Task | undefined> {
    return (await this.deps.tasks.list({ projectId })).find(
      (candidate) =>
        candidate.origin?.kind === 'craftbook-invocation' &&
        candidate.origin.key === craftbookInvocationKey &&
        LIVE_STATUSES.has(candidate.status),
    );
  }

  private async finish(task: Task, options: TaskLaunchOptions): Promise<TaskLaunchResult> {
    if (!options.dispatchEntry) return { task, reused: false };
    // Single-channel kickoff: hand the entry step to its gezel as a
    // task-scoped handoff. Best-effort — guard trips are logged and
    // visible as an absent task.entry.dispatched history event.
    const dispatch = await dispatchTaskEntry(
      { store: this.deps.store, taskRunner: this.deps.taskRunner, history: this.deps.history },
      task,
    );
    return { task, reused: false, dispatch };
  }
}

/**
 * A launch that fails its own preconditions is a 4xx the caller renders,
 * never a 500 — the catch-all handler scrubs the body, and these messages
 * ARE the fix instructions. Returns null for anything else so the caller
 * rethrows.
 */
export function launchErrorResponse(
  err: unknown,
): { status: 409 | 422; body: Record<string, unknown> } | null {
  if (err instanceof CraftbookSetupRequiredError) {
    return {
      status: 409,
      body: {
        error: err.message,
        code: err.code,
        craftbookId: err.craftbookId,
        missingToolsets: err.missingToolsets,
      },
    };
  }
  if (err instanceof ConnectorSetupRequiredError) {
    return {
      status: 409,
      body: {
        error: err.message,
        code: err.code,
        craftbookId: err.craftbookId,
        missingConnectors: err.missingConnectors,
      },
    };
  }
  if (err instanceof ConnectorPrepError) {
    return {
      status: 409,
      body: {
        error: err.message,
        code: err.code,
        craftbookId: err.craftbookId,
        connectorTypeId: err.typeId,
        reason: err.reason,
      },
    };
  }
  if (err instanceof TaskInputError) return { status: 422, body: taskInputErrorBody(err) };
  return null;
}
