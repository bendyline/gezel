import type { ListTimelineResponse, TimelineMessage, ToolCallCard } from '@bendyline/gezel';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* () {},
  streamSharedAllChatEvents: async function* () {},
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function card(reused: boolean): ToolCallCard {
  return {
    kind: 'craftbook-start',
    craftbookId: 'report-pdf',
    craftbookName: 'Formatted Report',
    taskRef: 'bakery/2',
    projectId: 'bakery',
    status: 'active',
    activeStepId: 'outline',
    steps: [{ id: 'outline', name: 'Outline the report', status: 'active' }],
    ...(reused ? { reused: true } : {}),
  };
}

function invoke(reused: boolean) {
  return { name: 'invoke_craftbook', durationMs: 300, success: true, card: card(reused) };
}

const BASE = {
  sessionId: 'dejan-thread',
  gezelId: 'dejan',
  projectId: 'bakery',
  sessionTitle: 'Invoice',
  sessionCreatedAt: '2026-10-23T14:45:00.000Z',
  sessionLastActivityAt: '2026-10-23T14:49:00.000Z',
  sessionProviderName: 'mock',
};

// The bakery request: Dejan called invoke_craftbook three times in one
// turn and the conversation showed three identical cards in a row.
const MESSAGES = [
  {
    ...BASE,
    role: 'user',
    content: 'Can you make the actual invoice for Corner Coffee Co as a PDF?',
    at: '2026-10-23T14:45:44.000Z',
  },
  {
    ...BASE,
    role: 'assistant',
    content: 'On it! The invoice is underway.',
    at: '2026-10-23T14:49:19.000Z',
    toolCalls: [invoke(false), invoke(true), invoke(true)],
  },
] as TimelineMessage[];

function renderTimeline() {
  return render(
    <ChatTimelineView
      scopeKey="project:bakery"
      activeSessionId={undefined}
      loadTimeline={async () => ({ messages: MESSAGES, hasMore: false }) as ListTimelineResponse}
      streamUrl={() => 'https://example.invalid/events'}
    />,
  );
}

describe('ChatTimelineView — one craftbook card per task', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [{ id: 'dejan', name: 'Dejan', role: 'Kantoormeester' }],
    } as never);
  });

  it('shows the first card and keeps the repeats behind Details', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock' } as never);
    const { container } = renderTimeline();
    await screen.findByText('On it! The invoice is underway.');
    await waitFor(() => expect(container.querySelectorAll('.msg-tool-card')).toHaveLength(1));
    expect(screen.queryByText('Craftbook already running')).not.toBeInTheDocument();
  });

  it('shows every card in debug mode', async () => {
    vi.mocked(api.getConfig).mockResolvedValue({ provider: 'mock', debugMode: true } as never);
    const { container } = renderTimeline();
    await screen.findByText('On it! The invoice is underway.');
    await waitFor(() => expect(container.querySelectorAll('.msg-tool-card')).toHaveLength(3));
  });
});
