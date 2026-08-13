import type { ChatEventEnvelope } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { appendShellChunk, finalizeShellRun, reduceFeed, sessionToFeedRows } from './feed.js';

describe('reduceFeed task events', () => {
  it('renders a project task update as a system feed row', () => {
    const event: ChatEventEnvelope = {
      sessionId: '',
      gezelId: '',
      projectId: 'default',
      event: {
        type: 'task_event',
        eventId: 'event-1',
        kind: 'task.status.changed',
        summary: 'Task default/4 → complete',
        at: '2026-08-08T12:00:00.000Z',
        taskRef: 'default/4',
      },
    };

    expect(reduceFeed([], event)).toEqual([
      expect.objectContaining({
        sessionId: 'local',
        kind: 'note',
        text: 'task · Task default/4 → complete',
      }),
    ]);
  });
});

describe('reduceFeed queued messages', () => {
  const envelope = (event: ChatEventEnvelope['event']): ChatEventEnvelope => ({
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'default',
    event,
  });

  it('shows a queued message immediately and upserts its preview', () => {
    const queued = reduceFeed(
      [],
      envelope({
        type: 'queue_enqueued',
        queueId: 'q1',
        preview: 'please also check the tests',
        enqueuedAt: '2026-08-13T12:00:00.000Z',
        nudge: true,
      }),
    );
    const updated = reduceFeed(
      queued,
      envelope({
        type: 'queue_enqueued',
        queueId: 'q1',
        preview: 'please check the tests and docs',
        enqueuedAt: '2026-08-13T12:00:00.000Z',
        nudge: true,
      }),
    );

    expect(updated).toEqual([
      expect.objectContaining({
        key: 'queue-q1',
        sessionId: 's1',
        kind: 'pending',
        text: 'please check the tests and docs',
      }),
    ]);
  });

  it('removes the pending row when the queued message starts or is discarded', () => {
    const queued = reduceFeed(
      [],
      envelope({
        type: 'queue_enqueued',
        queueId: 'q1',
        preview: 'follow up',
        enqueuedAt: '2026-08-13T12:00:00.000Z',
      }),
    );

    expect(
      reduceFeed(queued, envelope({ type: 'queue_removed', queueId: 'q1', reason: 'started' })),
    ).toEqual([]);
  });
});

describe('reduceFeed tool events', () => {
  it('shows the server-built args summary on the tool row', () => {
    const event: ChatEventEnvelope = {
      sessionId: 's1',
      gezelId: 'g1',
      projectId: 'default',
      event: {
        type: 'tool',
        name: 'read_file',
        durationMs: 12,
        success: true,
        path: 'docs/secrets-security.md',
        argsSummary: 'Read docs/secrets-security.md',
      },
    };

    expect(reduceFeed([], event)).toEqual([
      expect.objectContaining({
        kind: 'tool',
        text: '🔧 read_file · Read docs/secrets-security.md',
      }),
    ]);
  });

  it('falls back to the touched path and surfaces failures', () => {
    const event: ChatEventEnvelope = {
      sessionId: 's1',
      gezelId: 'g1',
      projectId: 'default',
      event: {
        type: 'tool',
        name: 'write_file',
        durationMs: 12,
        success: false,
        path: 'workspace/index.html',
        errorMessage: 'permission denied',
      },
    };

    expect(reduceFeed([], event)).toEqual([
      expect.objectContaining({
        kind: 'tool',
        text: '🔧 write_file · workspace/index.html · failed: permission denied',
      }),
    ]);
  });
});

describe('sessionToFeedRows', () => {
  it('hydrates visible messages and persisted tool calls for a selected thread', () => {
    const rows = sessionToFeedRows({
      id: 'session-2',
      gezelId: 'meester',
      messages: [
        { role: 'user', content: 'Where are we?', at: '2026-08-08T12:00:00.000Z' },
        {
          role: 'assistant',
          content: 'The report is ready.',
          at: '2026-08-08T12:01:00.000Z',
          toolCalls: [
            { name: 'write_file', durationMs: 20, success: true },
            {
              name: 'read_file',
              durationMs: 5,
              success: true,
              argsSummary: 'Read docs/plan.md',
            },
          ],
        },
        {
          role: 'assistant',
          content: 'hidden seed',
          at: '2026-08-08T12:02:00.000Z',
          hidden: true,
        },
      ],
    });

    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ['user', 'Where are we?'],
      ['tool', '🔧 write_file'],
      ['tool', '🔧 read_file · Read docs/plan.md'],
      ['assistant', 'The report is ready.'],
    ]);
    expect(rows.every((row) => row.sessionId === 'session-2')).toBe(true);
  });
});

describe('shell feed rows', () => {
  it('keeps streamed terminal output in a dedicated shell row', () => {
    const rows = appendShellChunk([], 'run-1', 'alpha  beta\ngamma delta\n');

    expect(rows).toEqual([
      expect.objectContaining({
        key: 'term-run-1',
        sessionId: 'term-run-1',
        kind: 'shell',
        text: 'alpha  beta\ngamma delta\n',
        open: true,
      }),
    ]);
  });

  it('preserves the shell row when the exit footer is appended', () => {
    const rows = finalizeShellRun(appendShellChunk([], 'run-2', 'done\n'), 'run-2', {
      id: 'message-1',
      kind: 'output',
      content: 'done',
      at: '2026-08-08T12:00:00.000Z',
      exitCode: 0,
      durationMs: 12,
    });

    expect(rows[0]).toMatchObject({
      kind: 'shell',
      text: 'done\n[exit 0 · 0.0s]',
      open: false,
    });
  });
});
