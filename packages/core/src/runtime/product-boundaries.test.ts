import { describe, expect, it, vi } from 'vitest';
import type { ScriptRun } from '../schemas/script.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import type { PortableScripts } from './script-host.js';
import { portableFixture } from './test-files.js';

function providers(): Awaited<ReturnType<PortableInference['providers']>> {
  return [
    {
      id: 'llama-cpp',
      name: 'Local fixture',
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
  ];
}
async function fixture() {
  const { store, files } = portableFixture();
  const inference: PortableInference = {
    providers: async () => providers(),
    generate: vi.fn(async () => ({ text: 'Done', stopReason: 'stop' as const })),
    cancel: vi.fn(async () => {}),
  };
  const service = new PortableProductService(store, inference, 'secret');
  await service.initialize();
  const request = (path: string, body?: unknown) =>
    service.fetch(`https://gezel.local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, files, inference, service, request };
}
function cancellableScripts() {
  let finish: (() => void) | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let active = false;
  const scripts: PortableScripts = {
    list: () => [],
    source: async () => {
      throw new Error('No source');
    },
    initialize: async () => {},
    isBusy: () => active,
    cancel: vi.fn(async () => {
      finish?.();
    }),
    run: vi.fn(async (options): Promise<ScriptRun> => {
      active = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
        entered();
        options.signal?.addEventListener('abort', resolve as () => void, { once: true });
        if (options.signal?.aborted) resolve();
      });
      active = false;
      return {
        id: 'run',
        projectId: options.projectId,
        scriptName: options.scriptName,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error',
        error: 'cancelled',
        trigger: options.trigger,
        inputs: {},
        calls: [],
        logs: '',
      };
    }),
  };
  return { scripts, started };
}

describe('portable host admission and cancellation', () => {
  it.each(['cancel', 'suspend-resume', 'request-abort'])(
    'does not start a transform after %s during config admission',
    async (action) => {
      const { service, inference, store } = await fixture();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = store.readConfig.bind(store);
      vi.spyOn(store, 'readConfig').mockImplementationOnce(async () => {
        entered();
        await held;
        return read();
      });
      const controller = new AbortController();
      const requesting = service.fetch('https://gezel.local/api/ai/transform', {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'rewrite', text: 'A rough paragraph.' }),
      });
      await reached;
      if (action === 'cancel') await service.cancel();
      else if (action === 'suspend-resume') {
        await service.suspend();
        service.resume();
      } else controller.abort();
      release();
      if (action === 'request-abort')
        await expect(requesting).rejects.toMatchObject({ name: 'AbortError' });
      else {
        const response = await requesting;
        if (response.ok) await response.text();
        expect(response.status).toBe(409);
      }
      expect(inference.generate).not.toHaveBeenCalled();
      expect(service.busy).toBe(false);
    },
  );

  it('preserves ordinary transform SSE admission and completion', async () => {
    const { service, request, inference } = await fixture();
    const response = await request('/api/ai/transform', {
      mode: 'rewrite',
      text: 'A rough paragraph.',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('Done');
    expect(inference.generate).toHaveBeenCalledOnce();
    expect(service.busy).toBe(false);
  });

  it('keeps config and reads responsive during a manual script and cancels it when AI is off', async () => {
    const { service, request } = await fixture();
    const { scripts, started } = cancellableScripts();
    service.setScripts(scripts);
    const run = request('/api/projects/default/scripts/run', {
      name: 'example',
      scope: 'standard',
    });
    await started;
    expect(service.getStatus().busy).toBe(true);
    expect((await request('/api/projects')).status).toBe(200);
    expect(
      (await request('/api/projects/default/scripts/run', { name: 'another', scope: 'standard' }))
        .status,
    ).toBe(409);
    const response = await service.fetch('https://gezel.local/api/config', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ aiEngagementMode: 'off' }),
    });
    expect(response.status).toBe(200);
    expect(scripts.cancel).toHaveBeenCalled();
    expect((await run).status).toBe(200);
    expect(service.getStatus().busy).toBe(false);
  });

  it('cancels a script that a model turn is awaiting before waiting for the turn', async () => {
    const { service, store, inference, request } = await fixture();
    const { scripts, started } = cancellableScripts();
    service.setScripts(scripts);
    vi.mocked(inference.generate).mockResolvedValue({
      text: JSON.stringify({ name: 'run_installed_script', arguments: { name: 'example' } }),
      stopReason: 'stop',
    });
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
    expect(
      (await request(`/api/sessions/${session.id}/send`, { message: 'Run the script' })).status,
    ).toBe(200);
    await started;
    await service.cancel();
    expect(scripts.cancel).toHaveBeenCalled();
    expect(inference.generate).toHaveBeenCalledTimes(1);
    expect(service.busy).toBe(false);
    expect((await store.getSession(gezel.id, session.id))?.turnStartedAt).toBeUndefined();
  });

  it('recovers an OS-killed tool turn without replaying the recorded action', async () => {
    const { store, inference } = await fixture();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
    session.turnStartedAt = new Date().toISOString();
    session.messages.push({
      id: 'interrupted',
      role: 'assistant',
      content: '',
      at: session.turnStartedAt,
      status: 'streaming',
      toolCalls: [
        {
          name: 'write_artifact',
          at: session.turnStartedAt,
          durationMs: 0,
          success: false,
          argsFull: JSON.stringify({ path: 'proof.md', content: 'saved' }),
          errorMessage: 'This action started. Check its outcome before retrying.',
        },
      ],
    });
    await store.writeSession(session);
    await store.writeFile('artifacts', 'default', 'proof.md', 'saved');
    const restarted = new PortableProductService(store, inference, 'secret');
    await restarted.initialize();
    const recovered = await store.getSession(gezel.id, session.id);
    expect(recovered?.messages[0]?.status).toBe('interrupted');
    expect(recovered?.messages[0]?.toolCalls?.[0]?.success).toBe(false);
    expect(recovered?.turnStartedAt).toBeUndefined();
    expect(inference.generate).not.toHaveBeenCalled();
    expect(await store.readFile('artifacts', 'default', 'proof.md')).toBe('saved');
  });

  it('refuses new work while suspended and never starts it on resume', async () => {
    const { service, request, inference, store } = await fixture();
    await service.suspend();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
    expect((await request(`/api/sessions/${session.id}/send`, { message: 'Later' })).status).toBe(
      409,
    );
    service.resume();
    expect(inference.generate).not.toHaveBeenCalled();
  });

  it.each(['providers', 'save'])(
    'cancels an in-flight turn admission held at %s before it can start inference',
    async (stage) => {
      const { service, request, inference, store } = await fixture();
      const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
      const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === 'providers') {
        vi.spyOn(inference, 'providers').mockImplementationOnce(async () => {
          entered();
          await held;
          return providers();
        });
      } else {
        const write = store.writeSession.bind(store);
        vi.spyOn(store, 'writeSession').mockImplementationOnce(async (record, options) => {
          entered();
          await held;
          return write(record, options);
        });
      }
      const sending = request(`/api/sessions/${session.id}/send`, { message: 'Write the report' });
      await reached;
      const suspended = service.suspend();
      release();
      await suspended;
      expect((await sending).status).toBe(409);
      expect(inference.generate).not.toHaveBeenCalled();
      const saved = await store.getSession(gezel.id, session.id);
      expect(saved?.turnStartedAt).toBeUndefined();
      service.resume();
      expect(inference.generate).not.toHaveBeenCalled();
    },
  );

  it('lets the ordinary cancel endpoint revoke an admission before inference exists', async () => {
    const { service, request, inference, store } = await fixture();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(inference, 'providers').mockImplementationOnce(async () => {
      entered();
      await held;
      return providers();
    });
    const sending = request(`/api/sessions/${session.id}/send`, { message: 'Read the project' });
    await reached;
    expect(service.busy).toBe(true);
    const cancelling = request(`/api/sessions/${session.id}/cancel`, {});
    release();
    expect(await (await cancelling).json()).toEqual({ cancelled: true });
    expect((await sending).status).toBe(409);
    expect(inference.generate).not.toHaveBeenCalled();
    expect(service.busy).toBe(false);
  });

  it('rechecks task state before the first tool effect after a slow model response', async () => {
    const { service, request, inference, store } = await fixture();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const task = await store.createTask('default', {
      title: 'Report',
      description: 'Read the project and deliver a useful report.',
      assignee: { kind: 'gezel', gezelId: gezel.id },
      steps: [{ name: 'Deliver', terminal: true }],
    });
    const session = await store.createSession({
      gezelId: gezel.id,
      providerName: 'llama-cpp',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(inference.generate).mockImplementation(async () => {
      entered();
      await held;
      return {
        text: JSON.stringify({
          name: 'write_artifact',
          arguments: { path: 'late-effect.md', content: 'Must not be written' },
        }),
        stopReason: 'stop',
      };
    });
    expect(
      (await request(`/api/sessions/${session.id}/send`, { message: 'Write a report' })).status,
    ).toBe(200);
    await reached;
    await store.completeTaskStep(task.ref, task.activeStepId!);
    release();
    for (let i = 0; i < 100 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(service.busy).toBe(false);
    expect(await store.readFile('artifacts', 'default', 'late-effect.md')).toBeNull();
    const receipt = (await store.getSession(gezel.id, session.id))?.messages.at(-1)?.toolCalls?.[0];
    expect(receipt?.success).toBe(false);
    expect(receipt?.errorMessage).toContain('current task step');
  });

  it('does not execute a stale task conversation’s first file effect after completion', async () => {
    const { service, request, inference, store } = await fixture();
    const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const task = await store.createTask('default', {
      title: 'Finished report',
      description: 'Produce the report and finish the task before another turn.',
      assignee: { kind: 'gezel', gezelId: gezel.id },
      steps: [{ name: 'Deliver', terminal: true }],
    });
    const session = await store.createSession({
      gezelId: gezel.id,
      providerName: 'llama-cpp',
      taskRef: task.ref,
      stepId: task.activeStepId,
    });
    await store.completeTaskStep(task.ref, task.activeStepId!);
    vi.mocked(inference.generate).mockResolvedValue({
      text: JSON.stringify({
        name: 'write_artifact',
        arguments: { path: 'stale-effect.md', content: 'This must not be written.' },
      }),
      stopReason: 'stop',
    });
    await request(`/api/sessions/${session.id}/send`, { message: 'Continue the old task' });
    for (let i = 0; i < 100 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(service.busy).toBe(false);
    expect(await store.readFile('artifacts', 'default', 'stale-effect.md')).toBeNull();
  });

  it('settles queued handoffs after saving fails without draining them on a later unrelated turn', async () => {
    const { service, request, inference, store } = await fixture();
    const config = await store.readConfig();
    const worker = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const source = await store.createSession({
      gezelId: config.meesterGezelId!,
      providerName: 'llama-cpp',
    });
    vi.mocked(inference.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        name: 'message_gezel',
        arguments: { gezel: worker.id, message: 'Read the project' },
      }),
      stopReason: 'stop',
    });
    let fail = true;
    const write = store.writeSession.bind(store);
    vi.spyOn(store, 'writeSession').mockImplementation(async (session, options) => {
      if (
        fail &&
        session.id === source.id &&
        session.messages.some((message) =>
          message.toolCalls?.some((call) => call.name === 'message_gezel' && call.success),
        )
      )
        throw new Error('Source receipt could not be saved');
      return write(session, options);
    });
    expect(
      (await request(`/api/sessions/${source.id}/send`, { message: 'Ask Noor for help' })).status,
    ).toBe(200);
    for (let i = 0; i < 100 && !service.getStatus().pendingSave; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(service.getStatus().pendingSave).toBe(true);
    fail = false;
    await service.retrySave();
    expect(service.busy).toBe(false);
    expect(inference.generate).toHaveBeenCalledTimes(1);
    const queued = (await store.listSessions({ gezelId: worker.id }))[0]!;
    const saved = await store.getSession(worker.id, queued.id);
    expect(saved?.turnStartedAt).toBeUndefined();
    expect(saved?.lastTurnError).toContain('save');
    expect(
      (await request(`/api/sessions/${source.id}/send`, { message: 'What happened?' })).status,
    ).toBe(200);
    for (let i = 0; i < 100 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(service.busy).toBe(false);
    expect(inference.generate).toHaveBeenCalledTimes(2);
  });

  it('does not allocate a handoff conversation after cancellation during recipient lookup', async () => {
    const { service, request, inference, store } = await fixture();
    const worker = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const source = await store.createSession({
      gezelId: (await store.readConfig()).meesterGezelId!,
      providerName: 'llama-cpp',
    });
    vi.mocked(inference.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        name: 'message_gezel',
        arguments: { gezel: worker.id, message: 'Read the project' },
      }),
      stopReason: 'stop',
    });
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = store.getGezel.bind(store);
    vi.spyOn(store, 'getGezel').mockImplementation(async (id) => {
      if (id === worker.id) {
        entered();
        await held;
      }
      return get(id);
    });
    expect(
      (await request(`/api/sessions/${source.id}/send`, { message: 'Ask Noor for help' })).status,
    ).toBe(200);
    await reached;
    const cancelled = service.cancel();
    release();
    await cancelled;
    expect(inference.generate).toHaveBeenCalledTimes(1);
    expect(await store.listSessions({ gezelId: worker.id })).toEqual([]);
  });

  it('does not queue a handoff whose durable admission finishes after cancellation', async () => {
    const { service, request, inference, store } = await fixture();
    const config = await store.readConfig();
    const worker = await store.createGezel({ name: 'Noor', role: 'Generalist' });
    const source = await store.createSession({
      gezelId: config.meesterGezelId!,
      providerName: 'llama-cpp',
    });
    vi.mocked(inference.generate).mockResolvedValue({
      text: JSON.stringify({
        name: 'message_gezel',
        arguments: { gezel: worker.id, message: 'Read the project' },
      }),
      stopReason: 'stop',
    });
    const write = store.writeSession.bind(store);
    let release!: () => void;
    let admitted!: () => void;
    const reached = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    vi.spyOn(store, 'writeSession').mockImplementation(async (session, options) => {
      if (session.gezelId === worker.id && session.turnStartedAt) {
        admitted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return write(session, options);
    });
    expect(
      (await request(`/api/sessions/${source.id}/send`, { message: 'Ask Noor for help' })).status,
    ).toBe(200);
    await reached;
    const cancelled = service.cancel();
    release();
    await cancelled;
    expect(inference.generate).toHaveBeenCalledTimes(1);
    const summaries = await store.listSessions({ gezelId: worker.id });
    expect(summaries).toHaveLength(1);
    const saved = await store.getSession(worker.id, summaries[0]!.id);
    expect(saved?.turnStartedAt).toBeUndefined();
    expect(saved?.lastTurnError).toContain('stopped');
  });
});
