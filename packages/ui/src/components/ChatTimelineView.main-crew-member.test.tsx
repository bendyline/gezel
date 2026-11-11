import type { ChatEventEnvelope, ListTimelineResponse } from '@bendyline/gezel';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));
vi.mock('./GezelIcon.js', () => ({
  GezelIcon: ({ name }: { name: string }) => <span data-testid="gezel-icon">{name}</span>,
}));
vi.mock('../shared-chat-events.js', () => ({
  streamSharedProjectChatEvents: async function* ({ signal }: { signal?: AbortSignal }) {
    await new Promise<void>((resolve) =>
      signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    return undefined as unknown as ChatEventEnvelope;
  },
}));

const { ChatTimelineView } = await import('./ChatTimelineView.js');
const { api } = await import('../api.js');

function reply(gezelId: string, projectId: string, at: string) {
  return {
    sessionId: `s-${gezelId}`,
    gezelId,
    projectId,
    sessionTitle: 'Menu',
    sessionCreatedAt: at,
    sessionLastActivityAt: at,
    sessionProviderName: 'copilot' as const,
    role: 'assistant' as const,
    content: `Reply from ${gezelId}`,
    at,
  };
}

const speakers = () => [...document.querySelectorAll('.msg-role .person-label-name')];

/** The mark beside a speaker's name in their bubble header, if any. */
const star = (name: string) =>
  speakers()
    .find((el) => el.textContent === name)
    ?.closest('.msg-role')
    ?.querySelector('.msg-role-glyph')?.textContent;

describe('ChatTimelineView: the star beside a speaker', () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'minji', name: 'Minji', role: 'Builder' },
        { id: 'dejan', name: 'Dejan', role: 'Crew Lead' },
      ],
    } as never);
  });

  // The star was tied to the Crew Lead role, so a Builder running a project
  // alone got none (2026-11-10).
  it('marks the main crew member of the project being spoken in, not a role', async () => {
    vi.mocked(api.listProjects).mockResolvedValue({
      projects: [{ id: 'menu', name: 'Spring menu', mode: 'solo', voormanGezelId: 'minji' }],
    } as never);
    const timeline: ListTimelineResponse = {
      hasMore: false,
      messages: [
        reply('minji', 'menu', '2026-11-10T10:00:00.000Z'),
        reply('dejan', 'menu', '2026-11-10T10:01:00.000Z'),
      ],
    };
    render(
      <ChatTimelineView
        scopeKey="menu"
        activeSessionId="s-minji"
        loadTimeline={async () => timeline}
        streamUrl={() => 'https://example.invalid/events'}
      />,
    );
    await waitFor(() => expect(speakers()).toHaveLength(2));
    await waitFor(() => expect(star('Minji')).toBe('⭐'));
    // A crew lead by role, but not the one this project is assigned to.
    expect(star('Dejan')).toBeUndefined();
  });

  it('reads the projects again when a message names one made since', async () => {
    vi.mocked(api.listProjects)
      .mockResolvedValueOnce({ projects: [{ id: 'default', name: 'Default' }] } as never)
      .mockResolvedValue({
        projects: [
          { id: 'default', name: 'Default' },
          { id: 'menu', name: 'Spring menu', mode: 'solo', voormanGezelId: 'minji' },
        ],
      } as never);
    const timeline: ListTimelineResponse = {
      hasMore: false,
      messages: [reply('minji', 'menu', '2026-11-10T10:00:00.000Z')],
    };
    render(
      <ChatTimelineView
        scopeKey="home"
        activeSessionId="s-minji"
        loadTimeline={async () => timeline}
        streamUrl={() => 'https://example.invalid/events'}
      />,
    );
    await waitFor(() => expect(star('Minji')).toBe('⭐'));
    expect(vi.mocked(api.listProjects)).toHaveBeenCalledTimes(2);
  });
});
