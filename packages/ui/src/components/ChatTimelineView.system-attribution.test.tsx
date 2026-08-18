import type { TimelineMessage } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon" data-name={name} />,
}));

const { ChatStickyHeader } = await import('./ChatTimelineView.js');

function message(overrides: Partial<TimelineMessage>): TimelineMessage {
  return {
    sessionId: 's1',
    gezelId: 'g1',
    projectId: 'p1',
    sessionTitle: 'Task default/1',
    sessionCreatedAt: '2026-08-04T05:00:00.000Z',
    sessionLastActivityAt: '2026-08-04T05:01:00.000Z',
    sessionProviderName: 'mock',
    role: 'user',
    content: 'do the thing',
    at: '2026-08-04T05:00:00.000Z',
    ...overrides,
  } as TimelineMessage;
}

function renderSticky(userMsg: TimelineMessage) {
  return render(
    <ChatStickyHeader
      payload={{
        userMsg,
        assistantInfo: {
          kind: 'message',
          msg: message({ role: 'assistant', content: 'on it', at: '2026-08-04T05:00:30.000Z' }),
        },
      }}
      gezels={new Map()}
    />,
  );
}

/**
 * The sticky context header is the second surface that names a message's
 * author, so it has to reach the same verdict as the bubble — otherwise
 * scrolling a task thread flips the attribution from System back to YOU.
 */
describe('ChatStickyHeader author attribution', () => {
  it('names the machinery when the pinned message is a dispatch seed', () => {
    renderSticky(
      message({
        origin: 'system',
        content: 'The previous step has been completed and handed step `oversight` to you.',
      }),
    );
    expect(screen.getByText('SYSTEM')).toBeInTheDocument();
    expect(screen.queryByText('YOU')).toBeNull();
  });

  it('still names the user for a message they actually typed', () => {
    renderSticky(message({ content: 'ship it' }));
    expect(screen.getByText('YOU')).toBeInTheDocument();
    expect(screen.queryByText('SYSTEM')).toBeNull();
  });
});
