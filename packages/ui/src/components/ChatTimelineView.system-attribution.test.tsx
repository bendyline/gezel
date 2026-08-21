import type { GezelSummary, TimelineMessage } from '@bendyline/gezel';
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

function renderSticky(userMsg: TimelineMessage, gezels?: Map<string, GezelSummary>) {
  return render(
    <ChatStickyHeader
      payload={{
        userMsg,
        assistantInfo: {
          kind: 'message',
          msg: message({ role: 'assistant', content: 'on it', at: '2026-08-04T05:00:30.000Z' }),
        },
      }}
      gezels={gezels ?? new Map()}
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

  /**
   * A dispatch seed the card parser recognises gets the same condensed line
   * the bubble shows. The old header pinned the raw paragraph, which the
   * one-line clamp cut mid-word ("Follow the step instructions already in
   * your prompt — m…") under a SYSTEM tag.
   */
  it('condenses a recognised hand-off to its one sentence', () => {
    renderSticky(
      message({
        origin: 'system',
        content:
          'Liesel has handed step `review` of task default/11 to you. Follow the step instructions already in your prompt — make the first tool call they name this turn.',
      }),
      new Map([['g1', { id: 'g1', name: 'Koray' } as GezelSummary]]),
    );

    expect(screen.getByText('HAND-OFF')).toBeInTheDocument();
    expect(screen.getByText('Liesel passed the review step to Koray.')).toBeInTheDocument();
    expect(screen.queryByText('YOU')).toBeNull();
  });

  it('still names the user for a message they actually typed', () => {
    renderSticky(message({ content: 'ship it' }));
    expect(screen.getByText('YOU')).toBeInTheDocument();
    expect(screen.queryByText('SYSTEM')).toBeNull();
  });
});
