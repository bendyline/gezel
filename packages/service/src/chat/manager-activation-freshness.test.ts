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
import { bindStepActivation, servesEarlierActivation } from './session-step-activation.js';

/**
 * End-of-turn observable advance must come from the session serving the
 * step's CURRENT activation. Wild-caught on spreadsheet-model (2026-09-30):
 * a nudge into build's first-pass session ended after evaluate had looped
 * back to build, and auto-advanced the NEW build pass on an unchanged
 * index.html. Kept out of manager.test.ts, which is at its size ceiling.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const FULL_PAGE = '<!doctype html><html><body><main>Revenue model</main></body></html>';

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;
let tasks: TaskManager;

/** Activation stamps are ISO milliseconds; keep two passes from colliding. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-mgr-activation-test-'));
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
  // The two product-service wirings this guard depends on.
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
        };
  });
  tasks.setCurrentTurnStepReactivatedHook(({ task, newStep, gatedStep, previousActivationAt }) => {
    if (newStep.id !== gatedStep.id || !newStep.lastActivatedAt) return;
    manager.adoptStepActivation({
      taskRef: task.ref,
      stepId: newStep.id,
      previousActivationAt,
      activationAt: newStep.lastActivatedAt,
    });
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function createBuildEvaluateTask(gate?: { pattern: string }) {
  return tasks.create('default', {
    title: 'Offline revenue model',
    assignee: { kind: 'gezel', gezelId: 'ada' },
    steps: [
      {
        id: 'build',
        name: 'Build',
        prompt: 'Write index.html.',
        advanceWhen: { file: 'index.html', minBytes: 40 },
        ...(gate
          ? {
              gate: {
                at: 'completion' as const,
                checks: [{ kind: 'contains' as const, file: 'index.html', pattern: gate.pattern }],
                onReject: 'build',
                maxAttempts: 4,
              },
            }
          : {}),
        next: 'evaluate',
      },
      {
        id: 'evaluate',
        name: 'Evaluate',
        prompt: 'Review index.html.',
        assignee: { kind: 'gezel', gezelId: 'bo' },
      },
    ],
    entryStepId: 'build',
  });
}

async function buildStep(num: number) {
  const task = await store.readTask('default', num);
  const step = task?.craftbook.steps.find((s) => s.id === 'build');
  return { task, step };
}

async function binding(sessionId: string) {
  return (await store.getSession('ada', sessionId))?.stepActivationId;
}

describe('ChatManager — observable advance activation freshness', () => {
  it('binds a dispatched session to its pass and lets it advance that pass', async () => {
    const task = await createBuildEvaluateTask();
    mock.script('Starting on the model.');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'build',
      kind: 'entry',
    });
    await manager.drainBackground();
    const { step } = await buildStep(task.num);
    expect(step?.lastActivatedAt).toBeTruthy();
    expect(await binding(sessionId)).toBe(step?.lastActivatedAt);

    await store.writeProjectWorkspaceFile('default', 'index.html', FULL_PAGE);
    mock.script('Built it.');
    await manager.send(sessionId, 'Continue the build step.');

    expect((await store.readTask('default', task.num))?.activeStepId).toBe('evaluate');
  });

  it('refuses the earlier pass after evaluate loops back to build; only the new build session advances', async () => {
    const task = await createBuildEvaluateTask();
    mock.script('Starting on the model.');
    const first = await manager.startHandoffSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'build',
      kind: 'entry',
    });
    await manager.drainBackground();
    await store.writeProjectWorkspaceFile('default', 'index.html', FULL_PAGE);
    mock.script('Built it.');
    await manager.send(first.sessionId, 'Continue the build step.');
    const firstPass = (await buildStep(task.num)).step?.lastActivatedAt;
    expect((await store.readTask('default', task.num))?.activeStepId).toBe('evaluate');

    // The reviewer routes back to build: a second pass of the same step id.
    await tick();
    await tasks.completeStepChecked('default', task.num, 'evaluate', 'build', { cause: 'model' });
    const secondPass = (await buildStep(task.num)).step?.lastActivatedAt;
    expect(secondPass).toBeTruthy();
    expect(secondPass).not.toBe(firstPass);

    // The new pass's dispatch opens its own session; its first turn has not
    // produced the deliverable yet.
    await store.writeProjectWorkspaceFile('default', 'index.html', '<p>wip</p>');
    mock.script('Rebuilding from the review notes.');
    const second = await manager.startHandoffSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'build',
      fromGezelId: 'bo',
    });
    await manager.drainBackground();
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await binding(second.sessionId)).toBe(secondPass);
    expect(await binding(first.sessionId)).toBe(firstPass);

    // A nudge into the first pass's session ends with a deliverable that
    // satisfies advanceWhen. That turn is not the current pass's work.
    await store.writeProjectWorkspaceFile('default', 'index.html', FULL_PAGE);
    mock.script('Looks done to me.');
    await manager.send(first.sessionId, 'Status check: is the model finished?');
    const afterStale = await buildStep(task.num);
    expect(afterStale.task?.activeStepId).toBe('build');
    expect(afterStale.step?.completedAt).toBeUndefined();
    expect(afterStale.step?.lastActivatedAt).toBe(secondPass);

    // A runtime re-drive lands on the current pass's session even though the
    // stale one is more recent, and that session advances the step.
    mock.script('Rebuilt and verified.');
    const redrive = await manager.nudgeTaskStep({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'build',
      text: 'Keep going on the build step.',
    });
    expect(redrive.sessionId).toBe(second.sessionId);
    await manager.drainBackground();
    expect((await store.readTask('default', task.num))?.activeStepId).toBe('evaluate');
  });

  it('keeps a gate self-loop repair turn bound to the pass its own rejection opened', async () => {
    const task = await createBuildEvaluateTask({ pattern: 'install' });
    mock.script('Starting on the model.');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'ada',
      projectId: 'default',
      taskRef: task.ref,
      stepId: 'build',
      kind: 'entry',
    });
    await manager.drainBackground();
    const firstPass = (await buildStep(task.num)).step?.lastActivatedAt;

    // advanceWhen holds but the completion gate rejects and loops the step
    // back to itself — a fresh activation that this same turn repairs.
    await tick();
    await store.writeProjectWorkspaceFile('default', 'index.html', FULL_PAGE);
    mock.script('Built it.', 'Working on the gate feedback.', 'Still working.');
    await manager.send(sessionId, 'Continue the build step.');
    const held = await buildStep(task.num);
    expect(held.task?.activeStepId).toBe('build');
    expect(held.step?.lastActivatedAt).not.toBe(firstPass);
    expect(await binding(sessionId)).toBe(held.step?.lastActivatedAt);

    await store.writeProjectWorkspaceFile(
      'default',
      'index.html',
      `${FULL_PAGE}\n<script>self.addEventListener('install', () => {});</script>`,
    );
    mock.script('Fixed the service worker hook.');
    await manager.send(sessionId, 'The gate feedback is addressed; finish the step.');
    expect((await store.readTask('default', task.num))?.activeStepId).toBe('evaluate');
  });
});

describe('servesEarlierActivation', () => {
  const step = { id: 'build', lastActivatedAt: '2026-09-30T20:41:38.000Z' };

  it('judges only a session bound to another pass of the same pinned step', () => {
    const pinned = { taskRef: 'p/1', stepId: 'build' };
    expect(
      servesEarlierActivation(
        { ...pinned, stepActivationId: '2026-09-30T20:16:56.000Z' },
        'p/1',
        step,
      ),
    ).toBe(true);
    expect(
      servesEarlierActivation({ ...pinned, stepActivationId: step.lastActivatedAt }, 'p/1', step),
    ).toBe(false);
    // Unbound sessions (older installs, ad-hoc threads) keep today's behavior.
    expect(servesEarlierActivation(pinned, 'p/1', step)).toBe(false);
    // A session pinned to a different step, or another task, is not this pass's.
    expect(
      servesEarlierActivation(
        { taskRef: 'p/1', stepId: 'scope', stepActivationId: 'x' },
        'p/1',
        step,
      ),
    ).toBe(false);
    expect(servesEarlierActivation({ ...pinned, stepActivationId: 'x' }, 'p/2', step)).toBe(false);
  });

  it('clears a binding that belonged to the previous step on re-pin', () => {
    const record: { taskRef?: string; stepId?: string; stepActivationId?: string } = {
      taskRef: 'p/1',
      stepId: 'build',
      stepActivationId: 'a',
    };
    expect(bindStepActivation(record, 'a')).toBe(false);
    expect(bindStepActivation(record, undefined)).toBe(true);
    expect('stepActivationId' in record).toBe(false);
  });
});
