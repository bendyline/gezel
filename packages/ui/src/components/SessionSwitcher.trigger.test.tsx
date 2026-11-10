import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

// The real Select, not the test double: what the trigger shows is Radix's
// own business (it copies the selected row's text unless told otherwise).
vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../shared-chat-events.js', () => ({
  // A stream that never delivers.
  streamSharedProjectChatEvents: async function* () {
    await new Promise(() => {});
  },
}));

const { SessionSwitcher } = await import('./SessionSwitcher.js');
const { resetComposerDrafts } = await import('./composer-drafts.js');
const { api } = await import('../api.js');

const starter = {
  id: '2026-11-09-0001',
  projectId: 'default',
  gezelId: 'malika',
  sessionId: null,
  createdAt: '2026-11-09T12:00:00.000Z',
  updatedAt: new Date().toISOString(),
  status: 'draft',
  title: 'Plan a trip to Kyoto',
  hasFiles: false,
  fileCount: 0,
};

describe('SessionSwitcher trigger', () => {
  beforeEach(() => {
    resetComposerDrafts();
    vi.mocked(api.listPromptDrafts).mockResolvedValue({ drafts: [starter] } as never);
  });

  // A welcome starter fills the composer before anything is sent. The
  // trigger read "Plan a trip to Kyoto… · just now", a thread the person
  // never had; the message still opens a new one.
  it('names a new thread while an unsent starter is in the box', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({ sessions: [] } as never);
    render(
      <SessionSwitcher
        gezelId="malika"
        projectId="default"
        sessionId={undefined}
        activeDraftId={starter.id}
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
        autoPickNewest={false}
      />,
    );
    await waitFor(() => expect(api.listPromptDrafts).toHaveBeenCalled());
    const trigger = screen.getByRole('combobox', { name: 'Conversation' });
    await waitFor(() => expect(trigger).toHaveTextContent('New thread'));
    expect(trigger).not.toHaveTextContent('Kyoto');
    expect(trigger).not.toHaveTextContent(/ago|just now/);
  });

  it('still names the thread the composer posts into', async () => {
    vi.mocked(api.listChatSessions).mockResolvedValue({
      sessions: [
        {
          id: 's1',
          gezelId: 'malika',
          projectId: 'default',
          title: 'Spring menu',
          createdAt: '2026-11-09T11:00:00.000Z',
          lastActivityAt: '2026-11-09T11:00:00.000Z',
          providerName: 'mock',
          archived: false,
        },
      ],
    } as never);
    render(
      <SessionSwitcher
        gezelId="malika"
        projectId="default"
        sessionId="s1"
        onSessionIdChange={vi.fn()}
        onDraftSelect={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Conversation' });
    await waitFor(() => expect(trigger).toHaveTextContent('Spring menu'));
  });
});
