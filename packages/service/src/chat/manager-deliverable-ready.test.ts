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
 * The mid-turn "deliverable is ready" probe ChatManager hands local
 * providers (ActiveCraftbookStep.deliverableReady). Kept out of
 * manager.test.ts, which is at its module-size ceiling.
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-ready-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
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
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — mid-turn deliverable readiness', () => {
  // spreadsheet-model 1.0.4 `build`: advanceWhen is judged only at end of
  // turn, so a local loop needs the same verdict mid-turn to stop polishing.
  it('wires a mid-turn readiness probe that agrees with the end-of-turn advance check', async () => {
    const taskMgr = new TaskManager(store);
    const task = await taskMgr.create('default', {
      title: 'Offline model',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          id: 'build',
          name: 'Build the model',
          prompt: 'Write model/index.html, then model/sw.js. Call write_task_note with the path.',
          advanceWhen: { file: 'model/index.html', minBytes: 1, sniff: 'html-complete' as const },
          gate: {
            at: 'completion' as const,
            checks: [{ kind: 'contains' as const, file: 'model/sw.js', pattern: 'install' }],
            onReject: 'build',
            maxAttempts: 4,
          },
          next: 'review',
        },
        { id: 'review', name: 'Review', assignee: { kind: 'user' as const } },
      ],
      entryStepId: 'build',
    });
    const session = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'build',
    });
    mock.script('Working.');
    await manager.send(session.id, 'Continue the build step.');

    const step = mock.calls.find((c) => c.kind === 'create')?.opts?.activeCraftbookStep;
    expect(step?.deliverableFile).toBe('model/index.html');
    const ready = step?.deliverableReady;
    expect(ready).toBeTypeOf('function');
    expect(await ready!({ writtenThisTurn: true })).toBe(false);
    await store.writeProjectWorkspaceFile(
      'default',
      'model/index.html',
      '<!doctype html><html><body><main>Model</main></body></html>',
    );
    // advanceWhen holds, but the gate's other file is still unwritten.
    expect(await ready!({ writtenThisTurn: true })).toBe(false);
    await store.writeProjectWorkspaceFile(
      'default',
      'model/sw.js',
      "self.addEventListener('install', () => {});",
    );
    expect(await ready!({ writtenThisTurn: false })).toBe(true);
    // Once ownership moves on, the probe stops vouching for the step.
    await taskMgr.setStatus('default', task.num, 'paused');
    expect(await ready!({ writtenThisTurn: true })).toBe(false);
  });

  it('gives artifact checkpoints and requireChange steps the right readiness semantics', async () => {
    const taskMgr = new TaskManager(store);
    const artifactTask = await taskMgr.create('default', {
      title: 'Checkpoint',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          id: 'scope',
          name: 'Scope',
          prompt: 'Write the checkpoint.',
          advanceWhen: { file: 'tasks/1/billables.json', artifact: true, minBytes: 2 },
        },
      ],
    });
    const artifactSession = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: artifactTask.ref,
      stepId: 'scope',
    });
    mock.script('ok');
    await manager.send(artifactSession.id, 'go');
    const artifactStep = mock.calls.filter((c) => c.kind === 'create').at(-1)
      ?.opts?.activeCraftbookStep;
    expect(artifactStep?.deliverableIsArtifact).toBe(true);
    expect(artifactStep?.deliverableReady).toBeUndefined();

    await store.writeProjectWorkspaceFile('default', 'src/geo.ts', 'export const x = 1;\n');
    const editTask = await taskMgr.create('default', {
      title: 'Fix geo',
      assignee: { kind: 'gezel', gezelId: 'ada' },
      steps: [
        {
          id: 'fix',
          name: 'Fix',
          prompt: 'Fix src/geo.ts.',
          advanceWhen: { file: 'src/geo.ts', minBytes: 1, requireChange: true },
        },
      ],
    });
    const editSession = await manager.createSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: editTask.ref,
      stepId: 'fix',
    });
    mock.script('ok');
    await manager.send(editSession.id, 'go');
    const editReady = mock.calls.filter((c) => c.kind === 'create').at(-1)?.opts
      ?.activeCraftbookStep?.deliverableReady;
    // A file that already existed proves nothing until this turn edits it.
    expect(await editReady!({ writtenThisTurn: false })).toBe(false);
    expect(await editReady!({ writtenThisTurn: true })).toBe(true);
  });
});
