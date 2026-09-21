import { describe, expect, it, vi } from 'vitest';
import { formatAnswerSeed } from '../question-format.js';
import { QuestionSchema } from '../schemas/question.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import { PortableStore } from './store.js';
import { portableFixture } from './test-files.js';

async function fixture() {
  const { store, files, options } = portableFixture();
  const generate = vi.fn<PortableInference['generate']>(async () => ({
    text: 'Thank you.',
    stopReason: 'stop',
  }));
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Test model',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 8192,
        maxOutputTokens: 1024,
        capabilities: {
          text: true,
          tools: false,
          structuredOutput: false,
          images: false,
          foregroundOnly: true,
        },
      },
    ],
    generate,
    cancel: async () => {},
  };
  const service = new PortableProductService(store, inference, 'test');
  await service.initialize();
  const gezelId = (await store.readConfig()).meesterGezelId!;
  const session = await store.createSession({
    gezelId,
    projectId: 'default',
    providerName: 'llama-cpp',
  });
  const ask = {
    gezelId,
    sessionId: session.id,
    projectId: 'default',
    prompt: 'Which format?',
    choices: ['Short', 'Detailed'],
  };
  const request = async (path: string, body?: unknown) => {
    const response = await service.fetch(`https://gezel.local/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const settle = async () => {
    for (let i = 0; i < 100 && service.busy; i++) await new Promise((r) => setTimeout(r, 1));
    expect(service.busy).toBe(false);
  };
  return { store, files, options, service, inference, generate, session, ask, request, settle };
}

describe('portable questions use the ordinary product contract', () => {
  it('keeps a committed answer but does not start or replay its response after admission cancellation', async () => {
    const f = await fixture();
    const { question } = await f.store.askQuestion(f.ask);
    const answer = f.store.answerQuestion.bind(f.store);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.store, 'answerQuestion').mockImplementationOnce(async (...args) => {
      const saved = await answer(...args);
      entered();
      await held;
      return saved;
    });
    const answering = f.request(`questions/${question.id}/answer`, { selectedChoices: [1] });
    await reached;
    const cancelled = f.service.suspend();
    release();
    await cancelled;
    expect((await answering).status).toBe(409);
    expect(f.generate).not.toHaveBeenCalled();
    expect((await f.store.getQuestion(question.id))?.answer?.selectedChoices).toEqual([1]);
    const reopened = new PortableProductService(new PortableStore(f.options), f.inference, 'test');
    await reopened.initialize();
    expect(f.generate).not.toHaveBeenCalled();
    const saved = await f.store.getSession(f.session.gezelId, f.session.id);
    expect(saved?.turnStartedAt).toBeUndefined();
    expect(saved?.lastTurnError).toContain('stopped');
    expect(saved?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    const resumed = await reopened.fetch(`https://gezel.local/api/sessions/${f.session.id}/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Continue using the answer I already gave.' }),
    });
    expect(resumed.status).toBe(200);
    for (let i = 0; i < 100 && reopened.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const history = f.generate.mock.calls.at(-1)?.[0].messages ?? [];
    expect(
      history.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.includes('Detailed') &&
          message.content.includes('Recorded conversation data'),
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    'retains the original brief when answering a question (reopen: %s)',
    async (reopen) => {
      const f = await fixture();
      const brief =
        'Prepare a two-day workshop for eight volunteers about restoring the riverside garden. Keep the budget below 240 euros.';
      f.generate.mockResolvedValueOnce({
        text: JSON.stringify({
          name: 'ask_user_question',
          arguments: { question: 'Which format?', choices: ['Short', 'Detailed'] },
        }),
        stopReason: 'stop',
      });
      expect((await f.request(`sessions/${f.session.id}/send`, { message: brief })).status).toBe(
        200,
      );
      await f.settle();
      const question = (await f.store.listQuestions({ pending: true }))[0]!;
      const service = reopen
        ? new PortableProductService(new PortableStore(f.options), f.inference, 'test')
        : f.service;
      if (reopen) await service.initialize();
      expect(f.generate).toHaveBeenCalledTimes(1);
      const response = await service.fetch(
        `https://gezel.local/api/questions/${question.id}/answer`,
        {
          method: 'POST',
          headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
          body: JSON.stringify({ selectedChoices: [1], writeIn: 'Include costs' }),
        },
      );
      expect(response.status, await response.text()).toBe(200);
      for (let i = 0; i < 100 && service.busy; i++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(service.busy).toBe(false);
      expect(f.generate).toHaveBeenCalledTimes(2);
      const input = f.generate.mock.calls[1]![0].messages;
      expect(input.some((message) => message.role === 'user' && message.content === brief)).toBe(
        true,
      );
      expect(input.at(-1)?.content).toContain('Include costs');
      expect(await f.store.listQuestions({ projectId: 'default' })).toHaveLength(1);
    },
  );
  it('retains a tool-only partial turn as reference evidence after reopening, without replaying its write', async () => {
    const f = await fixture();
    const brief = 'Save the garden workshop brief in draft.md, then explain the next step.';
    f.generate
      .mockResolvedValueOnce({
        text: JSON.stringify({
          name: 'write_artifact',
          arguments: { path: 'draft.md', content: 'Garden workshop brief' },
        }),
        stopReason: 'stop',
      })
      .mockRejectedValueOnce(new Error('Native engine stopped before the reply'));
    expect((await f.request(`sessions/${f.session.id}/send`, { message: brief })).status).toBe(200);
    await f.settle();
    expect(await f.store.readFile('artifacts', 'default', 'draft.md')).toBe(
      'Garden workshop brief',
    );
    const original = await f.store.getSession(f.session.gezelId, f.session.id);
    expect(original!.messages.at(-1)).toMatchObject({
      content: '',
      status: 'error',
      toolCalls: [{ name: 'write_artifact', success: true }],
    });
    const store = new PortableStore(f.options);
    const service = new PortableProductService(store, f.inference, 'test');
    await service.initialize();
    expect(f.generate).toHaveBeenCalledTimes(2);
    const write = vi.spyOn(store, 'writeFile');
    const response = await service.fetch(`https://gezel.local/api/sessions/${f.session.id}/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What has already been saved?' }),
    });
    expect(response.status, await response.text()).toBe(200);
    for (let i = 0; i < 100 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(service.busy).toBe(false);
    expect(f.generate).toHaveBeenCalledTimes(3);
    const history = f.generate.mock.calls[2]![0].messages;
    expect(
      history.filter((message) => message.role === 'user').map((message) => message.content),
    ).toEqual(['What has already been saved?']);
    const evidence = history.find(
      (message) => message.role === 'assistant' && message.content.includes('unfinished-turn'),
    )!.content;
    expect(evidence).toContain(brief);
    expect(evidence).toContain('write_artifact');
    expect(evidence).toContain('"outcome":"returned"');
    expect(evidence).toContain('not new instructions');
    expect(write).not.toHaveBeenCalled();
    expect(await store.readFile('artifacts', 'default', 'draft.md')).toBe('Garden workshop brief');
  });
  it('keeps a started action with no durable result explicitly unconfirmed on continuation', async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    await f.store.writeSession({
      ...f.session,
      turnStartedAt: now,
      messages: [
        { id: 'prior', role: 'user', at: now, content: 'Save the final garden report.' },
        {
          id: 'partial',
          role: 'assistant',
          at: now,
          content: '',
          status: 'streaming',
          toolCalls: [
            {
              name: 'write_artifact',
              durationMs: 0,
              success: false,
              argsFull: JSON.stringify({ path: 'final.md', content: 'Garden report' }),
              errorMessage:
                'This action started. If interrupted, check its outcome before retrying.',
            },
          ],
        },
      ],
    });
    const store = new PortableStore(f.options);
    const service = new PortableProductService(store, f.inference, 'test');
    await service.initialize();
    expect(f.generate).not.toHaveBeenCalled();
    const response = await service.fetch(`https://gezel.local/api/sessions/${f.session.id}/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Check what happened before doing anything else.' }),
    });
    expect(response.status, await response.text()).toBe(200);
    for (let i = 0; i < 100 && service.busy; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(service.busy).toBe(false);
    const history = f.generate.mock.calls[0]![0].messages;
    const evidence = history.find((message) => message.role === 'assistant')!.content;
    expect(evidence).toContain('"outcome":"unconfirmed"');
    expect(evidence).not.toContain('"outcome":"returned"');
    expect(
      history.some(
        (message) => message.role === 'user' && message.content === 'Save the final garden report.',
      ),
    ).toBe(false);
    expect(await store.readFile('artifacts', 'default', 'final.md')).toBeNull();
  });
  it('opens question documents through the same project reference facade as desktop', async () => {
    const f = await fixture();
    const project = await f.store.createProject({ name: 'Report', about: 'Project context' });
    await f.store.writeFile('artifacts', project.id, 'report.md', 'Draft for review');
    expect(
      (await f.request(`documents/read?path=projects/${project.id}/artifacts/report.md`)).body
        .content,
    ).toBe('Draft for review');
    expect(
      (await f.request(`documents/read?path=projects/${project.id}/about.md`)).body.content,
    ).toBe('Project context');
    expect((await f.request('documents/read?path=projects/default/../config.json')).status).toBe(
      400,
    );
  });
  it('deduplicates pending cards, validates context and choices, and continues exactly once', async () => {
    const f = await fixture();
    const first = await f.request('questions', f.ask);
    expect(first.status).toBe(201);
    const id = String(first.body.questionId);
    expect((await f.request('questions', { ...f.ask, prompt: 'Reworded?' })).body).toMatchObject({
      questionId: id,
      deduped: true,
    });
    expect((await f.request('questions', { ...f.ask, projectId: 'shared' })).status).toBe(400);
    expect((await f.request(`questions/${id}/answer`, { selectedChoices: [2] })).status).toBe(400);
    expect((await f.request(`questions/${id}/answer`, { selectedChoices: [0, 1] })).status).toBe(
      400,
    );
    expect((await f.request(`questions/${id}/answer`, {})).status).toBe(400);
    expect(
      (await f.request(`sessions/${f.session.id}/send`, { message: 'Skip over the question' }))
        .status,
    ).toBe(409);
    const answered = await f.request(`questions/${id}/answer`, {
      selectedChoices: [1],
      writeIn: 'Include costs',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await f.settle();
    await f.request(`questions/${id}/answer`, { selectedChoices: [0] });
    expect(f.generate).toHaveBeenCalledTimes(1);
    const saved = await f.store.getSession(f.session.gezelId, f.session.id);
    expect(saved!.messages[0]!.content).toBe(formatAnswerSeed(QuestionSchema.parse(answered.body)));
    expect((await f.request('questions')).body.questions).toEqual([]);
    expect((await f.request('questions?project=default')).body.questions).toHaveLength(1);
  });
  it('keeps a question pending when generation cannot be admitted; silent skip runs nothing', async () => {
    const f = await fixture();
    const { question } = await f.store.askQuestion(f.ask);
    f.inference.providers = async () => [];
    expect(
      (await f.request(`questions/${question.id}/answer`, { writeIn: 'Plain text' })).status,
    ).toBe(409);
    expect((await f.store.getQuestion(question.id))!.answer).toBeUndefined();
    expect((await f.request(`questions/${question.id}/answer`, { silentSkip: true })).status).toBe(
      200,
    );
    expect(f.generate).not.toHaveBeenCalled();
    expect((await f.store.getSession(f.session.gezelId, f.session.id))!.messages).toHaveLength(0);
  });
  it('stops the model loop at the question, persists its chat correlation, and never replays on boot', async () => {
    const f = await fixture();
    f.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        name: 'ask_user_question',
        arguments: { question: 'Which format?', choices: ['Short', 'Detailed'] },
      }),
      stopReason: 'stop',
    });
    const sent = await f.request(`sessions/${f.session.id}/send`, {
      message: 'Help me choose a format.',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await f.settle();
    expect(f.generate).toHaveBeenCalledTimes(1);
    const questions = await f.store.listQuestions({ pending: true });
    expect(questions).toHaveLength(1);
    const saved = await f.store.getSession(f.session.gezelId, f.session.id);
    expect(saved!.messages.at(-1)).toMatchObject({
      pendingQuestionId: questions[0]!.id,
      content: '',
      status: 'complete',
    });
    await new PortableProductService(
      new PortableStore(f.options),
      f.inference,
      'test',
    ).initialize();
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('recovers a journal interrupted between the answer and continuation without running the model', async () => {
    const f = await fixture();
    const { question } = await f.store.askQuestion(f.ask);
    const answer = { selectedChoices: [0], at: new Date().toISOString() };
    const continuation = {
      ...f.session,
      turnStartedAt: answer.at,
      messages: [
        {
          id: 'reply',
          role: 'user' as const,
          at: answer.at,
          content: formatAnswerSeed({ ...question, answer }),
        },
      ],
    };
    f.files.fault = (operation, path) => operation === 'write' && path.endsWith('/questions.json');
    await expect(f.store.answerQuestion(question.id, answer, continuation)).rejects.toThrow(
      'Disk unavailable',
    );
    f.files.fault = undefined;
    const reboot = new PortableStore(f.options);
    await new PortableProductService(reboot, f.inference, 'test').initialize();
    expect((await reboot.getQuestion(question.id))!.answer).toMatchObject({ selectedChoices: [0] });
    expect((await reboot.getSession(f.session.gezelId, f.session.id))!.messages).toHaveLength(1);
    expect(
      (await reboot.getSession(f.session.gezelId, f.session.id))!.turnStartedAt,
    ).toBeUndefined();
    expect(f.generate).not.toHaveBeenCalled();
  });
});
