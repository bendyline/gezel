import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import type { ChatComposerProps } from './ChatComposer.js';
import { PageChat } from './PageChat.js';

const composer = vi.hoisted(() => vi.fn());
vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
vi.mock('./ChatComposer.js', () => ({
  ChatComposer: (props: ChatComposerProps) => {
    composer(props);
    return (
      <button type="button" onClick={() => props.onSessionCreated?.('created')}>
        Send to {props.gezelId}
      </button>
    );
  },
}));
vi.mock('./ProjectTimeline.js', () => ({
  ProjectTimeline: ({
    gezelId,
    activeSessionId,
  }: { gezelId: string; activeSessionId?: string }) => (
    <span>
      Timeline {gezelId} {activeSessionId}
    </span>
  ),
}));
vi.mock('./SessionSwitcher.js', () => ({ SessionSwitcher: () => <span>Threads</span> }));

describe('native page chat', () => {
  beforeEach(() => {
    vi.mocked(api.getProject).mockResolvedValue({
      id: 'board',
      name: 'Board',
      voormanGezelId: 'mira',
      gezelIds: ['mira', 'ada'],
    } as never);
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'mira', name: 'Mira', role: 'Opponent' },
        { id: 'ada', name: 'Ada', role: 'Coach' },
        { id: 'outside', name: 'Outside' },
      ],
    } as never);
  });
  it('resolves a project role, keeps sessions when changing layout, and resets them on recipient changes', async () => {
    const { rerender } = render(
      <PageChat projectId="board" options={{ gezelRole: 'Opponent', showAddress: false }} />,
    );
    await screen.findByText('Send to mira');
    expect(composer.mock.lastCall?.[0]).toMatchObject({
      gezelId: 'mira',
      projectId: 'board',
      showAddress: false,
      features: { mentions: false, attachments: false },
    });
    fireEvent.click(screen.getByText('Send to mira'));
    expect(screen.getByText('Timeline mira created')).toBeInTheDocument();
    rerender(
      <PageChat projectId="board" options={{ gezelRole: 'Opponent', variant: 'composer' }} />,
    );
    expect(screen.queryByText(/Timeline/)).not.toBeInTheDocument();
    expect(composer.mock.lastCall?.[0].sessionId).toBe('created');
    rerender(<PageChat projectId="board" options={{ gezelRole: 'Coach' }} />);
    await waitFor(() =>
      expect(composer.mock.lastCall?.[0]).toMatchObject({ gezelId: 'ada', sessionId: undefined }),
    );
  });
  it('never substitutes another recipient when a requested crew member is absent', async () => {
    render(<PageChat projectId="board" options={{ gezelId: 'outside' }} />);
    expect(await screen.findByText(/not in this project/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
