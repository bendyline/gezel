import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import * as primitivesMock from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { SessionSwitcher } = await import('./SessionSwitcher.js');
const { api } = await import('../api.js');

function mockSessions(sessions: unknown[]) {
  vi.mocked(api.listChatSessions).mockResolvedValue({ sessions } as never);
}

describe('SessionSwitcher', () => {
  it('scopes the empty state to the gezel when a name is provided', async () => {
    mockSessions([]);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        gezelName="Metehan"
        onSessionIdChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText('No threads with Metehan yet — a message starts one'),
      ).toBeInTheDocument();
    });
  });

  it('falls back to the generic empty label without a name', async () => {
    mockSessions([]);
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        onSessionIdChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('No threads yet')).toBeInTheDocument();
    });
  });

  it('auto-picks the most recent thread when the scope has sessions', async () => {
    mockSessions([
      {
        id: 's-new',
        gezelId: 'g1',
        title: 'Landing page plan',
        lastActivityAt: new Date().toISOString(),
        providerName: 'mock',
        archived: false,
      },
      {
        id: 's-old',
        gezelId: 'g1',
        title: 'Older thread',
        lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
        providerName: 'mock',
        archived: false,
      },
    ]);
    const onSessionIdChange = vi.fn();
    render(
      <SessionSwitcher
        gezelId="g1"
        projectId="p1"
        sessionId={undefined}
        gezelName="Ada Lovelace"
        onSessionIdChange={onSessionIdChange}
      />,
    );
    await waitFor(() => {
      expect(onSessionIdChange).toHaveBeenCalledWith('s-new');
    });
    expect(screen.getByText(/Landing page plan/)).toBeInTheDocument();
  });
});
