import { describe, expect, it } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { PortableProductService } from '../src/runtime/product-service.js';
import { portableFixture } from '../src/runtime/test-files.js';

describe('ordinary task editing through the portable client', () => {
  it('edits structure with shared graph semantics and persists editable attributed notes', async () => {
    const { store } = portableFixture();
    const service = new PortableProductService(
      store,
      {
        providers: async () => [],
        generate: async () => {
          throw new Error('Unexpected inference');
        },
        cancel: async () => {},
      },
      'token',
    );
    await service.initialize();
    const client = new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'token',
      fetch: service.fetch,
    });
    let task = await client.createTask('default', {
      title: 'Notes workflow',
      description: 'Prepare useful notes, review them carefully, and preserve the result.',
      steps: [{ name: 'Prepare' }, { name: 'Review' }],
    });
    task = await client.addTaskStep('default', task.num, { name: 'Publish' });
    const [prepare, review, publish] = task.craftbook.steps.map((step) => step.id);
    expect(task.craftbook.steps).toHaveLength(3);
    await client.updateTaskStep('default', task.num, review!, {
      terminal: false,
      next: publish,
      prompt: 'Review the prepared notes.',
    });
    await client.updateTaskStep('default', task.num, publish!, { terminal: true });
    await client.reorderTaskSteps('default', task.num, [prepare!, publish!, review!]);
    await client.updateTaskCraftbook('default', task.num, {
      name: 'Shared workflow',
      plan: 'Prepare, review, then publish.',
    });
    await expect(
      client.updateTaskStep('default', task.num, prepare!, { next: 'missing' }),
    ).rejects.toThrow();
    expect((await client.getTask('default', task.num)).craftbook.steps[0]?.next).toBe(review);
    task = (await client.removeTaskStep('default', task.num, review!)).task;
    expect(task.craftbook.steps[0]?.next).toBeUndefined();
    expect(task.craftbook.name).toBe('Shared workflow');
    await client.activateTaskStep('default', task.num, publish!);
    expect((await client.getTask('default', task.num)).activeStepId).toBe(publish);
    const { note } = await client.appendTaskNote('default', task.num, {
      text: 'First draft',
      stepId: publish,
    });
    const { note: edited } = await client.updateTaskNote('default', task.num, note.id, {
      text: 'Reviewed draft',
    });
    expect(edited.author).toEqual(note.author);
    expect(edited.at).toBe(note.at);
    expect((await client.listTaskNotes('default', task.num, prepare)).notes).toEqual([]);
    expect((await client.listTaskNotes('default', task.num, publish)).notes[0]?.text).toBe(
      'Reviewed draft',
    );
    await client.deleteTaskNote('default', task.num, note.id);
    expect((await client.listTaskNotes('default', task.num)).notes).toEqual([]);
    const run = await store.beginTaskRun(task.ref);
    await expect(
      client.updateTaskStep('default', task.num, publish!, { prompt: 'Race' }),
    ).rejects.toThrow();
    await store.finishTaskRun(task.ref, run.runId);
  });
});

describe('continuous task execution through the portable client', () => {
  it('runs both assigned steps and their hooks in one foreground request', async () => {
    const { store } = portableFixture();
    const requests: string[] = [];
    const service = new PortableProductService(
      store,
      {
        providers: async () => [
          {
            id: 'llama-cpp',
            name: 'Offline',
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
        generate: async (request) => {
          requests.push(request.messages[0]!.content);
          return {
            text: JSON.stringify({
              name: 'advance_task_step',
              arguments: {
                ref: 'default/1',
                stepId: (await store.getTask('default/1'))?.activeStepId,
              },
            }),
            stopReason: 'stop',
          };
        },
        cancel: async () => {},
      },
      'token',
    );
    service.setScripts({
      list: () => [],
      source: async () => {
        throw new Error('Not needed');
      },
      initialize: async () => {},
      cancel: async () => {},
      isBusy: () => false,
      run: async (options) => {
        await store.writeFile(
          'artifacts',
          options.projectId,
          `${options.scriptName}.md`,
          'Prepared offline',
        );
        const run = {
          id: crypto.randomUUID(),
          projectId: options.projectId,
          scriptName: options.scriptName,
          trigger: options.trigger,
          startedAt: new Date().toISOString(),
          status: 'ok' as const,
          inputs: {},
          calls: [],
          logs: '',
        };
        await store.writeScriptRun(run);
        return run;
      },
    });
    await service.initialize();
    const client = new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'token',
      fetch: service.fetch,
    });
    const writer = await client.createGezel({ name: 'Noor', role: 'Generalist' });
    const reviewer = await client.createGezel({ name: 'Iris', role: 'Generalist' });
    const task = await client.createTask('default', {
      title: 'Prepared report',
      description: 'Prepare a useful report, then ask the assigned reviewer to finish it.',
      assignee: { kind: 'gezel', gezelId: writer.id },
      steps: [
        {
          name: 'Prepare',
          onEnter: { name: 'prepareReport', scope: 'standard' },
          onExit: { name: 'saveReport', scope: 'standard' },
        },
        {
          name: 'Review',
          assignee: { kind: 'gezel', gezelId: reviewer.id },
          terminal: true,
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'saveReport.md', bytes: 5, artifact: true }],
          },
        },
      ],
    });
    await client.retryTask('default', task.num);
    for (let i = 0; i < 500 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(service.busy).toBe(false);
    expect((await client.getTask('default', task.num)).status).toBe('complete');
    const { sessions } = await client.listTaskSessions('default', task.num);
    expect(new Set(sessions.map((session) => session.gezelId))).toEqual(
      new Set([writer.id, reviewer.id]),
    );
    expect(requests).toHaveLength(2);
    expect(await store.readFile('artifacts', 'default', 'prepareReport.md')).toBe(
      'Prepared offline',
    );
    expect(await store.readFile('artifacts', 'default', 'saveReport.md')).toBe('Prepared offline');
  });
});
