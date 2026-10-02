import type { ChatEventEnvelope } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* ({ signal }: { signal?: AbortSignal }) {
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    return undefined as unknown as ChatEventEnvelope;
  },
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');

describe('ChatTimelineView with nothing said yet', () => {
  const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    // jsdom lays nothing out; give the introduction a height to follow.
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 540,
    });
  });
  afterEach(() => {
    if (scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeight);
  });

  it('opens the introduction at its top instead of following it to the bottom', async () => {
    render(
      <ChatTimelineView
        scopeKey="home"
        activeSessionId={undefined}
        loadTimeline={async () => ({ hasMore: false, messages: [] })}
        streamUrl={() => 'https://example.invalid/events'}
        emptyContent={<h3>Hello, I am the meester</h3>}
      />,
    );
    await screen.findByText('Hello, I am the meester');
    expect(Element.prototype.scrollTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ top: 540 }),
    );
  });
});
