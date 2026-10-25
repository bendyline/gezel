import type { Task, TaskCraftbook } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { buildSpawnedChildTask } from './spawn-child.js';

describe('buildSpawnedChildTask', () => {
  it("keeps the host's request, so every shard answers the same message", () => {
    const requestRef = { sessionId: 'meester', at: '2026-10-23T09:10:00Z', messageId: 'm2' };
    const craftbook = {
      id: 'b',
      name: 'Book',
      steps: [],
      entryStepId: 'a',
    } as unknown as TaskCraftbook;
    const parent = {
      projectId: 'shop',
      num: 4,
      ref: 'shop/4',
      title: 'Invoices',
      status: 'active',
      requestRef,
      createdBy: { kind: 'user' },
    } as unknown as Task;
    const child = buildSpawnedChildTask({
      parent,
      num: 5,
      craftbook,
      assignee: { kind: 'user' },
      variation: undefined,
      now: '2026-10-23T09:12:00Z',
    });
    expect(child.parentTaskRef).toBe('shop/4');
    expect(child.requestRef).toEqual(requestRef);
  });
});
