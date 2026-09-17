import type { Task } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import {
  parseCraftbookParams,
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
    expect(parseCraftbookParams(book, ['c23n', 'limit=2', 'dryRun=true'])).toEqual({
      region: 'c23n',
      limit: '2',
      dryRun: 'true',
    });
    expect(parseCraftbookParams(book, ['c23'])).toEqual({ region: 'c23' });
  });
  it.each([
    ['c23n', 'region=c2'],
    ['c23n', 'unknown=1'],
    ['c23n', 'limit=0'],
    ['c23n', 'limit=NaN'],
    ['c23n', 'limit=1.5'],
    ['c23n', 'dryRun=yes'],
    ['invalid'],
    [],
  ])('rejects invalid input %j', (...args) => {
    expect(() => parseCraftbookParams(book, args)).toThrow();
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
    client.getTaskByRef.mockResolvedValue({
      ...task('active'),
      craftbook: { cliWorkflow: { module: '.gezel/workflows/batch.mjs' } },
    });
    expect((await waitForTask(client, 'p/1', { timeoutMs: 100 })).outcome).toBe('blocked');
  });
  it('times out without canceling the daemon task', async () => {
    const client = {
      getTaskByRef: vi.fn().mockResolvedValue(task('active')),
      listTaskChildren: vi.fn(),
    };
    expect((await waitForTask(client, 'p/1', { timeoutMs: 1, pollMs: 2 })).exitCode).toBe(3);
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
