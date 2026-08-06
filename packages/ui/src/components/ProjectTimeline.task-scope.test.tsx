import type { ChatEventEnvelope, ListTimelineResponse, TimelineMessage } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

const stream = vi.hoisted(() => {
  const pending: ChatEventEnvelope[] = [];
  let wake: (() => void) | null = null;
  return {
    push(env: ChatEventEnvelope) {
      pending.push(env);
      wake?.();
      wake = null;
    },
    reset() {
      pending.length = 0;
      wake = null;
    },
    async *consume(): AsyncGenerator<ChatEventEnvelope> {
      while (true) {
        while (pending.length > 0) yield pending.shift() as ChatEventEnvelope;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
});

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: () => stream.consume(),
}));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ProjectTimeline } = await import('./ProjectTimeline.js');
const { api } = await import('../api.js');

function message(overrides: Partial<TimelineMessage>): TimelineMessage {
  return {
    sessionId: 'task-session',
    gezelId: 'tomas',
    projectId: 'molen-internal',
    sessionTitle: 'API Contract Review',
    sessionCreatedAt: '2026-07-25T10:00:00.000Z',
    sessionLastActivityAt: '2026-07-25T10:00:00.000Z',
    sessionProviderName: 'mock',
    taskRef: 'molen-internal/1',
    role: 'user',
    content: 'scope the contract review',
    at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  } as TimelineMessage;
}

function envelope(sessionId: string, content: string): ChatEventEnvelope {
  return {
    sessionId,
    gezelId: 'tomas',
    projectId: 'molen-internal',
    event: {
      type: 'user_message',
      message: { role: 'user', content, at: '2026-07-25T11:00:00.000Z' },
    },
  } as ChatEventEnvelope;
}

describe('ProjectTimeline — task scoping', () => {
  beforeEach(() => {
    stream.reset();
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listProjectTimeline).mockResolvedValue({
      messages: [message({})],
      hasMore: false,
    } as ListTimelineResponse);
    vi.mocked(api.listTaskSessions).mockResolvedValue({
      sessions: [{ id: 'task-session', gezelId: 'tomas', archived: false }],
    } as never);
  });

  it('asks the service for only this task’s sessions', async () => {
    render(
      <ProjectTimeline
        projectId="molen-internal"
        taskRef="molen-internal/1"
        activeSessionId={undefined}
      />,
    );
    await screen.findByText('scope the contract review');
    expect(api.listProjectTimeline).toHaveBeenCalledWith(
      'molen-internal',
      expect.objectContaining({ taskRef: 'molen-internal/1' }),
    );
  });

  it('omits the task filter when no taskRef is given', async () => {
    render(<ProjectTimeline projectId="molen-internal" activeSessionId={undefined} />);
    await screen.findByText('scope the contract review');
    const opts = vi.mocked(api.listProjectTimeline).mock.calls[0]?.[1] ?? {};
    expect(opts).not.toHaveProperty('taskRef');
  });

  it('drops live events from sessions outside the task', async () => {
    render(
      <ProjectTimeline
        projectId="molen-internal"
        taskRef="molen-internal/1"
        activeSessionId={undefined}
      />,
    );
    await screen.findByText('scope the contract review');
    // Wait for the allowlist fetch to land before streaming, so the
    // assertion tests the guard rather than a race with it.
    await waitFor(() => expect(api.listTaskSessions).toHaveBeenCalled());

    stream.push(envelope('unrelated-session', 'general project check-in'));
    stream.push(envelope('task-session', 'reviewing the endpoints now'));

    await screen.findByText('reviewing the endpoints now');
    expect(screen.queryByText('general project check-in')).toBeNull();
  });

  it('lets every session through when unscoped', async () => {
    render(<ProjectTimeline projectId="molen-internal" activeSessionId={undefined} />);
    await screen.findByText('scope the contract review');

    stream.push(envelope('unrelated-session', 'general project check-in'));
    await screen.findByText('general project check-in');
  });
});
