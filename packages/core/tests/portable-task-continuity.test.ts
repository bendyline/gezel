import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { portableFixture } from '../src/runtime/test-files.js';

async function fixture(driftModel = false) {
  const f = portableFixture();
  let owner = '';
  const inputs: Parameters<PortableInference['generate']>[0][] = [];
  const service = new PortableProductService(
    f.store,
    {
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Offline',
          locality: 'on-device',
          availability: 'available',
          contextTokens: 8192,
          maxOutputTokens: 1024,
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
        inputs.push(request);
        if (inputs.length === 1) {
          await f.store.writeConfig({ generalistMode: 'off' });
          if (driftModel) await f.store.updateGezelSettings(owner, { model: 'second-model' });
        }
        return {
          text: JSON.stringify({
            name: 'advance_task_step',
            arguments: {
              ref: 'default/1',
              stepId: (await f.store.getTask('default/1'))?.activeStepId,
            },
          }),
          stopReason: 'stop',
        };
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
  await f.store.writeConfig({ generalistMode: 'on' });
  const task = await client.createTask('default', {
    title: 'Prepare and review',
    description: 'Prepare a short report and review the completed report.',
    steps: [
      { name: 'Prepare', suggestedRole: 'Developer' },
      { name: 'Review', suggestedRole: 'Reviewer', terminal: true },
    ],
  });
  if (task.assignee.kind === 'gezel') owner = task.assignee.gezelId;
  return { ...f, service, client, task, inputs, owner };
}

describe('task transcript continuity through the shared client', () => {
  it('pins one generalist and carries the same transcript across two completed steps despite later config changes', async () => {
    const f = await fixture();
    expect(f.task.executionMode).toBe('generalist');
    expect((await f.store.getGezel(f.owner))?.role).toBe('Generalist');
    await f.client.retryTask('default', f.task.num);
    await vi.waitFor(() => expect(f.service.busy).toBe(false));
    const task = await f.client.getTask('default', f.task.num);
    expect(task.status).toBe('complete');
    expect(task.executionMode).toBe('generalist');
    const { sessions } = await f.client.listTaskSessions('default', f.task.num);
    expect(sessions).toHaveLength(1);
    const saved = await f.client.getChatSession(sessions[0]!.id);
    expect(saved.messages.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(saved.stepId).toBe(task.craftbook.steps[1]!.id);
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs[1]!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(f.inputs[1]!.messages[0]?.content).toContain('### Task outline');
    expect(f.inputs[1]!.messages[0]?.content).toContain('Review');
    expect(
      new Set(
        task.craftbook.steps.map((s) =>
          s.assignee?.kind === 'gezel' ? s.assignee.gezelId : 'human',
        ),
      ),
    ).toEqual(new Set([f.owner]));
  });

  it('creates a fresh transcript when an explicit model change occurs between steps', async () => {
    const f = await fixture(true);
    await f.client.retryTask('default', f.task.num);
    await vi.waitFor(() => expect(f.service.busy).toBe(false));
    expect((await f.client.getTask('default', f.task.num)).status).toBe('complete');
    expect((await f.client.listTaskSessions('default', f.task.num)).sessions).toHaveLength(2);
    expect(f.inputs[1]?.modelId).toBe('second-model');
    expect(f.inputs[1]?.messages.filter((m) => m.role === 'assistant')).toEqual([]);
  });
});

async function questionFixture(replies: Array<object | string>) {
  const f = portableFixture();
  const service = new PortableProductService(
    f.store,
    {
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Offline',
          locality: 'on-device',
          availability: 'available',
          contextTokens: 8192,
          maxOutputTokens: 1024,
          capabilities: {
            text: true,
            tools: false,
            images: false,
            structuredOutput: false,
            foregroundOnly: true,
          },
        },
      ],
      generate: async () => {
        const reply = replies.shift() ?? 'Done.';
        return {
          text: typeof reply === 'string' ? reply : JSON.stringify(reply),
          stopReason: 'stop' as const,
        };
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
  await f.store.writeConfig({ generalistMode: 'on' });
  return { ...f, service, client };
}

describe('a task step that asks the person a question', () => {
  it('carries on once the answer arrives, without another Try again', async () => {
    // A question ends its turn, and so does a call that moves the task.
    const replies = [
      { name: 'ask_user_question', arguments: { question: 'How many people are eating?' } },
      { name: 'advance_task_step', arguments: { ref: 'default/1', stepId: 'scope' } },
      { name: 'advance_task_step', arguments: { ref: 'default/1', stepId: 'plan' } },
    ];
    const { client, service } = await questionFixture(replies);
    const task = await client.createTask('default', {
      title: 'Plan the dinners',
      description: 'Plan the week of dinners for the household and write the plan down.',
      steps: [
        { id: 'scope', name: 'Scope', suggestedRole: 'Planner' },
        { id: 'plan', name: 'Plan', suggestedRole: 'Planner', terminal: true },
      ],
    });
    await client.retryTask('default', task.num);
    await vi.waitFor(async () =>
      expect((await client.listQuestions({ projectId: 'default' })).questions).toHaveLength(1),
    );
    await vi.waitFor(() => expect(service.busy).toBe(false));
    const [question] = (await client.listQuestions({ projectId: 'default' })).questions;
    expect((await client.getTask('default', task.num)).activeStepId).toBe('scope');

    await client.answerQuestion(question!.id, { writeIn: 'Two adults.' });
    await vi.waitFor(async () =>
      expect((await client.getTask('default', task.num)).status).toBe('complete'),
    );
    expect(replies).toHaveLength(0);
  });

  it('runs the step’s automatic check when the owner stops after answering', async () => {
    const replies = [
      { name: 'ask_user_question', arguments: { question: 'How many people are eating?' } },
      { name: 'write_file', arguments: { path: 'plan.md', content: '# Plan\n\nTwo adults.' } },
      'Saved the plan.',
      { name: 'advance_task_step', arguments: { ref: 'default/1', stepId: 'plan' } },
    ];
    const { client, service } = await questionFixture(replies);
    const task = await client.createTask('default', {
      title: 'Plan the dinners',
      description: 'Plan the week of dinners for the household and write the plan down.',
      steps: [
        {
          id: 'scope',
          name: 'Scope',
          suggestedRole: 'Planner',
          advanceWhen: { file: 'plan.md', minBytes: 8 },
        },
        { id: 'plan', name: 'Plan', suggestedRole: 'Planner', terminal: true },
      ],
    });
    await client.retryTask('default', task.num);
    await vi.waitFor(async () =>
      expect((await client.listQuestions({ projectId: 'default' })).questions).toHaveLength(1),
    );
    await vi.waitFor(() => expect(service.busy).toBe(false));
    const [question] = (await client.listQuestions({ projectId: 'default' })).questions;
    await client.answerQuestion(question!.id, { writeIn: 'Two adults.' });
    await vi.waitFor(async () =>
      expect((await client.getTask('default', task.num)).status).toBe('complete'),
    );
    expect(replies).toHaveLength(0);
  });
});
