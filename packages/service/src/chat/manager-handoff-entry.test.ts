import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskHandoffNote } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import { MockProvider } from '../providers/mock.js';
import type { LLMProvider } from '../providers/types.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { dispatchTaskEntry } from '../tasks/entry-dispatch.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskRunner } from '../tasks/runner.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * The D1 single-channel kickoff, end to end: create a task, dispatch
 * its entry step through the real TaskRunner, and prove the worker
 * lands in a TASK-SCOPED session — taskRef/stepId on the record, the
 * step procedure + gate contract in the system prompt, the entry-kind
 * seed message, and Theme C capability-floor routing firing for step 1
 * (developer role → small floor → routed off the 27b default).
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

function fakeLlamaModels(): LlamaCppModelManager {
  const models = [
    { id: 'worker-8b', name: 'Worker 8B', approxSizeBytes: 5e9 },
    { id: 'brain-27b', name: 'Brain 27B', approxSizeBytes: 17e9 },
  ];
  return {
    listInstalled: async () => models,
    resolveModel: async (id: string) => models.find((m) => m.id === id) ?? null,
  } as unknown as LlamaCppModelManager;
}

function fakeRouter(provider: LLMProvider) {
  const snapshot = () => ({ entries: [], committedBytes: 0, budgetBytes: 0, enforced: false });
  return {
    pool: { pickReplicaForBind: () => 0, snapshot },
    snapshot,
    bindForSession: async (name: string, modelId: string) => ({
      engineKey: `${name}:${modelId}:0`,
      provider,
    }),
  } as unknown as import('../providers/native/engine-router.js').EngineRouter;
}

let home: string;
let store: Store;
let history: HistoryManager;
let mock: MockProvider;
let manager: ChatManager;
let tasks: TaskManager;
let runner: TaskRunner;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-handoff-entry-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'p1' });
  await store.createGezel({ name: 'Worker' });
  await store.writeConfig({
    provider: 'llama-cpp',
    defaultModel: { 'llama-cpp': 'brain-27b' },
  });
  mock = new MockProvider({ name: 'llama-cpp' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['llama-cpp', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
    history,
    llamaCppModels: fakeLlamaModels(),
    engineRouter: fakeRouter(mock),
  });
  tasks = new TaskManager(store, history);
  runner = new TaskRunner({
    store,
    dispatcher: {
      startHandoffSession: (args) => manager.startHandoffSession(args),
      cancelHandoffSession: (sessionId) => manager.cancelInflight(sessionId, 'task-superseded'),
      isHandoffSessionActive: (sessionId) => manager.isSessionTurnPending(sessionId),
      resolveProviderName: async () => 'llama-cpp',
      getProvider: () => mock,
    },
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

describe('single-channel kickoff (D1)', () => {
  it.each(['startup', 'generation'] as const)(
    'retains a cold handoff so pausing during %s stops its turn',
    async (phase) => {
      const task = await tasks.create('p1', {
        title: 'Bounded cold-start review',
        assignee: { kind: 'gezel', gezelId: 'worker' },
        steps: [{ name: 'Review', assignee: { kind: 'gezel', gezelId: 'worker' } }],
        createdBy: { kind: 'user' },
      });
      const gate = mock.gateNextCreateSession();
      mock.scriptStreamThenHang('Partial review');
      let sessionId: string | undefined;
      try {
        await dispatchTaskEntry({ store, taskRunner: runner, history }, task);
        await runner.tick();
        await vi.waitFor(
          () => expect(mock.calls.some((call) => call.kind === 'create')).toBe(true),
          { timeout: 5000, interval: 10 },
        );
        sessionId = (await store.listSessions({ gezelId: 'worker' })).find(
          (session) => session.taskRef === task.ref,
        )?.id;
        expect(sessionId).toBeDefined();
        expect(manager.isAnyActive()).toBe(true);
        // The UI snapshot deliberately omits a turn until ensureState finishes.
        expect(manager.listInflight()).toEqual([]);
        // A scheduler tick inside that window must not forget its reservation.
        await runner.tick();
        if (phase === 'generation') {
          gate.release();
          await vi.waitFor(
            () => expect(mock.calls.some((call) => call.kind === 'send')).toBe(true),
            { timeout: 5000, interval: 10 },
          );
        }
        await tasks.setStatus(task.projectId, task.num, 'paused');
        await runner.tick();
        expect(manager.isAnyActive()).toBe(false);
        gate.release();
        await manager.drainBackground();
        expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(
          phase === 'startup' ? 0 : 1,
        );
        expect((await tasks.get(task.projectId, task.num))?.status).toBe('paused');
      } finally {
        gate.release();
        if (sessionId) await manager.cancelInflight(sessionId, 'task-superseded');
      }
    },
    20_000,
  );

  it('repeats a tiny fixed-action entry procedure after the generic completion sentence', async () => {
    const procedure =
      'FIRST call read_artifacts with the exact assigned record. Only after it returns, call advance_task_step.';
    const task = await tasks.create('p1', {
      title: 'Open one review record',
      description:
        'A fixed-action entry fixture that must read one artifact before its completion gate can pass.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        {
          name: 'Open record',
          prompt: procedure,
          toolPolicy: {
            outputMedium: 'none',
            allowTools: ['read_artifact', 'read_artifacts'],
          },
        },
      ],
      createdBy: { kind: 'user' },
    });

    mock.script('ok');
    await dispatchTaskEntry({ store, taskRunner: runner, history }, task);
    await runner.tick();
    await manager.drainBackground();
    const summary = (await store.listSessions({ gezelId: 'worker' })).find(
      (session) => session.taskRef === task.ref,
    );
    const full = summary ? await store.getSession('worker', summary.id) : null;
    const seed = full?.messages[0]?.content ?? '';
    expect(seed).toContain('FIXED-ACTION ENTRY');
    expect(seed).toContain(procedure);
    expect(seed).toContain('runtime evaluates the declared evidence');
    expect(seed).not.toContain('When the step is done');
  });

  it('dispatched entry lands in a task-scoped session with the contract in-prompt and step-1 routing', async () => {
    const task = await tasks.create('p1', {
      title: 'Build the landing page',
      description:
        'A single-channel kickoff fixture: one developer-shaped build step with an enforced deliverable gate.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        {
          name: 'Build',
          prompt: 'Write the landing page to index.html using write_file.',
          suggestedRole: 'developer',
          deliverable: { path: 'index.html' },
        },
        { name: 'Ship', assignee: { kind: 'user' } },
      ],
      createdBy: { kind: 'user' },
    });

    mock.script('ok');
    const dispatch = await dispatchTaskEntry({ store, taskRunner: runner, history }, task);
    expect(dispatch.enqueued).toBe(true);
    expect(dispatch.gezelId).toBe('worker');
    await runner.tick();
    await manager.drainBackground();

    // 1. The worker session is task-scoped.
    const sessions = await store.listSessions({ gezelId: 'worker' });
    const workerSession = sessions.find((s) => s.taskRef === task.ref);
    expect(workerSession).toBeDefined();
    expect(workerSession?.stepId).toBe(task.craftbook.steps[0]?.id);

    // 2. The system prompt carries the step procedure + gate contract.
    // Task context rides the volatile band when layered prefix caching
    // is on — assert against the stable + volatile prompt together.
    const create = mock.calls.find((c) => c.kind === 'create');
    const prompt = `${create?.opts?.systemMessage ?? ''}\n${create?.opts?.volatileContext ?? ''}`;
    expect(prompt).toContain('Step procedure');
    expect(prompt).toContain('Write the landing page');
    expect(prompt).toContain('Phase gate');

    // 3. The seed is the entry-kind wording with the step arc.
    const full = await store.getSession('worker', workerSession?.id ?? '');
    const seed = full?.messages[0]?.content ?? '';
    expect(seed).toContain("You've been assigned task");
    expect(seed).toContain('← your step');
    // …and the transcript card can still read the task, step and craftbook
    // back out of it (see `parseTaskHandoffNote`).
    expect(parseTaskHandoffNote(seed)).toMatchObject({
      kind: 'entry',
      taskRef: task.ref,
      stepId: task.craftbook.steps[0]?.id,
      taskTitle: 'Build the landing page',
    });

    // 4. Theme C floor routing fired for step 1 (developer → small → 8b).
    expect(full?.model).toBe('worker-8b');
    const routed = await history.listEvents({ kinds: ['task.step.routed'] });
    expect(routed).toHaveLength(1);
    expect(routed[0]?.details).toMatchObject({ ref: task.ref, model: 'worker-8b' });

    // 5. And the kickoff story is on the history log — no chat notify.
    const dispatched = await history.listEvents({ kinds: ['task.entry.dispatched'] });
    expect(dispatched).toHaveLength(1);
    const messaged = await history.listEvents({ kinds: ['gezel.messaged'] });
    expect(messaged).toHaveLength(0);
  });

  it('links the entry worker session to the chat session that launched the task', async () => {
    const meester = await store.createGezel({ name: 'Meester', role: 'Meester' });
    const launcher = await manager.createSession({
      gezelId: meester.id,
      projectId: 'default',
    });
    const task = await tasks.create('p1', {
      title: 'Research the launch brief',
      description:
        'Collect and verify the source material before the rest of the launch brief is produced.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [{ name: 'Research', suggestedRole: 'researcher' }],
      launchSessionId: launcher.id,
      createdBy: { kind: 'gezel', gezelId: meester.id },
    });

    mock.script('Research underway.');
    await dispatchTaskEntry({ store, taskRunner: runner, history }, task);
    await runner.tick();
    await manager.drainBackground();

    const childSummary = (await store.listSessions({ gezelId: 'worker' })).find(
      (session) => session.taskRef === task.ref,
    );
    const child = childSummary ? await store.getSession('worker', childSummary.id) : null;
    expect(child?.parentSession).toEqual({
      sessionId: launcher.id,
      gezelId: meester.id,
      kind: 'task-entry',
    });
  });
});

describe('handoff seed wording', () => {
  async function seedFor(args: {
    fromGezelName?: string;
    fromGezelId?: string;
    roleBasedNameOnlyMode?: boolean;
  }) {
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'report',
      ...args,
    });
    await manager.drainBackground();
    const full = await store.getSession('worker', sessionId);
    return full?.messages[0]?.content ?? '';
  }

  it('names the sender when the previous step belonged to another gezel', async () => {
    const seed = await seedFor({ fromGezelName: 'Koray', fromGezelId: 'koray' });
    expect(seed).toContain('Koray has handed step `report`');
  });

  it('retries two failed asynchronous handoff turns while the task step is still active', async () => {
    const task = await tasks.create('p1', {
      title: 'Retry a transient review handoff',
      description:
        'Exercise bounded recovery when a provider fails after the task runner has accepted a handoff.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [{ id: 'review', name: 'Review', prompt: 'Review the assigned patch record.' }],
      createdBy: { kind: 'user' },
    });
    mock.scriptSendFailure('transient required-tool envelope failure');
    mock.scriptSendFailure('second transient required-tool envelope failure');
    mock.script('Recovered review result.');

    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'review',
      kind: 'entry',
    });
    await manager.drainBackground();

    const full = await store.getSession('worker', sessionId);
    expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(3);
    expect(mock.calls.filter((call) => call.kind === 'create')).toHaveLength(3);
    expect(full?.messages.some((message) => message.content === 'Recovered review result.')).toBe(
      true,
    );
    expect(
      full?.messages.some((message) =>
        message.content.includes('automatic handoff turn failed before this active step completed'),
      ),
    ).toBe(true);
  });

  it('reports a handoff that spent its bounded sends so the task can be paused for help', async () => {
    const task = await tasks.create('p1', {
      title: 'Review a patch that keeps aborting',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [{ id: 'review', name: 'Review', prompt: 'Review the assigned patch record.' }],
      createdBy: { kind: 'user' },
    });
    mock.scriptSendFailure('first abort');
    mock.scriptSendFailure('second abort');
    mock.scriptSendFailure('third abort');
    const exhausted = vi.fn(async () => {});
    manager.setHandoffExhaustedHandler(exhausted);

    await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'review',
      kind: 'entry',
    });
    await manager.drainBackground();

    expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(exhausted).toHaveBeenCalledWith({
      taskRef: task.ref,
      stepId: 'review',
      gezelId: 'worker',
      detail: expect.stringContaining('third abort'),
    });
  });

  it('sends one continuation when a local write-bail closes the turn with the step still active', async () => {
    const task = await tasks.create('p1', {
      title: 'Write a story',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        { id: 'write', name: 'Write', prompt: 'Write the story to stories/lighthouse.md now.' },
      ],
      createdBy: { kind: 'user' },
    });
    // The scripted reply claims nothing about a file: a bare write claim
    // with no file on disk wakes the claim-check nudge, a different path.
    mock.scriptWriteBail();
    mock.script('Draft saved.');
    mock.script('Advanced the step.');

    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'write',
      kind: 'entry',
    });
    await manager.drainBackground();

    const sends = mock.calls.filter((call) => call.kind === 'send');
    expect(sends).toHaveLength(2);
    expect(String(sends[1]!.prompt)).toContain('still active');
    expect(String(sends[1]!.prompt)).toContain('advance_task_step');
    const full = await store.getSession('worker', sessionId);
    expect(full?.messages.some((message) => message.content === 'Advanced the step.')).toBe(true);
  });

  it('leaves a handoff turn the model ended itself alone', async () => {
    const task = await tasks.create('p1', {
      title: 'Write a story',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [{ id: 'write', name: 'Write', prompt: 'Write the story to stories/harbor.md now.' }],
      createdBy: { kind: 'user' },
    });
    mock.script('Draft saved; finishing next turn.');

    await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'write',
      kind: 'entry',
    });
    await manager.drainBackground();

    expect(mock.calls.filter((call) => call.kind === 'send')).toHaveLength(1);
  });

  it('retries a fixed-action handoff that returns text without publishing its checkpoint', async () => {
    const task = await tasks.create('p1', {
      title: 'Publish a review checkpoint',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        {
          id: 'review',
          name: 'Review',
          prompt: 'Analyze the assigned record and call write_artifact for observations.md.',
          terminal: true,
          toolPolicy: { outputMedium: 'artifact', allowTools: ['write_artifact'] },
          advanceWhen: { file: 'observations.md', artifact: true, minBytes: 20 },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'observations.md', artifact: true, bytes: 20 }],
            onReject: 'review',
            maxAttempts: 3,
          },
        },
      ],
      createdBy: { kind: 'user' },
    });
    mock.script('I reviewed the record but did not publish it.');
    mock.script('I still have not used the checkpoint tool.');
    mock.script('The analysis is complete in prose only.');

    await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'review',
      kind: 'entry',
    });
    await manager.drainBackground();

    const sends = mock.calls.filter((call) => call.kind === 'send');
    expect(sends).toHaveLength(3);
    expect(sends[1]?.prompt).toContain('ended before fixed-action step');
    expect(sends[1]?.prompt).toContain('Do not call `read_task_notes` or `advance_task_step`');
    // The recovery names the checkpoint the step advances on, so a model
    // that wrote a different deliverable first does not restart from the top.
    expect(sends[1]?.prompt).toContain('once `observations.md` is written');
    expect((await store.readTask('p1', task.num))?.activeStepId).toBe('review');
  });

  it('keeps peer task steps under the task root while recording the immediate handoff', async () => {
    const meester = await store.createGezel({ name: 'Meester', role: 'Meester' });
    const koray = await store.createGezel({ name: 'Koray', role: 'Researcher' });
    const launcher = await manager.createSession({
      gezelId: meester.id,
      projectId: 'default',
    });
    const previous = await manager.createSession({
      gezelId: koray.id,
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'research',
      parentSession: {
        sessionId: launcher.id,
        gezelId: meester.id,
        kind: 'task-entry',
      },
    });
    mock.script('Writing the report.');

    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'report',
      fromGezelName: 'Koray',
      fromGezelId: koray.id,
    });
    await manager.drainBackground();

    const child = await store.getSession('worker', sessionId);
    expect(child?.parentSession).toEqual({
      sessionId: launcher.id,
      gezelId: meester.id,
      kind: 'task-handoff',
    });
    expect(child?.handoffFrom).toEqual({
      sessionId: previous.id,
      gezelId: koray.id,
    });
  });

  it('uses the sender role and pins the worker session in boring mode', async () => {
    const reviewer = await store.createGezel({ name: 'Nare', role: 'Reviewer' });
    const seed = await seedFor({
      fromGezelName: 'Nare',
      fromGezelId: reviewer.id,
      roleBasedNameOnlyMode: true,
    });
    expect(seed).toContain('reviewer has handed step `report`');
    expect(seed).not.toContain('Nare');

    const sessions = await store.listSessions({ gezelId: 'worker' });
    const workerSession = sessions.find((session) => session.taskRef === 'p1/1');
    const full = workerSession ? await store.getSession('worker', workerSession.id) : null;
    expect(full?.roleBasedNameOnlyMode).toBe(true);
  });

  it('keeps an unresolved sender anonymous in boring mode', async () => {
    const seed = await seedFor({
      fromGezelName: 'Bennet',
      fromGezelId: 'deleted-gezel',
      roleBasedNameOnlyMode: true,
    });
    expect(seed).toContain('The previous step has been completed and handed step `report`');
    expect(seed).not.toContain('Bennet');
  });

  it('reads as a step advance when the same gezel owned the previous step', async () => {
    const seed = await seedFor({ fromGezelName: 'Worker', fromGezelId: 'worker' });
    expect(seed).not.toContain('handed step');
    expect(seed).toContain('has advanced to the next step');
    expect(seed).toContain('Please continue');
  });

  it('carries verified tool evidence into an adjacent step owned by the same gezel', async () => {
    const task = await tasks.create('p1', {
      title: 'Review one assigned patch batch',
      description:
        'Open the immutable patch evidence first, then write a review checkpoint from those exact bytes.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        {
          name: 'Open evidence',
          prompt: 'Read the assigned patch record with read_artifacts.',
          toolPolicy: {
            outputMedium: 'none',
            allowTools: ['read_artifact', 'read_artifacts'],
          },
        },
        {
          name: 'Review evidence',
          prompt: 'Write the grounded review checkpoint with write_artifact.',
          toolPolicy: {
            outputMedium: 'artifact',
            allowTools: ['read_artifact', 'write_artifact'],
          },
        },
      ],
      createdBy: { kind: 'user' },
    });
    const openStep = task.craftbook.steps[0]!;
    const reviewStep = task.craftbook.steps[1]!;
    await tasks.completeStep('p1', task.num, openStep.id);

    const prior = await manager.createSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: openStep.id,
    });
    prior.messages.push({
      role: 'assistant',
      content: 'Opened the assigned immutable patch record.',
      at: new Date().toISOString(),
      toolCalls: [
        {
          name: 'read_artifacts',
          durationMs: 5,
          success: true,
          path: 'data/github-pull-requests/pr-60/records/0001.json',
          resultText: 'PATCH EVIDENCE: packages/service/src/chat/manager.ts +42 -7',
        },
      ],
    });
    prior.lastActivityAt = new Date().toISOString();
    await store.writeSession(prior);

    mock.script('Review checkpoint saved.');
    const handoff = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: reviewStep.id,
    });
    await manager.drainBackground();

    expect(handoff.sessionId).toBe(prior.id);
    const sessions = (await store.listSessions({ gezelId: 'worker', projectId: 'p1' })).filter(
      (session) => session.taskRef === task.ref,
    );
    expect(sessions).toHaveLength(1);
    const carried = await store.getSession('worker', prior.id);
    expect(carried?.stepId).toBe(reviewStep.id);

    const create = mock.calls.find((call) => call.kind === 'create');
    expect(create?.opts?.toolAllowlist?.has('write_artifact')).toBe(true);
    expect(create?.opts?.toolAllowlist?.has('read_artifacts')).toBe(false);
    expect(create?.opts?.priorMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: expect.stringContaining('PATCH EVIDENCE'),
        }),
      ]),
    );
  });

  it('falls back to the anonymous wording without a previous gezel', async () => {
    const seed = await seedFor({});
    expect(seed).toContain('The previous step has been completed and handed step `report`');
  });

  /**
   * The transcript surfaces render these seeds as a short hand-off card and
   * keep the tool-calling boilerplate in provenance — and they recover the
   * sender/step/task by parsing this prose, because no structured form of it
   * is persisted. Reword a seed above without teaching
   * `parseTaskHandoffNote` the new wording and every hand-off silently
   * reverts to the raw paragraph, which is what the card exists to replace.
   */
  it('stays readable by the hand-off card parser', async () => {
    expect(
      parseTaskHandoffNote(await seedFor({ fromGezelName: 'Koray', fromGezelId: 'koray' })),
    ).toEqual({ kind: 'handoff', taskRef: 'p1/1', stepId: 'report', fromName: 'Koray' });

    expect(parseTaskHandoffNote(await seedFor({}))).toEqual({
      kind: 'handoff',
      taskRef: 'p1/1',
      stepId: 'report',
    });

    expect(
      parseTaskHandoffNote(await seedFor({ fromGezelName: 'Worker', fromGezelId: 'worker' })),
    ).toEqual({ kind: 'advance', taskRef: 'p1/1', stepId: 'report' });
  });

  it('continues the latest persisted task-step session after a service restart', async () => {
    const prior = await manager.createSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'report',
    });
    prior.messages.push({
      role: 'assistant',
      content: 'Reviewed records 1–10 and saved the first coverage checkpoint.',
      at: new Date().toISOString(),
    });
    prior.lastActivityAt = new Date().toISOString();
    await store.writeSession(prior);

    mock.script('continued');
    const resumed = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'report',
      resumeExisting: true,
    });
    await manager.drainBackground();

    expect(resumed.sessionId).toBe(prior.id);
    const sessions = (await store.listSessions({ gezelId: 'worker' })).filter(
      (session) => session.taskRef === 'p1/1' && session.stepId === 'report',
    );
    expect(sessions).toHaveLength(1);
    const full = await store.getSession('worker', prior.id);
    expect(
      full?.messages.some((message) => message.content.includes('Reviewed records 1–10')),
    ).toBe(true);
    expect(full?.messages.some((message) => message.content.includes('service restarted'))).toBe(
      true,
    );
    expect(full?.parentSession).toBeUndefined();
    expect(full?.handoffFrom).toBeUndefined();
  });

  it('continues an adjacent evidence session when restart lands between task advance and relabel', async () => {
    const task = await tasks.create('p1', {
      title: 'Resume review after opening evidence',
      description: 'A two-step fixture for the post-advance restart window.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        {
          name: 'Open evidence',
          prompt: 'Read the immutable patch record.',
          toolPolicy: { outputMedium: 'none', allowTools: ['read_artifacts'] },
        },
        {
          name: 'Review evidence',
          prompt: 'Write the grounded review checkpoint.',
          toolPolicy: {
            outputMedium: 'artifact',
            allowTools: ['read_artifact', 'write_artifact'],
          },
        },
      ],
      createdBy: { kind: 'user' },
    });
    const openStep = task.craftbook.steps[0]!;
    const reviewStep = task.craftbook.steps[1]!;
    await tasks.completeStep('p1', task.num, openStep.id);

    const prior = await manager.createSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: openStep.id,
    });
    prior.messages.push({
      role: 'assistant',
      content: 'Opened the assigned patch before the service stopped.',
      at: new Date().toISOString(),
      toolCalls: [
        {
          name: 'read_artifacts',
          durationMs: 5,
          success: true,
          path: 'data/github-pull-requests/pr-60/records/0001.json',
          resultText: 'RECOVERED PATCH: packages/service/src/chat/manager.ts +42 -7',
        },
      ],
    });
    prior.lastActivityAt = new Date().toISOString();
    await store.writeSession(prior);

    mock.script('Recovered review checkpoint saved.');
    const resumed = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: reviewStep.id,
      resumeExisting: true,
    });
    await manager.drainBackground();

    expect(resumed.sessionId).toBe(prior.id);
    const sessions = (await store.listSessions({ gezelId: 'worker', projectId: 'p1' })).filter(
      (candidate) => candidate.taskRef === task.ref,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.stepId).toBe(reviewStep.id);

    const create = mock.calls.find((call) => call.kind === 'create');
    expect(create?.opts?.toolAllowlist?.has('write_artifact')).toBe(true);
    expect(create?.opts?.toolAllowlist?.has('read_artifacts')).toBe(false);
    expect(create?.opts?.priorMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          content: expect.stringContaining('RECOVERED PATCH'),
        }),
      ]),
    );
    const full = await store.getSession('worker', prior.id);
    expect(full?.messages.some((message) => message.content.includes('service restarted'))).toBe(
      true,
    );
  });

  /**
   * The seed is a `role: 'user'` message because that is the only role a
   * provider accepts mid-conversation — but the person never typed it. The
   * marker is what stops the transcript rendering "YOU · call
   * `advance_task_step` to hand off" on the Home screen.
   */
  it('marks the dispatch seed as system-authored, not the user speaking', async () => {
    await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'report',
      fromGezelName: 'Koray',
      fromGezelId: 'koray',
    });
    await manager.drainBackground();
    const sessions = await store.listSessions({ gezelId: 'worker' });
    const workerSession = sessions.find((session) => session.taskRef === 'p1/1');
    const full = workerSession ? await store.getSession('worker', workerSession.id) : null;
    const seedMessage = full?.messages[0];
    expect(seedMessage?.role).toBe('user');
    expect(seedMessage?.origin).toBe('system');

    // The reply is a real model turn and must stay unmarked.
    const reply = full?.messages.find((m) => m.role === 'assistant');
    expect(reply?.origin).toBeUndefined();

    // And it survives the timeline projection the chat UI actually reads.
    const timeline = await store.listTimeline({ projectId: 'p1', limit: 50 });
    const seedRow = timeline.messages.find((m) => m.role === 'user');
    expect(seedRow?.origin).toBe('system');
  });
});

describe('generalist task session continuity', () => {
  const at = () => new Date().toISOString();

  it('keeps one session across every step and points the seed at the task outline', async () => {
    const task = await tasks.create('p1', {
      title: 'Generalist run',
      description: 'Three steps, one owner, one conversation from first step to last.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      executionMode: 'generalist',
      steps: [
        { id: 'research', name: 'Research', prompt: 'Look things up with read_file.' },
        { id: 'build', name: 'Build', prompt: 'Write the deliverable with write_file.' },
        {
          id: 'review',
          name: 'Review',
          prompt: 'Check the result with read_file.',
          terminal: true,
        },
      ],
      entryStepId: 'research',
      createdBy: { kind: 'user' },
    });
    expect(task.executionMode).toBe('generalist');
    expect(task.craftbook.steps.every((s) => s.assignee?.kind === 'gezel')).toBe(true);
    await tasks.completeStep('p1', task.num, 'research');

    const prior = await manager.createSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'research',
    });
    prior.messages.push({ role: 'assistant', content: 'Research done.', at: at() });
    await store.writeSession(prior);

    mock.script('Building.');
    const handoff = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'build',
      fromGezelId: 'worker',
      fromGezelName: 'Worker',
    });
    await manager.drainBackground();
    expect(handoff.sessionId).toBe(prior.id);
    const carried = await store.getSession('worker', prior.id);
    expect(carried?.stepId).toBe('build');
    const seed =
      [...(carried?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    expect(seed).toContain('has advanced to the next step');
    expect(seed).toContain('Task outline in your prompt');

    await tasks.completeStep('p1', task.num, 'build');
    mock.script('Reviewing.');
    const again = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'review',
      fromGezelId: 'worker',
    });
    await manager.drainBackground();
    expect(again.sessionId).toBe(prior.id);
    const sessions = (await store.listSessions({ gezelId: 'worker', projectId: 'p1' })).filter(
      (session) => session.taskRef === task.ref,
    );
    expect(sessions).toHaveLength(1);
    expect((await store.getSession('worker', prior.id))?.stepId).toBe('review');
  });

  it('a retry after a compaction-loop halt starts fresh for a generalist task and resumes for a stepwise one', async () => {
    for (const mode of ['generalist', 'stepwise'] as const) {
      const task = await tasks.create('p1', {
        title: `Retry ${mode}`,
        description: 'A single step whose last attempt halted on repeated compaction.',
        assignee: { kind: 'gezel', gezelId: 'worker' },
        executionMode: mode,
        steps: [
          { id: 'work', name: 'Work', prompt: 'Do the work with write_file.', terminal: true },
        ],
        entryStepId: 'work',
        createdBy: { kind: 'user' },
      });
      const prior = await manager.createSession({
        gezelId: 'worker',
        projectId: 'p1',
        taskRef: task.ref,
        stepId: 'work',
      });
      prior.messages.push(
        { role: 'user', content: 'Go.', at: at() },
        {
          role: 'assistant',
          content: 'This turn triggered context compaction twice without making progress.',
          at: at(),
          synthetic: 'context-loop-halt',
        },
      );
      await store.writeSession(prior);

      mock.script('Trying again.');
      const retried = await manager.startHandoffSession({
        gezelId: 'worker',
        projectId: 'p1',
        taskRef: task.ref,
        stepId: 'work',
        kind: 'retry',
        resumeExisting: true,
      });
      await manager.drainBackground();
      if (mode === 'generalist') {
        expect(retried.sessionId).not.toBe(prior.id);
      } else {
        expect(retried.sessionId).toBe(prior.id);
      }
    }
  });

  it('opens a fresh session when the prior transcript ran on another provider', async () => {
    const task = await tasks.create('p1', {
      title: 'Provider moved',
      description: 'Two steps; the first ran before the default provider changed.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      executionMode: 'generalist',
      steps: [
        { id: 'a', name: 'A', prompt: 'Start with read_file.' },
        { id: 'b', name: 'B', prompt: 'Finish with write_file.', terminal: true },
      ],
      entryStepId: 'a',
      createdBy: { kind: 'user' },
    });
    await tasks.completeStep('p1', task.num, 'a');
    const prior = await manager.createSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'a',
    });
    prior.providerName = 'openai';
    await store.writeSession(prior);

    mock.script('ok');
    const handoff = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: 'b',
      fromGezelId: 'worker',
    });
    await manager.drainBackground();
    expect(handoff.sessionId).not.toBe(prior.id);
  });
});
