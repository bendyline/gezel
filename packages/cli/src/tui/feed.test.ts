import type { ChatEventEnvelope } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  MAX_FEED_ROW_CHARS,
  type TurnMap,
  appendShellChunk,
  finalizeShellRun,
  reduceFeed,
  reduceTurns,
  sessionToFeedRows,
} from './feed.js';

describe('reduceTurns live status', () => {
  const envelope = (event: ChatEventEnvelope['event']): ChatEventEnvelope => ({
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'default',
    event,
  });

  it('shows an approximate live token count while output streams', () => {
    let turns: TurnMap = new Map();
    turns = reduceTurns(
      turns,
      envelope({
        type: 'user_message',
        message: { role: 'user', content: 'Write it', at: '2026-08-14T12:00:00.000Z' },
      }),
    );
    turns = reduceTurns(turns, envelope({ type: 'delta', content: '12345678901234567890' }));
    turns = reduceTurns(turns, envelope({ type: 'reasoning_delta', content: '12345678' }));

    expect(turns.get('s1')).toMatchObject({
      label: 'generating · ~7 tokens',
      outputChars: 28,
    });
  });

  it('shows the concrete tool name as soon as its arguments start streaming', () => {
    let turns: TurnMap = new Map();
    turns = reduceTurns(
      turns,
      envelope({ type: 'tool_args_delta', name: 'write_artifact', content: '{"path":' }),
    );
    turns = reduceTurns(
      turns,
      envelope({ type: 'tool_args_delta', name: '', content: '"report.md"}' }),
    );

    expect(turns.get('s1')).toMatchObject({
      label: 'running tool · write_artifact · ~5 tokens',
      activeToolName: 'write_artifact',
    });
  });

  it('keeps the concrete tool name on the completed tool event', () => {
    const turns = reduceTurns(
      new Map(),
      envelope({
        type: 'tool',
        name: 'write_artifact',
        durationMs: 12,
        success: true,
      }),
    );

    expect(turns.get('s1')?.label).toBe('running tool · write_artifact');
  });
});

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
        gezelId: 'reviewer',
      },
    };

    expect(reduceFeed([], event)).toEqual([
      expect.objectContaining({
        sessionId: 'local',
        kind: 'note',
        text: 'task · Task default/4 → complete',
        taskEvent: { kind: 'task.status.changed', gezelId: 'reviewer' },
      }),
    ]);
  });
});

describe('reduceFeed thinking', () => {
  const envelope = (event: ChatEventEnvelope['event']): ChatEventEnvelope => ({
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'default',
    event,
  });

  it('can keep reasoning hidden explicitly', () => {
    expect(
      reduceFeed([], envelope({ type: 'reasoning_delta', content: 'private thought' }), {
        showThinking: false,
      }),
    ).toEqual([]);
  });

  it('streams reasoning into one row and closes it before the visible answer', () => {
    let rows = reduceFeed([], envelope({ type: 'reasoning_delta', content: 'Inspect ' }), {
      showThinking: true,
    });
    rows = reduceFeed(rows, envelope({ type: 'reasoning_delta', content: 'the workspace.' }), {
      showThinking: true,
    });
    rows = reduceFeed(rows, envelope({ type: 'delta', content: 'I built it.' }), {
      showThinking: true,
    });

    expect(rows.map((row) => [row.kind, row.text, row.open])).toEqual([
      ['thinking', 'Inspect the workspace.', false],
      ['assistant', 'I built it.', true],
    ]);
  });

  it('bounds retained streamed text after it exceeds the render limit', () => {
    let rows = reduceFeed(
      [],
      envelope({ type: 'reasoning_delta', content: 'x'.repeat(MAX_FEED_ROW_CHARS) }),
      { showThinking: true },
    );
    rows = reduceFeed(
      rows,
      envelope({ type: 'reasoning_delta', content: 'overflow'.repeat(1_000) }),
      { showThinking: true },
    );
    const capped = rows[0]?.text;
    rows = reduceFeed(rows, envelope({ type: 'reasoning_delta', content: 'more overflow' }), {
      showThinking: true,
    });

    expect(capped).toHaveLength(MAX_FEED_ROW_CHARS + 1);
    expect(rows[0]?.text).toBe(capped);
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
  const envelope = (event: ChatEventEnvelope['event']): ChatEventEnvelope => ({
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'default',
    event,
  });

  it('keeps write bodies hidden by default', () => {
    const rows = reduceFeed(
      [],
      envelope({
        type: 'tool_args_delta',
        name: 'write_file',
        content: '{"path":"index.html","content":"<main>hidden</main>"}',
      }),
    );

    expect(rows).toEqual([]);
  });

  it('streams only the selected write body when enabled', () => {
    let rows = reduceFeed(
      [],
      envelope({
        type: 'tool_args_delta',
        name: 'write_file',
        content: '{"path":"index.html","content":"<main>',
      }),
      { showWrites: true },
    );
    rows = reduceFeed(
      rows,
      envelope({ type: 'tool_args_delta', name: '', content: 'Snake</main>"}' }),
      { showWrites: true },
    );
    rows = reduceFeed(
      rows,
      envelope({ type: 'tool', name: 'write_file', durationMs: 12, success: true }),
      { showWrites: true },
    );

    expect(rows.map((row) => [row.kind, row.text, row.open])).toEqual([
      ['write', '<main>Snake</main>', false],
      ['tool', '🔧 write_file', false],
    ]);
    expect(rows.map((row) => row.text).join('\n')).not.toContain('index.html');
  });

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
          reasoning: 'I should verify the report before replying.',
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
      ['thinking', 'I should verify the report before replying.'],
      ['tool', '🔧 write_file'],
      ['tool', '🔧 read_file · Read docs/plan.md'],
      ['assistant', 'The report is ready.'],
    ]);
    expect(rows.every((row) => row.sessionId === 'session-2')).toBe(true);

    const rowsWithoutThinking = sessionToFeedRows(
      {
        id: 'session-2',
        gezelId: 'meester',
        messages: [
          {
            role: 'assistant',
            content: 'The report is ready.',
            at: '2026-08-08T12:01:00.000Z',
            reasoning: 'I should verify the report before replying.',
          },
        ],
      },
      { showThinking: false },
    );
    expect(rowsWithoutThinking.map((row) => [row.kind, row.text])).toEqual([
      ['assistant', 'The report is ready.'],
    ]);
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

  it('does not retain a runaway terminal stream beyond the render limit', () => {
    let rows = appendShellChunk([], 'run-large', 'x'.repeat(MAX_FEED_ROW_CHARS));
    rows = appendShellChunk(rows, 'run-large', 'y'.repeat(MAX_FEED_ROW_CHARS));
    const capped = rows[0]?.text;
    rows = appendShellChunk(rows, 'run-large', 'ignored');

    expect(capped).toHaveLength(MAX_FEED_ROW_CHARS + 1);
    expect(rows[0]?.text).toBe(capped);
  });
});
