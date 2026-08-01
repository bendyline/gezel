import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from './test-utils/mockApi.js';

vi.mock('./api.js', () => ({
  api: createMockApi({
    allEventsUrl: vi.fn(() => 'http://127.0.0.1:0/api/chat/events'),
    authHeader: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
    getFetch: vi.fn(() => fetch),
  }),
}));
vi.mock('./components/BoekwachterPill.js', () => ({ BoekwachterPill: () => null }));
vi.mock('./components/ClaudeCliPoolPill.js', () => ({ ClaudeCliPoolPill: () => null }));
vi.mock('./components/EngineStatusPill.js', () => ({ EngineStatusPill: () => null }));
vi.mock('./components/GrantConsentDialog.js', () => ({ GrantConsentDialog: () => null }));
vi.mock('./components/ModelBundleControls.js', () => ({
  ModelBundleImportController: () => null,
}));
vi.mock('./components/NeedsInputPanel.js', () => ({ NeedsInputPanel: () => null }));
vi.mock('./components/QueueMeter.js', () => ({ QueueMeter: () => null }));
vi.mock('./components/Sidebar.js', () => ({ Sidebar: () => null }));
vi.mock('./components/TabContent.js', () => ({
  TabContent: ({ tab }: { tab: { kind: string; id?: string } }) => (
    <div>{`${tab.kind}:${tab.id ?? ''}`}</div>
  ),
}));
vi.mock('./components/TabErrorBoundary.js', () => ({
  TabErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/TitlebarSearch.js', () => ({ TitlebarSearch: () => null }));
vi.mock('./embedded/EmbeddedChat.js', () => ({ EmbeddedChat: () => null }));
vi.mock('./settings-nav.js', () => ({ requestSettingsSection: vi.fn() }));
vi.mock('./shared-chat-events.js', () => ({
  streamSharedAllChatEvents: async function* () {},
}));
vi.mock('./sidebar-side.js', () => ({ syncSidebarSideFromConfig: vi.fn() }));
vi.mock('./theme.js', () => ({ syncThemeFromConfig: vi.fn() }));
vi.mock('./views/HomeView.js', () => ({ HomeView: () => <div>Home view</div> }));

const { App } = await import('./App.js');
const { api } = await import('./api.js');

describe('App project deletion navigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns to Home when the selected project is deleted', async () => {
    window.localStorage.setItem(
      'gezel:nav:selection',
      JSON.stringify({ kind: 'project', id: 'p1', at: 0, order: 0 }),
    );
    render(<App />);
    expect(screen.getByText('project:p1')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('gezel:project-deleted', { detail: { projectId: 'p1' } }),
      );
    });

    expect(await screen.findByText('Home view')).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem('gezel:nav:selection')).toBeNull());
  });
});

describe('quota meter', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.getUsage).mockResolvedValue({
      lastUpdated: '2026-07-31T20:00:00.000Z',
      providers: {
        copilot: {
          quotaBuckets: [
            {
              name: 'premium_interactions',
              isUnlimited: false,
              limit: 1500,
              used: 1239,
              remaining: 261,
              remainingPercent: 17.4,
              overage: 0,
              resetDate: '2026-08-01T00:00:00.000Z',
            },
          ],
          todayTurns: 7,
          todayTokensIn: 0,
          todayTokensOut: 0,
          todayCost: 0,
          totalTurns: 7,
          totalTokensIn: 0,
          totalTokensOut: 0,
          totalCost: 0,
          lastUpdated: '2026-07-31T20:00:00.000Z',
        },
      },
    });
  });

  // Clicking used to jump straight to Settings, which buried the numbers
  // the tooltip already had. The stats now open in place; Settings stays
  // reachable from inside the dropdown.
  it('opens the stats dropdown on click without leaving the current view', async () => {
    render(<App />);
    const pill = await screen.findByRole('button', { name: /1239\/1500/ });

    // Tooltip is preserved — it's the only affordance a hovering mouse gets.
    expect(pill).toHaveAttribute('title', expect.stringContaining('Premium interactions'));
    expect(screen.queryByText('Remaining')).not.toBeInTheDocument();

    fireEvent.click(pill);

    expect(await screen.findByText('Premium interactions')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
    expect(screen.getByText('261')).toBeInTheDocument();
    expect(screen.getByText('1,239 / 1,500 (83%)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Provider settings' })).toBeInTheDocument();
    expect(pill).toHaveAttribute('aria-expanded', 'true');
    // Still on Home — the click no longer navigates.
    expect(screen.getByText('Home view')).toBeInTheDocument();

    fireEvent.click(pill);
    await waitFor(() => expect(screen.queryByText('Remaining')).not.toBeInTheDocument());
  });

  it('closes when another header popover opens', async () => {
    render(<App />);
    const pill = await screen.findByRole('button', { name: /1239\/1500/ });
    fireEvent.click(pill);
    expect(await screen.findByText('Remaining')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('gezel:close-header-popovers', { detail: { source: 'engine' } }),
      );
    });

    await waitFor(() => expect(screen.queryByText('Remaining')).not.toBeInTheDocument());
  });
});
