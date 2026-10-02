import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { TaskManager } from '../tasks/manager.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A completion-gate rejection whose onReject loops the task to ANOTHER step
 * leaves the rejected session nothing to repair. Re-prompting it started
 * invoice-run's reviewer on a stale turn that paused the whole task
 * (qwen3.8-27b, 2026-10-01). Kept out of manager.test.ts (size ceiling).
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-gate-loop-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createGezel({ name: 'Bo', role: 'Reviewer' });
  await store.createProject({ name: 'Default' });
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  tasks = new TaskManager(store);
  manager.setTaskAdvancer(async (projectId, num, stepId, goto) => {
    const outcome = await tasks.completeStepChecked(projectId, num, stepId, goto, {
      cause: 'auto',
    });
    return outcome.status === 'advanced'
      ? { status: 'advanced' as const }
      : {
          status: 'held' as const,
          message: outcome.gate.message,
          messageFingerprint: outcome.gate.messageFingerprint,
          attempt: outcome.gate.attempt,
          ...(outcome.gate.paused ? { paused: true } : {}),
          ...(outcome.task.activeStepId ? { activeStepId: outcome.task.activeStepId } : {}),
        };
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — gate loop to another step', () => {
  it('yields the rejected session instead of re-prompting it toward the gaps', async () => {
    const task = await tasks.create('default', {
      title: 'Review loop',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        { id: 'build', name: 'Build', prompt: 'Write index.html.', next: 'evaluate' },
        {
          id: 'evaluate',
          name: 'Evaluate',
          prompt: 'Write verdict.md ending each line in PASS or FAIL.',
          assignee: { kind: 'gezel', gezelId: 'bo' },
          advanceWhen: { file: 'verdict.md', minBytes: 4 },
          gate: {
            at: 'completion' as const,
            checks: [
              {
                kind: 'notContains' as const,
                file: 'verdict.md',
                pattern: 'FAIL\\s*$',
                flags: 'm',
              },
            ],
            onReject: 'build',
            maxAttempts: 3,
          },
        },
      ],
      entryStepId: 'evaluate',
    });
    mock.script('Starting the review.');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'bo',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'evaluate',
      kind: 'entry',
    });
    await manager.drainBackground();

    await store.writeProjectWorkspaceFile('default', 'verdict.md', 'Totals reconcile FAIL\n');
    mock.script('Wrote the verdict.', 'A re-prompt this session must never receive.');
    const before = mock.calls.length;
    await manager.send(sessionId, 'Finish the review.');

    const after = await store.readTask('default', task.num);
    expect(after?.activeStepId).toBe('build');
    // One model call for the send itself; no gate re-prompt into the stale step.
    expect(mock.calls.length - before).toBe(1);
  });
});
