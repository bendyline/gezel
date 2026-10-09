/**
 * Durable deduplication for explicitly keyed workflow task launches. The key
 * and request hash live on the task itself, so a lost POST response or daemon
 * restart cannot create a second review, even after the first task finishes.
 *
 * A lazily rebuilt per-project index retains only keys and task numbers, not
 * full task histories. Project launches are serialized through dispatch;
 * a changed payload is rejected, and retries never reset task state or gates.
 */
import { createHash } from 'node:crypto';
import { KeyedLock, type Task } from '@bendyline/gezel';
import { HttpStatusError } from '@bendyline/gezel/runtime';
import type { Store } from '../fs/store.js';
import type { TaskLaunchResult } from './launcher.js';

type Origin = Extract<NonNullable<Task['origin']>, { kind: 'workflow-invocation' }>;
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, ordered(v)]),
  );
}

export class WorkflowLaunches {
  private readonly locks = new KeyedLock();
  private readonly indexes = new Map<string, Promise<Map<string, number>>>();
  constructor(private readonly store: Pick<Store, 'iterateProjectTasks' | 'readTask'>) {}

  private index(projectId: string): Promise<Map<string, number>> {
    let index = this.indexes.get(projectId);
    if (!index) {
      index = (async () => {
        const keys = new Map<string, number>();
        for await (const task of this.store.iterateProjectTasks(projectId)) {
          if (task.origin?.kind !== 'workflow-invocation') continue;
          if (keys.has(task.origin.key))
            throw new Error('Duplicate workflow request key requires inspection');
          keys.set(task.origin.key, task.num);
        }
        return keys;
      })();
      this.indexes.set(projectId, index);
      void index.catch(() => {
        this.indexes.delete(projectId);
      });
    }
    return index;
  }

  async launch(
    projectId: string,
    key: string,
    body: unknown,
    create: (origin: Origin) => Promise<TaskLaunchResult>,
  ): Promise<TaskLaunchResult> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(ordered(body)))
      .digest('hex');
    return this.locks.run(projectId, async () => {
      const index = await this.index(projectId);
      const num = index.get(key);
      if (num !== undefined) {
        const task = await this.store.readTask(projectId, num);
        if (!task || task.origin?.kind !== 'workflow-invocation' || task.origin.key !== key) {
          throw new HttpStatusError(
            'Workflow task identity changed; inspect before retrying.',
            409,
          );
        }
        if (task.origin.requestHash !== requestHash) {
          throw new HttpStatusError('Workflow request key was reused with different inputs.', 409);
        }
        return { task, reused: true };
      }
      try {
        const result = await create({ kind: 'workflow-invocation', key, requestHash });
        index.set(key, result.task.num);
        return result;
      } catch (error) {
        // Persistence may have succeeded before a later dispatch/hook failed.
        // Rebuild before retrying so that task remains the source of truth.
        this.indexes.delete(projectId);
        throw error;
      }
    });
  }
}
