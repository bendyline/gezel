import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stepOwnerGezelId } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { followCurrentTurnReactivation } from '../tasks/current-turn-reactivation.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskRunner } from '../tasks/runner.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A generalist owner walks every step of a review loop in one session. When
 * the review's gate routes the task back to the writer while the owner's turn
 * is still running, that turn must neither approve the re-activated step on
 * the deliverable its earlier pass left, nor be reported as a failed handoff,
 * nor push the owner into a second session. Wild-caught on GPT-6.1 Sol through
 * codex-cli (2026-11-10): research-report paused on a gate plateau after one
 * real rejection, and content-accuracy-review and corpus-synthesis paused with
 * `step_stalled` while the model was working normally.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const REPORT = 'tasks/eval/report.md';
const VERDICT = 'tasks/eval/verdict.md';

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;
let tasks: TaskManager;
let runner: TaskRunner;
let exhausted: Mock<Parameters<ChatManager['setHandoffExhaustedHandler']>[0]>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-generalist-loopback-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: 'copilot' });
  await store.createGezel({ name: 'Kiki', role: 'Fact Checker' });
  await store.createProject({ name: 'p1' });
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
  runner = new TaskRunner({
    store,
    dispatcher: {
      startHandoffSession: (args) => manager.startHandoffSession(args),
      cancelHandoffSession: (sessionId, pass) => manager.cancelSupersededHandoff(sessionId, pass),
      isHandoffSessionActive: (sessionId) => manager.isSessionTurnPending(sessionId),
      resolveProviderName: async () => 'copilot',
      getProvider: () => mock,
    },
  });
  // The product-service wirings these paths depend on.
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
  tasks.setStepActivatedHook(async ({ task, newStep, completedStep, kind }) => {
    const owner = stepOwnerGezelId(task, newStep);
    if (!owner) return;
    runner.enqueueHandoff({
      gezelId: owner,
      projectId: task.projectId,
      taskRef: task.ref,
      stepId: newStep.id,
      ...(newStep.lastActivatedAt ? { activationAt: newStep.lastActivatedAt } : {}),
      ...(kind === 'entry' ? { kind: 'entry' as const } : {}),
      fromGezelId: stepOwnerGezelId(task, completedStep) ?? owner,
    });
  });
  tasks.setCurrentTurnStepReactivatedHook((ctx) =>
    followCurrentTurnReactivation({ chat: manager, runner }, ctx),
  );
  exhausted = vi.fn(async () => {});
  manager.setHandoffExhaustedHandler(exhausted);
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

async function createReviewLoopTask() {
  const task = await tasks.create('p1', {
    title: 'Cited research report',
    description: 'Write a cited report, review it, and loop back to the writer when it fails.',
    assignee: { kind: 'gezel', gezelId: 'kiki' },
    executionMode: 'generalist',
    steps: [
      {
        id: 'write',
        name: 'Write the report',
        prompt: `Write ${REPORT} with write_artifact.`,
        toolPolicy: { outputMedium: 'artifact' },
        advanceWhen: { file: REPORT, artifact: true, minBytes: 20 },
        gate: {
          at: 'completion' as const,
          checks: [{ kind: 'minBytes' as const, file: REPORT, artifact: true, bytes: 20 }],
          maxAttempts: 3,
        },
        next: 'evaluate',
      },
      {
        id: 'evaluate',
        name: 'Evaluate',
        prompt: `Review the report and write ${VERDICT} with write_artifact, marking each criterion PASS or FAIL.`,
        toolPolicy: { outputMedium: 'artifact' },
        advanceWhen: { file: VERDICT, artifact: true, minBytes: 4 },
        gate: {
          at: 'completion' as const,
          checks: [
            { kind: 'notContains' as const, file: VERDICT, artifact: true, pattern: '\\bFAIL\\b' },
          ],
          onReject: 'write',
          maxAttempts: 3,
        },
        terminal: true,
      },
    ],
    entryStepId: 'write',
    createdBy: { kind: 'user' },
  });
  expect(task.executionMode).toBe('generalist');
  runner.enqueueHandoff({
    gezelId: 'kiki',
    projectId: 'p1',
    taskRef: task.ref,
    stepId: 'write',
    kind: 'entry',
  });
  return task;
}

const sends = () => mock.calls.filter((call) => call.kind === 'send').length;

/**
 * One dispatched owner turn: the runner starts it, `work` stands in for what
 * the model does while the turn is open (its writes and `advance_task_step`),
 * then the turn ends.
 */
async function ownerTurn(work: () => Promise<void>, reply: string): Promise<void> {
  await manager.drainBackground();
  const before = sends();
  const turn = mock.scriptStreamThenStall(reply);
  await runner.tick();
  await vi.waitFor(() => expect(sends()).toBeGreaterThan(before), { timeout: 5000, interval: 5 });
  await work();
  turn.release();
  await manager.drainBackground();
}

/** Stand-in for the model's `advance_task_step` call. */
const advance = (num: number, stepId: string) =>
  tasks.completeStepChecked('p1', num, stepId, undefined, { cause: 'model' });

async function taskSessions(ref: string) {
  return store.listTaskSessions(ref, { projectId: 'p1' });
}

async function recoveryPrompts(ref: string): Promise<number> {
  let count = 0;
  for (const summary of await taskSessions(ref)) {
    const session = await store.getSession(summary.gezelId, summary.id);
    count += (session?.messages ?? []).filter((m) =>
      m.content.includes('automatic handoff turn'),
    ).length;
  }
  return count;
}

async function gateRejections(num: number, stepId: string): Promise<number> {
  return (await store.listTaskNotes('p1', num, stepId)).filter((note) =>
    note.text.startsWith('# Gate — not yet met'),
  ).length;
}

describe('generalist owner — gate loop-back while the owner is mid-turn', () => {
  it('leaves the re-activated step to its own pass and counts the review rejection once', async () => {
    const task = await createReviewLoopTask();

    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', REPORT, 'Draft report with sources [1].');
      await advance(task.num, 'write');
    }, 'Report written.');
    expect((await store.readTask('p1', task.num))?.activeStepId).toBe('evaluate');

    // The review fails and routes the task back to `write` while the turn
    // that wrote the verdict is still open.
    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', VERDICT, 'Citation format: FAIL');
      await advance(task.num, 'evaluate');
    }, 'The citation format needs a fix; back to the report.');
    const looped = await store.readTask('p1', task.num);
    expect(looped?.activeStepId).toBe('write');
    expect(looped?.craftbook.steps.find((s) => s.id === 'write')?.completedAt).toBeUndefined();
    expect(await gateRejections(task.num, 'evaluate')).toBe(1);

    // The writer's own pass revises the report.
    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', REPORT, 'Revised report with sources (source: a.md).');
      await advance(task.num, 'write');
    }, 'Citations fixed.');
    expect((await store.readTask('p1', task.num))?.activeStepId).toBe('evaluate');

    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', VERDICT, 'Citation format: PASS');
      await advance(task.num, 'evaluate');
    }, 'Every criterion passes.');

    const done = await store.readTask('p1', task.num);
    expect(done?.status).toBe('complete');
    expect(await gateRejections(task.num, 'evaluate')).toBe(1);
    expect(await taskSessions(task.ref)).toHaveLength(1);
    expect(await recoveryPrompts(task.ref)).toBe(0);
    expect(exhausted).not.toHaveBeenCalled();
  });

  it('does not retry a handoff whose step began a newer pass while its turn ran, and keeps one session', async () => {
    const task = await createReviewLoopTask();
    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', REPORT, 'Draft report with sources [1].');
      await advance(task.num, 'write');
    }, 'Report written.');

    // While the review turn is open the task loops back to `write`, and the
    // person finishes the revision themselves: `evaluate` is active again on
    // a NEW activation, which the runner dispatches separately.
    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', VERDICT, 'Citation format: FAIL');
      await advance(task.num, 'evaluate');
      await store.writeProjectArtifact('p1', REPORT, 'Revised report with sources (source: a.md).');
      await tasks.completeStepChecked('p1', task.num, 'write', undefined, { cause: 'user' });
    }, 'The citation format needs a fix.');
    const reactivated = await store.readTask('p1', task.num);
    expect(reactivated?.activeStepId).toBe('evaluate');
    expect(await recoveryPrompts(task.ref)).toBe(0);
    expect(exhausted).not.toHaveBeenCalled();

    // The newer pass continues the owner's one transcript.
    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', VERDICT, 'Citation format: PASS');
      await advance(task.num, 'evaluate');
    }, 'Every criterion passes.');
    expect((await store.readTask('p1', task.num))?.status).toBe('complete');
    expect(await taskSessions(task.ref)).toHaveLength(1);
    expect(await recoveryPrompts(task.ref)).toBe(0);
    expect(exhausted).not.toHaveBeenCalled();
  });

  it('drops a queued re-pin whose pass ended while the owner was still busy', async () => {
    const task = await createReviewLoopTask();
    await manager.drainBackground();
    const turn = mock.scriptStreamThenStall('Report written.');
    await runner.tick();
    await vi.waitFor(() => expect(sends()).toBe(1), { timeout: 5000, interval: 5 });
    await store.writeProjectArtifact('p1', REPORT, 'Draft report with sources [1].');
    await advance(task.num, 'write');
    // `evaluate`'s dispatch reuses the owner's session and waits for it.
    await runner.tick();
    // The person settles the review before that turn ends.
    await store.writeProjectArtifact('p1', VERDICT, 'Citation format: PASS');
    await tasks.completeStepChecked('p1', task.num, 'evaluate', undefined, { cause: 'user' });
    turn.release();
    await manager.drainBackground();

    expect((await store.readTask('p1', task.num))?.status).toBe('complete');
    const [summary] = await taskSessions(task.ref);
    const session = await store.getSession('kiki', summary!.id);
    expect(session?.stepId).toBe('write');
    expect(session?.messages.some((m) => m.content.includes('`evaluate`'))).toBe(false);
    expect(session?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('still retries a handoff whose own turn took over the pass its gate self-loop opened', async () => {
    const task = await tasks.create('p1', {
      title: 'Publish observations',
      description: 'One checkpoint step whose gate loops back to itself until it is verified.',
      assignee: { kind: 'gezel', gezelId: 'kiki' },
      steps: [
        {
          id: 'review',
          name: 'Review',
          prompt: 'Write observations.md with write_artifact.',
          toolPolicy: { outputMedium: 'artifact' },
          advanceWhen: { file: 'observations.md', artifact: true, minBytes: 20 },
          gate: {
            at: 'completion' as const,
            checks: [
              {
                kind: 'contains' as const,
                file: 'observations.md',
                artifact: true,
                pattern: 'verified',
              },
            ],
            onReject: 'review',
            maxAttempts: 4,
          },
          terminal: true,
        },
      ],
      entryStepId: 'review',
      createdBy: { kind: 'user' },
    });
    runner.enqueueHandoff({
      gezelId: 'kiki',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'review',
      kind: 'entry',
    });
    const firstPass = (await store.readTask('p1', task.num))?.craftbook.steps[0]?.lastActivatedAt;

    await ownerTurn(async () => {
      await store.writeProjectArtifact('p1', 'observations.md', 'short');
      await advance(task.num, 'review');
    }, 'Still drafting the observations.');

    const after = await store.readTask('p1', task.num);
    expect(after?.craftbook.steps[0]?.lastActivatedAt).not.toBe(firstPass);
    expect(await recoveryPrompts(task.ref)).toBeGreaterThan(0);
  });
});

describe('ChatManager.cancelSupersededHandoff', () => {
  it("keeps the turn a session runs for another step, and cancels the superseded pass's own turn", async () => {
    const task = await createReviewLoopTask();
    const session = await manager.createSession({
      gezelId: 'kiki',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'evaluate',
      stepActivationId: '2026-11-10T03:50:29.789Z',
    });
    mock.scriptStreamThenHang('Reviewing the report.');
    const turn = manager.send(session.id, 'Review the report.').catch((err: unknown) => err);
    await vi.waitFor(() => expect(manager.isSessionTurnPending(session.id)).toBe(true), {
      timeout: 5000,
      interval: 5,
    });
    await vi.waitFor(() => expect(sends()).toBe(1), { timeout: 5000, interval: 5 });

    // An earlier `write` dispatch, and an earlier pass of `evaluate`, went stale.
    expect(
      await manager.cancelSupersededHandoff(session.id, {
        taskRef: task.ref,
        stepId: 'write',
        activationAt: '2026-11-10T03:49:21.272Z',
      }),
    ).toEqual({ cancelled: false });
    expect(
      await manager.cancelSupersededHandoff(session.id, {
        taskRef: task.ref,
        stepId: 'evaluate',
        activationAt: '2026-11-10T03:49:54.724Z',
      }),
    ).toEqual({ cancelled: false });
    expect(manager.isSessionTurnPending(session.id)).toBe(true);

    // The dispatch of the pass this session serves did go stale.
    expect(
      await manager.cancelSupersededHandoff(session.id, {
        taskRef: task.ref,
        stepId: 'evaluate',
        activationAt: '2026-11-10T03:50:29.789Z',
      }),
    ).toEqual({ cancelled: true });
    await turn;
  });
});
