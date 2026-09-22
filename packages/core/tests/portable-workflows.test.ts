import { describe, expect, it } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { portableFixture } from '../src/runtime/test-files.js';

/** The step the model reads from its prompt; the scripted models look it up. */
async function activeStep(
  store: { getTask(ref: string): Promise<{ activeStepId?: string } | null | undefined> },
  ref: string,
) {
  return (await store.getTask(ref))?.activeStepId;
}

async function setup(generate?: PortableInference['generate']) {
  const { store, files } = portableFixture();
  let selected = 'model-a';
  let models = ['model-a', 'model-b'];
  const requests: Parameters<PortableInference['generate']>[0][] = [];
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Offline test',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 8192,
        maxOutputTokens: 4096,
        capabilities: {
          text: true,
          tools: false,
          structuredOutput: false,
          images: false,
          foregroundOnly: true,
        },
      },
    ],
    models: async () => ({
      models: models.map((id) => ({ id, name: id, sizeBytes: 1024 })),
      selectedModelId: models.includes(selected) ? selected : models[0],
    }),
    generate: async (request, delta) => {
      requests.push(request);
      return generate ? generate(request, delta) : { text: 'A saved reply', stopReason: 'stop' };
    },
    cancel: async () => {},
  };
  const service = new PortableProductService(store, inference, 'test');
  await service.initialize();
  await store.writeConfig({
    modelContextOverrides: { 'llama-cpp:model-a': 8192, 'llama-cpp:model-b': 8192 },
    modelTuning: { 'model-a': { sampling: { maxTokens: 512 } } },
  });
  const client = new GezelClient({
    baseUrl: 'https://gezel.local',
    token: 'test',
    fetch: service.fetch,
  });
  const meester = (await store.readConfig()).meesterGezelId!;
  return {
    store,
    files,
    service,
    client,
    inference,
    requests,
    meester,
    select: (id: string) => {
      selected = id;
    },
    remove: (id: string) => {
      models = models.filter((m) => m !== id);
    },
  };
}
async function idle(service: PortableProductService) {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!service.busy) {
      await new Promise((r) => setTimeout(r, 20));
      if (!service.busy) return;
    }
  }
  throw new Error('Service did not settle');
}
const tool = (name: string, args: Record<string, unknown>) => ({
  text: JSON.stringify({ name, arguments: args }),
  stopReason: 'stop' as const,
});

describe('offline product workflows through the ordinary client', () => {
  it('pins imported models per conversation and refuses missing pinned models before saving a send', async () => {
    const f = await setup();
    const first = await f.client.createChatSession({ gezelId: f.meester });
    expect(first.model).toBe('model-a');
    f.select('model-b');
    await f.client.sendToChatSession(first.id, { message: 'Hello' });
    await idle(f.service);
    expect(f.requests[0]).toMatchObject({ modelId: 'model-a', contextSize: 8192, maxTokens: 512 });
    const second = await f.client.createChatSession({ gezelId: f.meester });
    expect(second.model).toBe('model-b');
    f.remove('model-a');
    await expect(
      f.client.sendToChatSession(first.id, { message: 'Do not lose this model identity' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.store.getSession(f.meester, first.id))!.messages).toHaveLength(2);
  });
  it('honors engagement off and cancels an admitted native turn when it changes', async () => {
    let resolve: ((value: { text: string; stopReason: 'cancelled' }) => void) | undefined;
    const f = await setup(
      async () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    f.inference.cancel = async () => {
      resolve?.({ text: '', stopReason: 'cancelled' });
    };
    const session = await f.client.createChatSession({ gezelId: f.meester });
    await f.client.updateConfig({ aiEngagementMode: 'off' });
    await expect(
      f.client.sendToChatSession(session.id, { message: 'Blocked' }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await f.store.getSession(f.meester, session.id))!.messages).toHaveLength(0);
    await f.client.updateConfig({ aiEngagementMode: 'proactive' });
    await f.client.sendToChatSession(session.id, { message: 'Start' });
    for (let i = 0; i < 50 && !resolve; i++) await new Promise((r) => setTimeout(r, 2));
    await f.client.updateConfig({ aiEngagementMode: 'off' });
    await idle(f.service);
    expect((await f.store.getSession(f.meester, session.id))!.messages.at(-1)?.status).toBe(
      'interrupted',
    );
  });
  it('lets the Meester start a project, hands off once, and saves the crew artifact and completed task', async () => {
    let calls = 0;
    const f = await setup(async (request) => {
      calls++;
      if (calls === 1)
        return tool('start_project', {
          name: 'Weekend notes',
          about: 'Keep a useful written report about plans for the weekend.',
          taskDescription:
            'Write a short report to weekend.md in the artifacts drawer and then complete the task.',
        });
      if (calls === 2)
        return tool('write_artifact', {
          path: 'weekend.md',
          content: '# Weekend\nTake a walk and read a book.',
        });
      if (calls === 3) {
        const ref = request.messages[0]!.content.match(/Current task: (weekend-notes\/\d+)/)?.[1];
        expect(ref).toBe('weekend-notes/1');
        return tool('advance_task_step', { ref, stepId: await activeStep(f.store, ref!) });
      }
      return { text: 'The report is saved in weekend.md.', stopReason: 'stop' };
    });
    const session = await f.client.createChatSession({ gezelId: f.meester });
    await f.client.sendToChatSession(session.id, {
      message: 'Please start the weekend notes project.',
    });
    await idle(f.service);
    expect(await f.store.readFile('artifacts', 'weekend-notes', 'weekend.md')).toContain(
      'Take a walk',
    );
    expect((await f.store.getTask('weekend-notes/1'))?.status).toBe('complete');
    const project = await f.store.getProject('weekend-notes');
    expect(project?.gezelIds).toContain(project?.voormanGezelId);
    const sessions = await f.store.listSessions({ projectId: 'weekend-notes' });
    expect(sessions).toHaveLength(1);
    const work = (await f.store.getSession(sessions[0]!.gezelId, sessions[0]!.id))!;
    expect(work.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(work.messages.at(-1)?.toolCalls?.map((c) => [c.name, c.success])).toEqual([
      ['write_artifact', true],
      ['advance_task_step', true],
    ]);
    const reopened = new PortableProductService(f.store, f.inference, 'again');
    await reopened.initialize();
    expect(calls).toBe(3);
    expect((await f.store.getTask('weekend-notes/1'))?.status).toBe('complete');
  });
  it('enforces the same role kit: a Meester cannot write workspace files', async () => {
    let calls = 0;
    const f = await setup(async () =>
      ++calls === 1
        ? tool('write_file', { path: 'unauthorized.txt', content: 'no' })
        : { text: 'I need a builder to do that.', stopReason: 'stop' },
    );
    const session = await f.client.createChatSession({ gezelId: f.meester });
    await f.client.sendToChatSession(session.id, { message: 'Write a file' });
    await idle(f.service);
    expect(await f.store.readFile('workspace', 'default', 'unauthorized.txt')).toBeNull();
    expect(
      (await f.store.getSession(f.meester, session.id))!.messages.at(-1)?.toolCalls?.[0],
    ).toMatchObject({ name: 'write_file', success: false });
  });
  it.each([true, false])(
    'keeps an ordinary project-lead chat running after gate rejection (repair: %s)',
    async (repair) => {
      let calls = 0;
      const f = await setup(async (request) => {
        calls++;
        if (calls === 1)
          return tool('advance_task_step', {
            ref: 'default/1',
            stepId: await activeStep(f.store, 'default/1'),
          });
        if (calls === 2) {
          expect(request.messages.at(-1)?.content).toContain('"decision":"reject"');
          if (!repair)
            return { text: 'The report is missing, so the task remains open.', stopReason: 'stop' };
          return tool('write_artifact', {
            path: 'tasks/1/report.md',
            content: '# Report\nA useful report with enough detail to pass its check.',
          });
        }
        return tool('advance_task_step', {
          ref: 'default/1',
          stepId: await activeStep(f.store, 'default/1'),
        });
      });
      const lead = await f.client.createGezel({ name: 'Noor', role: 'Generalist' });
      await f.client.updateProject('default', { voormanGezelId: lead.id });
      const task = await f.client.createTask('default', {
        title: 'Gated report',
        description: 'Write a useful report and save the completed work to the task artifacts.',
        assignee: { kind: 'gezel', gezelId: f.meester },
        steps: [
          {
            name: 'Report',
            terminal: true,
            gate: {
              at: 'completion',
              checks: [{ kind: 'minBytes', file: 'tasks/1/report.md', bytes: 20, artifact: true }],
            },
          },
        ],
      });
      const session = await f.client.createChatSession({ gezelId: lead.id });
      expect(session.taskRef).toBeUndefined();
      expect(session.stepId).toBeUndefined();
      await f.client.sendToChatSession(session.id, {
        message: 'Please complete default/1 if its report passes the check.',
      });
      await idle(f.service);
      const saved = await f.store.getSession(lead.id, session.id);
      const reply = saved!.messages.at(-1)!;
      expect(JSON.parse(reply.toolCalls![0]!.resultText!).gate.decision).toBe('reject');
      expect(calls).toBe(repair ? 3 : 2);
      expect((await f.client.getTask('default', task.num)).status).toBe(
        repair ? 'complete' : 'active',
      );
      if (repair) {
        expect(reply.toolCalls!.map((call) => call.name)).toEqual([
          'advance_task_step',
          'write_artifact',
          'advance_task_step',
        ]);
        expect(await f.store.readFile('artifacts', 'default', 'tasks/1/report.md')).toContain(
          'useful report',
        );
      } else {
        expect(reply.content).toBe('The report is missing, so the task remains open.');
        expect(reply.content).not.toContain('complete');
      }
    },
  );

  it('never executes fenced examples', async () => {
    const f = await setup(async () => ({
      text: '```json\n{"name":"write_document","arguments":{"path":"example.md","content":"no"}}\n```',
      stopReason: 'stop',
    }));
    const session = await f.client.createChatSession({ gezelId: f.meester });
    await f.client.sendToChatSession(session.id, { message: 'Show an example' });
    await idle(f.service);
    expect(await f.store.readFile('documents', undefined, 'example.md')).toBeNull();
  });
  it('runs a manually created task through the client, gates its deliverable and saves its task session', async () => {
    let calls = 0;
    const f = await setup(async () => {
      calls++;
      if (calls === 1)
        return tool('advance_task_step', {
          ref: 'default/1',
          stepId: await activeStep(f.store, 'default/1'),
        });
      if (calls === 2)
        return tool('write_artifact', {
          path: 'tasks/1/report.md',
          content: '# Report\nA useful offline report with supporting detail.',
        });
      return tool('advance_task_step', {
        ref: 'default/1',
        stepId: await activeStep(f.store, 'default/1'),
      });
    });
    const task = await f.client.createTask('default', {
      title: 'Offline report',
      description: 'Write a useful offline report and save it to the task artifacts folder.',
      steps: [
        {
          name: 'Write report',
          terminal: true,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'tasks/1/report.md', bytes: 20, artifact: true }],
          },
        },
      ],
    });
    expect(task.assignee.kind).toBe('gezel');
    expect((await f.client.retryTask('default', task.num)).dispatched).toBe(true);
    await idle(f.service);
    expect((await f.client.getTask('default', task.num)).status).toBe('complete');
    const { sessions } = await f.client.listTaskSessions('default', task.num);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.taskRef).toBe(task.ref);
    const saved = await f.store.getSession(sessions[0]!.gezelId, sessions[0]!.id);
    const callsSaved = saved!.messages.at(-1)!.toolCalls!;
    expect(JSON.parse(callsSaved[0]!.resultText!).gate.decision).toBe('reject');
    expect(callsSaved.map((call) => call.name)).toEqual([
      'advance_task_step',
      'write_artifact',
      'advance_task_step',
    ]);
    expect(calls).toBe(3);
  });
});
