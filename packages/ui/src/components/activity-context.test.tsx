import type { ActivityStatusResponse } from '@bendyline/gezel';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../shared-chat-events.js', () => ({ streamSharedAllChatEvents: async function* () {} }));
const { api } = await import('../api.js');
const { ActivityProvider, useActivitySelector } = await import('./activity-context.js');

function snapshot(at: string, needsYou: number): ActivityStatusResponse {
  return {
    at,
    questions: [],
    items: Array.from({ length: needsYou }, (_, index) => ({
      id: `item-${index}`,
      section: 'needs-you' as const,
      title: 'Waiting',
      detail: '',
      projectId: 'shop',
      questionIds: [],
    })),
    queues: {
      at,
      providers: {},
      sessions: [],
      cache: [],
      taskRunner: { pendingCount: 0, pendingByGezel: {}, pendingByProject: {} },
    },
  };
}

async function poll() {
  act(() => window.dispatchEvent(new Event('gezel:config-changed')));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
}

describe('activity store', () => {
  it('redraws a consumer only when the slice it selects changes', async () => {
    let renders = 0;
    function Badge() {
      renders++;
      const count = useActivitySelector(
        (state) => state?.snapshot?.items.filter((item) => item.section === 'needs-you').length,
      );
      return <span data-testid="badge">{count ?? '-'}</span>;
    }
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot('2026-11-11T10:00:00Z', 1));
    render(
      <ActivityProvider>
        <Badge />
      </ActivityProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('badge').textContent).toBe('1'));
    const settled = renders;

    // A poll that brings new timestamps but the same count: no redraw.
    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot('2026-11-11T10:00:05Z', 1));
    await poll();
    await poll();
    expect(renders).toBe(settled);

    vi.mocked(api.getActivityStatus).mockResolvedValue(snapshot('2026-11-11T10:00:10Z', 2));
    await poll();
    expect(screen.getByTestId('badge').textContent).toBe('2');
    expect(renders).toBe(settled + 1);
  });

  it('gives a selector null outside the provider', () => {
    function Probe() {
      const state = useActivitySelector((s) => s);
      return <span data-testid="probe">{state === null ? 'none' : 'some'}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });
});
