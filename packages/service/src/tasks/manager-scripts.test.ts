import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { ScriptRunner } from '../scripts/runner.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { TaskManager } from './manager.js';

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let tasks: TaskManager;
let chat: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-tasks-scripts-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.createProject({ name: 'Default' });
  await store.createGezel({ name: 'Ada', role: 'Developer' });

  const mock = new MockProvider({ name: 'copilot' });
  chat = new ChatManager({
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
  tasks.setScriptRunner(new ScriptRunner({ store, chat }));
});

afterEach(async () => {
  await chat.drainBackground();
  await chat.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function writeScript(name: string, source: string): Promise<void> {
  const dir = join(home, 'projects', 'default', 'scripts');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), source, 'utf8');
}

describe('TaskManager phase hooks — onEnter with autoAdvanceOnSuccess', () => {
  it('auto-advances to the next phase when the script succeeds', async () => {
    const handoff = vi.fn(async () => {});
    tasks.setStepActivatedHook(handoff);
    const run = vi.fn(async () => ({
      id: 'entry-setup',
      projectId: 'default',
      scriptName: 'mark-done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'ok' as const,
      trigger: { kind: 'manual' as const, userInitiated: true as const },
      inputs: {},
      output: { ok: true },
      calls: [],
      logs: '',
    }));
    tasks.setScriptRunner({ run } as unknown as ScriptRunner);

    const task = await tasks.create('default', {
      title: 'Auto-advance demo',
      description: 'exercises onEnter + autoAdvanceOnSuccess for two phases.',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'First',
          assignee: { kind: 'user' },
          onEnter: { name: 'mark-done', scope: 'standard', autoAdvanceOnSuccess: true },
        },
        {
          name: 'Second',
          assignee: { kind: 'user' },
        },
      ],
    });

    const [first, second] = task.craftbook.steps;
    expect(task.activeStepId).toBe(second!.id);
    expect(first!.onEnterCompletedAt).toBe(first!.lastActivatedAt);
    expect(run).toHaveBeenCalledTimes(1);
    // The create route dispatches the current step returned by create(); the
    // auto-advance cascade must not also enqueue it through this hook.
    expect(handoff).not.toHaveBeenCalled();
  });

  it('does not repeat setup for an already-prepared activation', async () => {
    const run = vi.fn(async () => ({
      id: 'prepare-once',
      projectId: 'default',
      scriptName: 'prepare-once',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'ok' as const,
      trigger: { kind: 'manual' as const, userInitiated: true as const },
      inputs: {},
      output: { ok: true },
      calls: [],
      logs: '',
    }));
    tasks.setScriptRunner({ run } as unknown as ScriptRunner);

    const task = await tasks.create('default', {
      title: 'Prepare once',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Prepared work',
          assignee: { kind: 'user' },
          onEnter: { name: 'prepare-once', scope: 'standard' },
        },
      ],
    });

    expect(task.craftbook.steps[0]!.onEnterCompletedAt).toBe(
      task.craftbook.steps[0]!.lastActivatedAt,
    );
    await tasks.ensureActiveStepEntered('default', task.num);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pauses before handoff when entry-step setup fails', async () => {
    tasks.setScriptRunner({
      run: async () => ({
        id: 'broken-entry-setup',
        projectId: 'default',
        scriptName: 'prepare-corpus',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error' as const,
        trigger: { kind: 'manual' as const, userInitiated: true as const },
        inputs: {},
        calls: [],
        logs: 'missing source manifest',
        error: 'corpus preparation failed',
      }),
    } as unknown as ScriptRunner);

    const task = await tasks.create('default', {
      title: 'Setup must finish before handoff',
      assignee: { kind: 'user' },
      steps: [
        {
          name: 'Review corpus',
          assignee: { kind: 'user' },
          onEnter: { name: 'prepare-corpus', scope: 'standard' },
        },
      ],
    });

    expect(task.status).toBe('paused');
    expect(task.craftbook.steps[0]!.onEnterCompletedAt).toBeUndefined();
    const notes = await tasks.listNotes('default', task.num);
    expect(notes.at(-1)?.text).toContain('# Step setup failed — task paused');
    expect(notes.at(-1)?.text).toContain('corpus preparation failed');
  });

  it.runIf(process.platform === 'darwin')(
    'cascades through consecutive auto-advance phases',
    async () => {
      await writeScript(
        'always-ok',
        `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'always-ok',
          description: 'returns ok=true so the phase advances automatically.',
          outputs: { ok: { type: 'boolean', description: 'flag' } },
        });
        gezel.output({ ok: true });
      `,
      );

      const task = await tasks.create('default', {
        title: 'Cascade',
        description: 'three phases in a row that all auto-advance on success.',
        assignee: { kind: 'user' },
        steps: [
          { name: 'A', assignee: { kind: 'user' } },
          {
            name: 'B',
            assignee: { kind: 'user' },
            onEnter: { name: 'always-ok', autoAdvanceOnSuccess: true },
          },
          {
            name: 'C',
            assignee: { kind: 'user' },
            onEnter: { name: 'always-ok', autoAdvanceOnSuccess: true },
          },
          { name: 'D', assignee: { kind: 'user' } },
        ],
      });

      // Completing A should run B's onEnter (ok) → advance to C → run
      // C's onEnter (ok) → advance to D. D has no onEnter so it sticks.
      const result = await tasks.completeStep('default', task.num, task.craftbook.steps[0]!.id);
      expect(result.activeStepId).toBe(task.craftbook.steps[3]!.id);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'honors autoAdvanceWhen predicates over the raw success flag',
    async () => {
      await writeScript(
        'report-count',
        `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'report-count',
          description: 'reports how many items it found.',
          inputs: {
            count: { type: 'number', description: 'items to report', required: true },
          },
          outputs: { count: { type: 'number', description: 'count' } },
        });
        gezel.output({ count: (gezel.input as { count: number }).count });
      `,
      );

      const makeTask = async (count: number) =>
        tasks.create('default', {
          title: `count-${count}`,
          description: 'exits early when count is zero, waits for voorman otherwise.',
          assignee: { kind: 'user' },
          steps: [
            { name: 'Kickoff', assignee: { kind: 'user' } },
            {
              name: 'Check',
              assignee: { kind: 'user' },
              onEnter: {
                name: 'report-count',
                inputs: { count },
                autoAdvanceWhen: { op: 'equals', field: 'count', value: 0 },
              },
            },
            { name: 'Done', assignee: { kind: 'user' } },
          ],
        });

      // Count is zero → advance through Check to Done.
      const tZero = await makeTask(0);
      const zeroResult = await tasks.completeStep(
        'default',
        tZero.num,
        tZero.craftbook.steps[0]!.id,
      );
      expect(zeroResult.activeStepId).toBe(tZero.craftbook.steps[2]!.id);

      // Count non-zero → predicate false, Check stays active.
      const tNonZero = await makeTask(5);
      const nzResult = await tasks.completeStep(
        'default',
        tNonZero.num,
        tNonZero.craftbook.steps[0]!.id,
      );
      expect(nzResult.activeStepId).toBe(tNonZero.craftbook.steps[1]!.id);
    },
  );

  it.runIf(process.platform === 'darwin')(
    'runs onExit of the completed phase (but does not block transition)',
    async () => {
      await writeScript(
        'write-note',
        `
        import { gezel, defineScript } from '@bendyline/gezel-sdk';
        export const meta = defineScript({
          name: 'write-note',
          description: 'writes an artifact as a side-effect on exit.',
          requires: ['artifacts.write'],
        });
        await gezel.artifacts.write('onExit.marker', 'done');
      `,
      );

      const task = await tasks.create('default', {
        title: 'Exit writes a marker',
        description: 'exercises onExit script-side-effect without blocking the advance.',
        assignee: { kind: 'user' },
        steps: [
          {
            name: 'A',
            assignee: { kind: 'user' },
            onExit: { name: 'write-note' },
          },
          { name: 'B', assignee: { kind: 'user' } },
        ],
      });

      await tasks.completeStep('default', task.num, task.craftbook.steps[0]!.id);
      const marker = await store.readProjectArtifact('default', 'onExit.marker');
      expect(marker).toBe('done');
    },
  );
});
