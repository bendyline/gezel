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
 * The turn that carries a gate's verdict repairs what the gate named, so it
 * asks its provider for a reduced thinking budget; every other turn keeps the
 * full one. A 15-shard pull-request review spent its whole 4,096-token budget
 * on each repair turn (qwen3.8-27b, 2026-11-17). Kept out of manager.test.ts
 * (size ceiling).
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
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-gate-repair-test-'));
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

function sendsSince(index: number) {
  return mock.calls.slice(index).filter((call) => call.kind === 'send');
}

describe('ChatManager — thinking budget on a gate-repair turn', () => {
  it('reduces thinking for the turn that carries the verdict, and only that turn', async () => {
    const task = await tasks.create('default', {
      title: 'Write the notes',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          id: 'write',
          name: 'Write',
          prompt: 'Write notes.md with a Summary heading.',
          advanceWhen: { file: 'notes.md', minBytes: 4 },
          gate: {
            at: 'completion' as const,
            checks: [{ kind: 'contains' as const, file: 'notes.md', pattern: '## Summary' }],
            onReject: 'write',
            maxAttempts: 4,
          },
        },
      ],
      entryStepId: 'write',
    });
    mock.script('Starting on the notes.');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'write',
      kind: 'entry',
    });
    await manager.drainBackground();

    await store.writeProjectWorkspaceFile('default', 'notes.md', 'Notes with no heading.\n');
    mock.script('Wrote the notes.', 'Added the heading.');
    const beforeRepair = mock.calls.length;
    await manager.send(sessionId, 'Finish the notes.');

    const repairSends = sendsSince(beforeRepair);
    expect(repairSends).toHaveLength(2);
    expect(repairSends[0]?.sendOpts?.reducedThinking).toBeUndefined();
    expect(repairSends[1]?.prompt).toContain('## Summary');
    expect(repairSends[1]?.sendOpts?.reducedThinking).toBe(true);

    mock.script('You are welcome.');
    const beforeOrdinary = mock.calls.length;
    await manager.send(sessionId, 'Thanks.');
    const ordinarySends = sendsSince(beforeOrdinary);
    expect(ordinarySends.length).toBeGreaterThan(0);
    for (const send of ordinarySends) {
      expect(send.sendOpts?.reducedThinking).toBeUndefined();
    }
  });

  it('retries a fixed-action handoff the gate rejected on the reduced budget', async () => {
    const task = await tasks.create('default', {
      title: 'Checkpoint the notes',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          id: 'write',
          name: 'Write',
          prompt: 'Call write_artifact to write notes.md with a Summary heading.',
          toolPolicy: { outputMedium: 'artifact' as const },
          advanceWhen: { file: 'notes.md', minBytes: 4, artifact: true },
          gate: {
            at: 'completion' as const,
            checks: [
              {
                kind: 'contains' as const,
                file: 'notes.md',
                pattern: '## Summary',
                artifact: true,
              },
            ],
            maxAttempts: 20,
          },
        },
      ],
      entryStepId: 'write',
    });
    await store.writeProjectArtifact('default', 'notes.md', 'Notes with no heading.\n');

    await manager.startHandoffSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'write',
      kind: 'entry',
    });
    // The unchanged artifact fails the gate until it pauses the task, which
    // ends the handoff's bounded retries.
    await manager.drainBackground();

    const sends = mock.calls.filter((call) => call.kind === 'send');
    const seed = sends[0];
    expect(seed?.sendOpts?.reducedThinking).toBeUndefined();
    // startsWith: a memory-extraction one-shot quotes the retry inside its own prompt.
    const retries = sends.filter((send) =>
      send.prompt?.startsWith('The automatic handoff turn ended before fixed-action step'),
    );
    expect(retries).toHaveLength(1);
    for (const retry of retries) {
      expect(retry.sendOpts?.reducedThinking).toBe(true);
    }
  });
});
