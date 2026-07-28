// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ChatComposer } from './ChatComposer.js';

vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'light' }));
vi.mock('./useRoleBasedNameOnlyMode.js', () => ({ useRoleBasedNameOnlyMode: () => false }));
vi.mock('./GezelIcon.js', () => ({ GezelIcon: () => <span /> }));
vi.mock('./GezelMediaProvider.js', () => ({
  createGezelMediaProvider: () => ({ dispose: vi.fn() }),
}));
vi.mock('@bendyline/squisq-editor-react', () => ({
  EditorShell: ({ toolbarSlotRight }: { toolbarSlotRight?: React.ReactNode }) => (
    <div>{toolbarSlotRight}</div>
  ),
}));

describe('ChatComposer server-authoritative cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatSessionInflight).mockResolvedValue({
      inflight: {
        userText: 'Create the deck',
        startedAt: Date.now() - 5_000,
        elapsedMs: 5_000,
      },
    });
    vi.mocked(api.cancelChatSessionTurn).mockResolvedValue({ cancelled: true });
  });

  it('shows Stop for a turn that is running on the service after a remount', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    expect(await screen.findByRole('button', { name: /stop/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^send$/i })).toBeNull();
  });

  it('Escape cancels the service turn, not just the local event stream', async () => {
    render(
      <ChatComposer gezelId="tomas" gezelName="Tomas" projectId="default" sessionId="session-1" />,
    );

    await screen.findByRole('button', { name: /stop/i });
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(api.cancelChatSessionTurn).toHaveBeenCalledWith('session-1');
    });
  });
});
