import { describe, expect, it, vi } from 'vitest';
import { type PortableInference, PortableProductService } from './product-service.js';
import type { PortableToolActions } from './product-tools.js';
import { executePortableTool } from './product-tools.js';
import { PortableScriptHost, type PortableScripts } from './script-host.js';
import { portableFixture } from './test-files.js';
import { runPortableToolLoop } from './tool-loop.js';

async function fixture() {
  const { store } = portableFixture();
  await store.ensureLayout();
  const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
  const task = await store.createTask('default', {
    title: 'Review evidence',
    description: 'Review the evidence and repeat setup when the gate requests another pass.',
    assignee: { kind: 'gezel', gezelId: gezel.id },
    steps: [
      {
        name: 'Review',
        terminal: true,
        gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'report.md', bytes: 1 }] },
      },
    ],
  });
  const run = await store.beginTaskRun(task.ref);
  await store.finishTaskRun(task.ref, run.runId);
  const session = await store.createSession({
    gezelId: gezel.id,
    taskRef: task.ref,
    stepId: task.activeStepId,
    providerName: 'llama-cpp',
  });
  const restart = (approved = true) =>
    store.completeTaskStep(task.ref, task.activeStepId!, {
      gate: { approved, next: task.activeStepId, message: 'Repeat setup before reviewing again' },
    });
  const actions: PortableToolActions = {
    recruit: async () => gezel,
    templates: () => [],
    createTask: async () => {},
    completeTask: () => restart(),
    message: async () => {},
    startProject: async () => {},
  };
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Local test',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 32000,
        maxOutputTokens: 1000,
        capabilities: {
          text: true,
          tools: false,
          images: false,
          structuredOutput: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: vi.fn(async () => ({ text: 'Done', stopReason: 'stop' as const })),
    cancel: async () => {},
  };
  const loop = () =>
    runPortableToolLoop({
      store,
      session,
      inference,
      actions,
      requestId: 'test',
      providerId: 'llama-cpp',
      modelId: 'test',
      contextSize: 32000,
      maxTokens: 1000,
      messages: [],
      cancelled: () => false,
      checkpoint: async () => {},
      tool: () => {},
      delta: () => {},
    });
  return { store, gezel, task, session, restart, actions, inference, loop };
}

describe('portable task activation authority', () => {
  it.each(['initial', 'restart'])(
    'does not admit a newly created conversation before %s setup completes',
    async (stage) => {
      const f = await fixture();
      const task = await f.store.createTask('default', {
        title: 'Prepare before review',
        description: 'The setup script must complete before the working conversation can act.',
        assignee: { kind: 'gezel', gezelId: f.gezel.id },
        steps: [
          { name: 'Review', terminal: true, onEnter: { name: 'storeRecords', scope: 'standard' } },
        ],
      });
      if (stage === 'restart')
        await f.store.completeTaskStep(task.ref, task.activeStepId!, { next: task.activeStepId });
      const session = await f.store.createSession({
        gezelId: f.gezel.id,
        taskRef: task.ref,
        stepId: task.activeStepId,
      });
      const service = new PortableProductService(f.store, f.inference, 'secret');
      await service.initialize();
      const response = await service.fetch(`https://gezel.local/api/sessions/${session.id}/send`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Start before setup' }),
      });
      expect(response.status).toBe(409);
      expect(f.inference.generate).not.toHaveBeenCalled();
      await expect(
        executePortableTool(
          f.store,
          session,
          'write_artifact',
          { path: 'before-setup.txt', content: 'Wrong order' },
          f.actions,
        ),
      ).rejects.toThrow('setup');
      expect(await f.store.readFile('artifacts', 'default', 'before-setup.txt')).toBeNull();
    },
  );

  it.each([true, false])(
    'ends the old loop after a same-step gate route (approved=%s)',
    async (approved) => {
      const f = await fixture();
      f.actions.completeTask = () => f.restart(approved);
      const generate = vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({ name: 'advance_task_step', arguments: { ref: f.task.ref } }),
          stopReason: 'stop',
        })
        .mockResolvedValue({ text: 'Old activation continued', stopReason: 'stop' });
      f.inference.generate = generate;
      const result = await f.loop();
      expect(generate).toHaveBeenCalledOnce();
      expect(result.text).toContain('restarted');
      expect(result.message?.toolCalls?.[0]?.success).toBe(true);
    },
  );

  it('refuses an effect when the activation changes while the model is answering', async () => {
    const f = await fixture();
    f.inference.generate = async () => {
      await f.restart();
      return {
        text: JSON.stringify({
          name: 'write_artifact',
          arguments: { path: 'stale.txt', content: 'Old activation' },
        }),
        stopReason: 'stop',
      };
    };
    const result = await f.loop();
    expect(result.text).toContain('restarted');
    expect(result.message?.toolCalls?.[0]?.success).toBe(false);
    expect(result.message?.toolCalls?.[0]?.errorMessage).toContain('changed activation');
    expect(await f.store.readFile('artifacts', 'default', 'stale.txt')).toBeNull();
  });

  it('refuses to reopen a conversation belonging to an earlier activation of the same step', async () => {
    const f = await fixture();
    await f.restart();
    const service = new PortableProductService(f.store, f.inference, 'secret');
    await service.initialize();
    const response = await service.fetch(`https://gezel.local/api/sessions/${f.session.id}/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Continue the earlier pass' }),
    });
    expect(response.status).toBe(409);
    expect(f.inference.generate).not.toHaveBeenCalled();
    expect((await f.store.getSession(f.gezel.id, f.session.id))?.messages).toEqual([]);
  });

  it('refuses subsequent chat-script effects after its task restarts the same step', async () => {
    const f = await fixture();
    await f.restart();
    await expect(
      new PortableScriptHost(f.store).dispatch(
        {
          projectId: 'default',
          signal: new AbortController().signal,
          trigger: { kind: 'chat', gezelId: f.gezel.id, sessionId: f.session.id },
        },
        'artifact.write',
        { path: 'stale-script.txt', content: 'Old activation' },
      ),
    ).rejects.toThrow(/activation|stopped or changed/);
    expect(await f.store.readFile('artifacts', 'default', 'stale-script.txt')).toBeNull();
  });

  it('settles a saved admission if the activation changes during the save', async () => {
    const f = await fixture();
    const service = new PortableProductService(f.store, f.inference, 'secret');
    await service.initialize();
    const writeSession = f.store.writeSession.bind(f.store);
    let changed = false;
    vi.spyOn(f.store, 'writeSession').mockImplementation(async (session, options) => {
      await writeSession(session, options);
      if (!changed && session.id === f.session.id && session.turnStartedAt) {
        changed = true;
        await f.restart();
      }
    });
    const response = await service.fetch(`https://gezel.local/api/sessions/${f.session.id}/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Continue the review' }),
    });
    expect(response.status).toBe(409);
    expect(f.inference.generate).not.toHaveBeenCalled();
    const saved = await f.store.getSession(f.gezel.id, f.session.id);
    expect(saved?.turnStartedAt).toBeUndefined();
    expect(saved?.lastTurnError).toContain('stopped before it began');
    expect(service.busy).toBe(false);
  });

  it('repeats setup before reusing a generalist conversation after a gate self-loop', async () => {
    const f = await fixture();
    const task = await f.store.createTask('default', {
      title: 'Repeat evidence preparation',
      description: 'Prepare and review evidence, repeating setup for each prescribed review pass.',
      executionMode: 'generalist',
      assignee: { kind: 'gezel', gezelId: f.gezel.id },
      steps: [
        {
          name: 'Review',
          terminal: true,
          onEnter: { name: 'storeRecords', scope: 'standard' },
          gate: { at: 'completion', scripts: [{ name: 'checkJsonValid', scope: 'standard' }] },
        },
      ],
    });
    const events: string[] = [];
    let gates = 0;
    const scripts: PortableScripts = {
      list: () => [],
      source: async () => {
        throw new Error('No source');
      },
      initialize: async () => {},
      cancel: async () => {},
      isBusy: () => false,
      run: async (options) => {
        const moment = options.trigger.kind === 'step' ? options.trigger.moment : 'manual';
        events.push(moment);
        const output =
          moment === 'gate'
            ? ++gates === 1
              ? { decision: 'reject', message: 'Repeat preparation', goto: task.activeStepId }
              : { decision: 'approve' }
            : { ok: true };
        return {
          id: crypto.randomUUID(),
          projectId: options.projectId,
          scriptName: options.scriptName,
          status: 'ok',
          startedAt: new Date().toISOString(),
          trigger: options.trigger,
          inputs: {},
          calls: [],
          logs: '',
          output,
        };
      },
    };
    f.inference.generate = vi.fn(async () => {
      events.push('model');
      return {
        text: JSON.stringify({ name: 'advance_task_step', arguments: { ref: task.ref } }),
        stopReason: 'stop' as const,
      };
    });
    const service = new PortableProductService(f.store, f.inference, 'secret');
    service.setScripts(scripts);
    await service.initialize();
    const response = await service.fetch(
      `https://gezel.local/api/projects/default/tasks/${task.num}/retry`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(response.status).toBe(200);
    for (let i = 0; service.busy && i < 200; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(service.busy).toBe(false);
    expect((await f.store.getTask(task.ref))?.status).toBe('complete');
    expect(events).toEqual(['enter', 'model', 'gate', 'enter', 'model', 'gate']);
    expect(
      (await f.store.listSessions()).filter((session) => session.taskRef === task.ref),
    ).toHaveLength(1);
  });
});
