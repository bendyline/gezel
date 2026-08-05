import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTPUT_PANE_MAXIMIZED_EVENT,
  OUTPUT_PANE_RESTORE_EVENT,
} from './components/output-pane-maximize.js';
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

describe('Output pane titlebar restore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('appears only while the output pane is maximized and requests a restore', async () => {
    const restored = vi.fn();
    window.addEventListener(OUTPUT_PANE_RESTORE_EVENT, restored);
    render(<App />);

    expect(screen.queryByRole('button', { name: 'Restore output pane' })).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OUTPUT_PANE_MAXIMIZED_EVENT, { detail: { maximized: true } }),
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Restore output pane' }));
    expect(restored).toHaveBeenCalledOnce();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OUTPUT_PANE_MAXIMIZED_EVENT, { detail: { maximized: false } }),
      );
    });
    expect(screen.queryByRole('button', { name: 'Restore output pane' })).not.toBeInTheDocument();

    window.removeEventListener(OUTPUT_PANE_RESTORE_EVENT, restored);
  });
});

describe('AI engagement menu', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('gives every execution mode its own glyph and marks the active mode clearly', async () => {
    const user = userEvent.setup();
    render(<App />);

    const trigger = await screen.findByRole('button', {
      name: 'AI engagement: Proactive. Click to change.',
    });
    expect(trigger.querySelector('.app-engagement-mode-icon-proactive')).toBeInTheDocument();

    await user.click(trigger);

    const proactive = await screen.findByRole('menuitem', { name: /Proactive/ });
    expect(proactive.querySelector('.app-engagement-mode-icon-proactive')).toBeInTheDocument();
    expect(proactive.querySelector('.app-engagement-menu-check svg')).toBeInTheDocument();

    expect(
      screen
        .getByRole('menuitem', { name: /Tasks \+ Reactive/ })
        .querySelector('.app-engagement-mode-icon-scheduled'),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole('menuitem', { name: /Reactive only/ })
        .querySelector('.app-engagement-mode-icon-reactive'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /^Off/ }).querySelector('.app-engagement-mode-icon-off'),
    ).toBeInTheDocument();
  });
});

describe('Night Shift header status', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.getNightShiftStatus).mockResolvedValue({ active: false, source: null });
    vi.mocked(api.getNightShiftTasks).mockResolvedValue({
      background: [],
      active: [],
      upcoming: [],
    });
  });

  it('adds passing clouds only while a shift is running', async () => {
    vi.mocked(api.getNightShiftStatus).mockResolvedValue({ active: true, source: 'manual' });
    render(<App />);

    const trigger = await screen.findByRole('button', { name: 'Night Shift: on (manual)' });
    expect(trigger.querySelectorAll('.app-nightshift-cloud')).toHaveLength(2);
    expect(trigger.querySelector('.app-nightshift-moon')).toHaveClass('is-active');
  });

  it('keeps the resting moon still when Night Shift is off', async () => {
    render(<App />);

    const trigger = await screen.findByRole('button', { name: 'Night Shift: off' });
    expect(trigger.querySelector('.app-nightshift-cloud')).not.toBeInTheDocument();
    expect(trigger.querySelector('.app-nightshift-moon')).not.toHaveClass('is-active');
  });

  it('sets the start command into a raised key tray', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Night Shift: off' }));

    const action = await screen.findByRole('menuitem', { name: /Start night shift now/ });
    expect(action).toHaveClass('app-nightshift-action', 'gz-key', 'gz-key--stacked');
    expect(action.parentElement).toHaveClass('app-nightshift-action-tray', 'gz-tray');
  });

  it('sets the stop command into the same raised key tray', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getNightShiftStatus).mockResolvedValue({ active: true, source: 'manual' });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Night Shift: on (manual)' }));

    const action = await screen.findByRole('menuitem', { name: /Stop night shift/ });
    expect(action).toHaveClass('app-nightshift-action', 'gz-key', 'gz-key--stacked');
    expect(action.parentElement).toHaveClass('app-nightshift-action-tray', 'gz-tray');
  });

  it('lists live indexing as work instead of leaving it implicit', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getNightShiftStatus).mockResolvedValue({ active: true, source: 'manual' });
    vi.mocked(api.getNightShiftTasks).mockResolvedValue({
      background: [
        {
          id: 'index-enrichment',
          title: 'Workspace indexing',
          projectName: 'molen-internal',
          detail: 'Studying workspace files',
        },
      ],
      active: [],
      upcoming: [],
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Night Shift: on (manual)' }));

    expect(await screen.findByText('Workspace indexing')).toBeInTheDocument();
    expect(screen.getByText('molen-internal · Studying workspace files')).toBeInTheDocument();
    expect(screen.getByText('Working on')).toBeInTheDocument();
  });

  it('says plainly when an active shift has no real work in flight or queued', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getNightShiftStatus).mockResolvedValue({ active: true, source: 'manual' });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Night Shift: on (manual)' }));

    expect(await screen.findByText('No work is running or queued.')).toBeInTheDocument();
    expect(screen.queryByText('Up next')).not.toBeInTheDocument();
  });
});

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
