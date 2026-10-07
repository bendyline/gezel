import type { Task } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { describe, expect, it, vi } from 'vitest';
import {
  craftbookDoLaunch,
  parseCraftbookArguments,
  resolveCraftbookInvocation,
  waitForTask,
} from './craftbook-command.js';
import type { StartCraftbook } from './tui/craftbook-start.js';

const book = {
  paramSchema: {
    type: 'object',
    required: ['region', 'limit'],
    properties: {
      region: { type: 'string', pattern: '^[0-9bcdefghjkmnpqrstuvwxyz]{2,4}$' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
      dryRun: { type: 'boolean', default: false },
      workPath: { type: 'string', default: '{{task.dir}}' },
    },
  },
};

describe('shell craftbook arguments', () => {
  it('resolves multiword names before consuming positional parameters', () => {
    const books = [
      { id: 'review', name: 'Code Review' },
      { id: 'code', name: 'Code' },
    ] as StartCraftbook[];
    expect(resolveCraftbookInvocation(books, ['Code', 'Review', 'c23n']).book.id).toBe('review');
    expect(resolveCraftbookInvocation(books, ['review', 'c23n']).args).toEqual(['c23n']);
  });
  it('sends explicit parameters and leaves runtime defaults to the service', () => {
    expect(parseCraftbookArguments(book, ['c23n', 'limit=2', 'dryRun=true'])).toEqual({
      params: { region: 'c23n', limit: '2', dryRun: 'true' },
    });
    expect(parseCraftbookArguments(book, ['c23'])).toEqual({ params: { region: 'c23' } });
    expect(parseCraftbookArguments(book, ['c23'], ['limit=4', 'workPath=shared-run'])).toEqual({
      params: { region: 'c23', limit: '4', workPath: 'shared-run' },
    });
  });
  it.each([
    [['c23n', 'region=c2']],
    [['c23n', 'unknown=1']],
    [['c23n', 'limit=0']],
    [['c23n', 'limit=NaN']],
    [['c23n', 'limit=1.5']],
    [['c23n', 'dryRun=yes']],
    [['invalid']],
    [[]],
    [['c23n'], ['limit']],
  ])('rejects invalid input %j %j', (args, named?: string[]) => {
    expect(() => parseCraftbookArguments(book, args, named)).toThrow();
  });
});

describe('the request a person types after a craftbook', () => {
  const summarize = {
    name: 'Summarize a Long Document',
    paramSchema: {
      type: 'object',
      properties: { workPath: { type: 'string', default: '{{task.dir}}' } },
    },
  };
  const deck = {
    name: 'PowerPoint Deck',
    paramSchema: {
      type: 'object',
      properties: {
        workPath: { type: 'string', default: '{{task.dir}}' },
        outputDir: { type: 'string', default: 'decks' },
        topic: { type: 'string' },
        audience: { type: 'string' },
      },
    },
  };

  it('never lands in the runtime-owned working folder', () => {
    // 257 of 296 bundled books declare workPath first; this sentence used to
    // become the artifacts folder and the gate waited for "<sentence>/scope.md".
    const parsed = parseCraftbookArguments(summarize, ['Summarize notes.txt in this folder']);
    expect(parsed).toEqual({ params: {}, request: 'Summarize notes.txt in this folder' });
    expect(craftbookDoLaunch(summarize, parsed)).toEqual({
      description:
        'Summarize notes.txt in this folder\n\nRun the "Summarize a Long Document" craftbook end to end for this request.',
      craftbookParams: {},
    });
  });

  it('joins unquoted words and keeps optional parameters for key=value', () => {
    expect(
      parseCraftbookArguments(deck, ['A', 'deck', 'about', 'Delft', 'audience=investors']),
    ).toEqual({
      params: { audience: 'investors' },
      request: 'A deck about Delft',
    });
  });

  it('fills the main content parameter and the description from one request', () => {
    const request = 'A twelve-slide deck about Delft pottery for the museum board, with a timeline';
    expect(craftbookDoLaunch(deck, parseCraftbookArguments(deck, [request]))).toEqual({
      description: request,
      craftbookParams: { topic: request },
    });
    expect(
      craftbookDoLaunch(deck, parseCraftbookArguments(deck, ['Delft pottery', 'topic=Delft'])),
      'a topic the person named stays theirs',
    ).toMatchObject({ craftbookParams: { topic: 'Delft' } });
  });

  it('fills required values first, and only ones a person is asked for', () => {
    expect(parseCraftbookArguments(book, ['c23n', 'Make', 'three', 'stories'])).toEqual({
      params: { region: 'c23n' },
      request: 'Make three stories',
    });
    const review = {
      paramSchema: {
        type: 'object',
        required: ['reviewId'],
        properties: { reviewId: { type: 'string', askUser: false } },
      },
    };
    expect(() => parseCraftbookArguments(review, ['Check the diff'])).toThrow(
      'missing required craftbook parameter: reviewId',
    );
    expect(parseCraftbookArguments(review, ['Check the diff', 'reviewId=r-7'])).toEqual({
      params: { reviewId: 'r-7' },
      request: 'Check the diff',
    });
  });

  it('starts a book with no words at all from its own description', () => {
    expect(craftbookDoLaunch(summarize, parseCraftbookArguments(summarize, []))).toEqual({
      craftbookParams: {},
    });
  });
});

describe('task wait', () => {
  const task = (status: Task['status']) =>
    ({ status, projectId: 'p', num: 1, ref: 'p/1', craftbook: {} }) as Task;
  it.each([
    ['complete', 0],
    ['paused', 2],
    ['draft', 2],
    ['canceled', 1],
  ] as const)('returns a useful code for %s', async (status, code) => {
    const result = await waitForTask(
      { getTaskByRef: vi.fn().mockResolvedValue(task(status)), listTaskChildren: vi.fn() },
      'p/1',
      { timeoutMs: 100 },
    );
    expect(result.exitCode).toBe(code);
  });
  it('follows active work and detects a blocked fanout child', async () => {
    const client = {
      getTaskByRef: vi
        .fn()
        .mockResolvedValueOnce(task('active'))
        .mockResolvedValue(task('complete')),
      listTaskChildren: vi.fn(),
    };
    expect((await waitForTask(client, 'p/1', { timeoutMs: 100, pollMs: 1 })).outcome).toBe(
      'complete',
    );
    client.getTaskByRef.mockResolvedValue({ ...task('active'), craftbook: { spawn: {} } });
    client.listTaskChildren.mockResolvedValue({ tasks: [task('paused')] });
    expect((await waitForTask(client, 'p/1', { timeoutMs: 100 })).outcome).toBe('blocked');
    client.getTaskByRef
      .mockResolvedValueOnce({
        ...task('active'),
        craftbook: { cliWorkflow: { module: '.gezel/workflows/batch.mjs' } },
      })
      .mockResolvedValue(task('complete'));
    expect((await waitForTask(client, 'p/1', { timeoutMs: 100, pollMs: 1 })).outcome).toBe(
      'complete',
    );
  });
  it('keeps watching a mixed fanout while other children still run', async () => {
    const client = {
      getTaskByRef: vi
        .fn()
        .mockResolvedValueOnce({ ...task('active'), craftbook: { spawn: {} } })
        .mockResolvedValue(task('complete')),
      listTaskChildren: vi.fn().mockResolvedValue({ tasks: [task('paused'), task('active')] }),
    };
    expect((await waitForTask(client, 'p/1', { timeoutMs: 100, pollMs: 1 })).outcome).toBe(
      'complete',
    );
  });
  it('a CLI batch decides when child questions block the whole parent', async () => {
    const parent = { ...task('active'), craftbook: { cliWorkflow: { module: 'batch.mjs' } } };
    const client = {
      getTaskByRef: vi.fn().mockResolvedValueOnce(parent).mockResolvedValue(task('paused')),
      listTaskChildren: vi.fn().mockResolvedValue({ tasks: [{ ...task('paused'), ref: 'p/2' }] }),
      listQuestions: vi
        .fn()
        .mockResolvedValue({ questions: [{ id: 'child-question', taskRef: 'p/2' }] }),
    };
    const result = await waitForTask(client, 'p/1', { timeoutMs: 100, pollMs: 1 });
    expect(result.task.status).toBe('paused');
    expect(result.questionIds).toBeUndefined();
  });
  it('ignores historical pause cards after a retry without answering them', async () => {
    const client = {
      getTaskByRef: vi
        .fn()
        .mockResolvedValueOnce(task('active'))
        .mockResolvedValue(task('complete')),
      listTaskChildren: vi.fn(),
      listQuestions: vi.fn().mockResolvedValue({
        questions: [
          {
            id: 'old-pause',
            taskRef: 'p/1',
            sessionId: '',
            intent: { kind: 'task-paused' },
          },
        ],
      }),
      answerQuestion: vi.fn(),
    };
    expect((await waitForTask(client, 'p/1', { timeoutMs: 100, pollMs: 1 })).outcome).toBe(
      'complete',
    );
    expect(client.answerQuestion).not.toHaveBeenCalled();
  });
  it('still blocks real questions alongside a historical pause card', async () => {
    const client = {
      getTaskByRef: vi.fn().mockResolvedValue(task('active')),
      listTaskChildren: vi.fn(),
      listQuestions: vi.fn().mockResolvedValue({
        questions: [
          { id: 'old-pause', taskRef: 'p/1', sessionId: '', intent: { kind: 'task-paused' } },
          { id: 'permission', taskRef: 'p/1', sessionId: 'session' },
          { id: 'service-question', taskRef: 'p/1', sessionId: '' },
        ],
      }),
    };
    const result = await waitForTask(client, 'p/1', { timeoutMs: 100 });
    expect(result.outcome).toBe('blocked');
    expect(result.questionIds).toEqual(['permission', 'service-question']);
  });
  it('times out without canceling the daemon task', async () => {
    const client = {
      getTaskByRef: vi.fn().mockResolvedValue(task('active')),
      listTaskChildren: vi.fn(),
    };
    expect((await waitForTask(client, 'p/1', { timeoutMs: 1, pollMs: 2 })).exitCode).toBe(3);
  });
  it('observes the task once even when the budget lapsed before the first read', async () => {
    const client = {
      getTaskByRef: vi.fn().mockResolvedValue(task('active')),
      listTaskChildren: vi.fn(),
    };
    const result = await waitForTask(client, 'p/1', { timeoutMs: 0 });
    expect(result).toMatchObject({ outcome: 'timeout', exitCode: 3 });
    expect(client.getTaskByRef).toHaveBeenCalledOnce();
  });
  it('exits when a task is waiting for a user answer', async () => {
    const client = {
      getTaskByRef: vi.fn().mockResolvedValue(task('active')),
      listTaskChildren: vi.fn(),
      listQuestions: vi.fn().mockResolvedValue({
        questions: [
          { id: 'answer-me', taskRef: 'p/1' },
          { id: 'unrelated', taskRef: 'p/2' },
        ],
      }),
    };
    const result = await waitForTask(client, 'p/1', { timeoutMs: 100 });
    expect(result.outcome).toBe('blocked');
    expect(result.questionIds).toEqual(['answer-me']);
  });
});

describe('bounded task observation recovery', () => {
  const task = (status: Task['status']) =>
    ({ status, projectId: 'p', num: 1, ref: 'p/1', craftbook: { spawn: {} } }) as Task;
  const reset = () =>
    new GezelApiError('Task GET failed', 0, {
      kind: 'transport',
      cause: 'fetch failed (read ECONNRESET)',
    });

  it.each(['getTaskByRef', 'listTaskChildren', 'listQuestions'] as const)(
    'retries only the failed %s read before completing',
    async (method) => {
      const client = {
        getTaskByRef: vi
          .fn()
          .mockResolvedValueOnce(task('active'))
          .mockResolvedValue(task('complete')),
        listTaskChildren: vi.fn().mockResolvedValue({ tasks: [] }),
        listQuestions: vi.fn().mockResolvedValue({ questions: [] }),
        createTask: vi.fn(),
        setTaskStatus: vi.fn(),
      };
      if (method === 'getTaskByRef')
        client.getTaskByRef
          .mockReset()
          .mockRejectedValueOnce(reset())
          .mockResolvedValue(task('complete'));
      else client[method].mockRejectedValueOnce(reset());
      expect((await waitForTask(client, 'p/1', { timeoutMs: 5000, pollMs: 1 })).outcome).toBe(
        'complete',
      );
      expect(client[method]).toHaveBeenCalledTimes(2);
      expect(client.createTask).not.toHaveBeenCalled();
      expect(client.setTaskStatus).not.toHaveBeenCalled();
    },
  );

  it('bounds persistent connection failures at the initial request plus three retries', async () => {
    const error = reset();
    const client = { getTaskByRef: vi.fn().mockRejectedValue(error), listTaskChildren: vi.fn() };
    await expect(waitForTask(client, 'p/1', { timeoutMs: 5000 })).rejects.toBe(error);
    expect(client.getTaskByRef).toHaveBeenCalledTimes(4);
  });

  it.each([
    new GezelApiError('Unauthorized', 401),
    new GezelApiError('Quota', 429),
    new GezelApiError('Server error', 503),
    new GezelApiError('Bad certificate', 0, {
      kind: 'transport',
      cause: 'self-signed certificate',
    }),
    new Error('Programming error'),
    new SyntaxError('Invalid task JSON'),
  ])('does not retry non-transient failures: %s', async (error) => {
    const client = { getTaskByRef: vi.fn().mockRejectedValue(error), listTaskChildren: vi.fn() };
    await expect(waitForTask(client, 'p/1', { timeoutMs: 5000 })).rejects.toBe(error);
    expect(client.getTaskByRef).toHaveBeenCalledOnce();
  });

  it('does not multiply retries already exhausted by the public client', async () => {
    const error = new GezelApiError('Task GET failed', 0, {
      kind: 'transport',
      cause: 'read ECONNRESET',
      readRetryExhausted: true,
      attempts: 4,
    });
    const client = { getTaskByRef: vi.fn().mockRejectedValue(error), listTaskChildren: vi.fn() };
    await expect(waitForTask(client, 'p/1', { timeoutMs: 5000 })).rejects.toBe(error);
    expect(client.getTaskByRef).toHaveBeenCalledOnce();
  });

  it('keeps retries within the original timeout and never cancels the task', async () => {
    const client = {
      getTaskByRef: vi.fn().mockResolvedValue(task('active')),
      listTaskChildren: vi.fn().mockRejectedValue(reset()),
      setTaskStatus: vi.fn(),
    };
    const result = await waitForTask(client, 'p/1', { timeoutMs: 20 });
    expect(result.outcome).toBe('timeout');
    expect(client.listTaskChildren).toHaveBeenCalledOnce();
    expect(client.setTaskStatus).not.toHaveBeenCalled();
  });

  it('spends a clamped backoff without another read when timers wake early', async () => {
    // Linux timers can resolve a millisecond before Date.now() agrees; an
    // instant sleep is the extreme case, and reproduces it on every platform.
    vi.resetModules();
    vi.doMock('node:timers/promises', () => ({ setTimeout: async () => {} }));
    try {
      const { waitForTask: waitWithEarlyTimers } = await import('./craftbook-command.js');
      const client = {
        getTaskByRef: vi.fn().mockResolvedValue(task('active')),
        listTaskChildren: vi.fn().mockRejectedValue(reset()),
      };
      const result = await waitWithEarlyTimers(client, 'p/1', { timeoutMs: 20 });
      expect(result.outcome).toBe('timeout');
      expect(client.listTaskChildren).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('node:timers/promises');
      vi.resetModules();
    }
  });

  it('honors abort during an in-flight status read', async () => {
    const controller = new AbortController();
    const reason = new Error('Observer stopped');
    const client = {
      getTaskByRef: vi.fn(
        (_ref: string, signal?: AbortSignal) =>
          new Promise<Task>((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
          }),
      ),
      listTaskChildren: vi.fn(),
    };
    const pending = waitForTask(client, 'p/1', { timeoutMs: 5000, signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(client.getTaskByRef).toHaveBeenCalledOnce();
  });

  it('honors abort during retry backoff without starting another read', async () => {
    const controller = new AbortController();
    const reason = new Error('Observer stopped');
    const client = { getTaskByRef: vi.fn().mockRejectedValue(reset()), listTaskChildren: vi.fn() };
    const pending = waitForTask(client, 'p/1', { timeoutMs: 5000, signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await assertion;
    expect(client.getTaskByRef).toHaveBeenCalledOnce();
  });

  it('recovers a transport failure while reading a successful response body', async () => {
    const error = new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const client = {
      getTaskByRef: vi.fn().mockRejectedValueOnce(error).mockResolvedValue(task('complete')),
      listTaskChildren: vi.fn(),
    };
    expect((await waitForTask(client, 'p/1', { timeoutMs: 5000 })).outcome).toBe('complete');
    expect(client.getTaskByRef).toHaveBeenCalledTimes(2);
  });
});
