import type { MeesterStatusReport } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GreetingBand, type HomeGreetingTab } from './GreetingBand.js';
import { type StartupHandover, startupHandover } from './StartupReadingOverlay.js';
import { freshStatusReport, greetingForHour } from './utils.js';

const poppetjes = vi.hoisted(() => ({ show: false }));
vi.mock('../../components/useShowPoppetjes.js', () => ({
  useShowPoppetjes: () => poppetjes.show,
}));
vi.mock('./StatusReportPanel.js', () => ({
  StatusReportPanel: ({ report }: { report: MeesterStatusReport }) => (
    <div data-testid="status-report-panel">{report.report}</div>
  ),
}));
vi.mock('./IntroHandboekArticle.js', () => ({
  IntroHandboekArticle: () => (
    <div data-testid="home-intro-article">
      <button type="button">Open in Handboek →</button>
      <div role="radiogroup" aria-label="View as">
        <label>
          <input type="radio" name="intro-mode" checked readOnly />
          Read
        </label>
        <label>
          <input type="radio" name="intro-mode" readOnly />
          Watch
        </label>
      </div>
    </div>
  ),
}));

/** The greeting tab is named for the time of day the test happens to run. */
const GREETING = /^Good (morning|afternoon|evening)$/;

const REPORT: MeesterStatusReport = {
  headline: 'Your space war game is done! Click to play it!',
  cta: { label: 'Open the project', target: { kind: 'project', projectId: 'space-war' } },
  report: '## Space war\nAll levels ship.',
  generatedAt: new Date().toISOString(),
  trigger: 'auto',
  actions: [],
};

function startupCopy(): HTMLElement {
  const node = document.createElement('section');
  node.textContent = 'Startup copy';
  return node;
}

function StartupHarness({ node, handover }: { node: HTMLElement; handover: StartupHandover }) {
  const [reading, setReading] = useState(true);
  return (
    <GreetingBand
      chips={[{ dot: 'var(--sage)', label: '3 ready for you' }]}
      meesterName="Wren"
      meesterPoppetje={null}
      meesterIcon={null}
      meesterIconOverride={false}
      collapsed={false}
      onToggleCollapse={() => {}}
      tab="greeting"
      onTabChange={() => {}}
      startupReading={reading ? { tab: 'greeting', node, handover } : undefined}
      onLeaveStartupReading={() => setReading(false)}
    />
  );
}

const liveGreeting = () => screen.getByRole('tabpanel', { hidden: true });

function renderBand(overrides: Partial<Parameters<typeof GreetingBand>[0]> = {}) {
  return render(
    <GreetingBand
      chips={[]}
      meesterName="Wren"
      meesterPoppetje={null}
      meesterIcon={null}
      meesterIconOverride={false}
      collapsed={false}
      onToggleCollapse={() => {}}
      tab="greeting"
      onTabChange={() => {}}
      {...overrides}
    />,
  );
}

describe('GreetingBand', () => {
  it('falls back to the time-of-day greeting without a status report', () => {
    renderBand();
    const expected = `${greetingForHour(new Date().getHours())}.`;
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(expected);
    expect(screen.getByText('Tip of the day')).toBeVisible();
    expect(screen.queryByTestId('status-report-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Status report' })).toBeNull();
  });

  it('shows the meester headline and dispatches the CTA navigation on click', () => {
    const openTab = vi.fn();
    window.addEventListener('gezel:open-tab', openTab);
    try {
      renderBand({ statusReport: REPORT });
      const cta = screen.getByRole('button', {
        name: 'Your space war game is done! Click to play it!',
      });
      fireEvent.click(cta);
      expect(openTab).toHaveBeenCalledTimes(1);
      const detail = (openTab.mock.calls[0]?.[0] as CustomEvent).detail;
      expect(detail).toMatchObject({ kind: 'project', id: 'space-war', activate: true });
    } finally {
      window.removeEventListener('gezel:open-tab', openTab);
    }
  });

  it('names the greeting tab for the time of day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 10, 18, 0));
      renderBand();
      expect(screen.getByRole('tab', { name: 'Good evening' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Good morning' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the status report in the greeting tab instead of the tip when available', () => {
    renderBand({ statusReport: REPORT });
    expect(screen.getByRole('tabpanel', { name: GREETING })).toHaveTextContent('All levels ship.');
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Status report' })).not.toBeInTheDocument();
  });

  it('keeps tabs and actionable chips visible when collapsed, hiding the content', () => {
    renderBand({
      statusReport: REPORT,
      collapsed: true,
      nightReview: {
        windowKey: '2026-10-09',
        windowStart: '2026-10-09T22:00:00.000Z',
        windowEnd: '2026-10-10T06:00:00.000Z',
        tasksCompleted: [],
        reports: [],
        diffpacks: [],
      },
      makeSomething: <div>starter cards</div>,
      chips: [{ label: '1 waiting on you', dot: 'var(--ochre)', onClick: vi.fn() }],
    });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      greetingForHour(new Date().getHours()),
      'Night shift',
      'Make something',
      'Handboek',
    ]);
    expect(screen.getByRole('button', { name: '1 waiting on you' })).toBeVisible();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    expect(screen.queryByText('Tip of the day')).not.toBeInTheDocument();
    expect(screen.queryByText('starter cards')).not.toBeInTheDocument();
  });

  it('activates a different collapsed tab by keyboard', async () => {
    const onTabChange = vi.fn();
    renderBand({ collapsed: true, makeSomething: <div>starter cards</div>, onTabChange });
    screen.getByRole('tab', { name: GREETING }).focus();
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Make something' })).toHaveFocus();
    expect(onTabChange).toHaveBeenCalledWith('make');
  });

  // Radix selects a tab on mousedown, so by the click a newly chosen tab is
  // already the active one; deciding "was it open?" at click time would roll
  // every freshly chosen panel straight back up.
  it('rolls up the open tab when it is chosen again, and only that one', async () => {
    function StatefulBand() {
      const [tab, setTab] = useState<HomeGreetingTab>('greeting');
      const [collapsed, setCollapsed] = useState(false);
      return (
        <GreetingBand
          chips={[]}
          meesterName="Wren"
          meesterPoppetje={null}
          meesterIcon={null}
          meesterIconOverride={false}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          tab={tab}
          onTabChange={(next) => {
            setTab(next);
            setCollapsed(false);
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<StatefulBand />);
    const handboek = screen.getByRole('tab', { name: 'Handboek' });

    await user.click(handboek);
    expect(screen.getByTestId('home-intro-article')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse the greeting' })).toBeInTheDocument();

    await user.click(handboek);
    expect(screen.getByRole('button', { name: 'Expand the greeting' })).toBeInTheDocument();
    expect(handboek).toHaveAttribute('aria-expanded', 'false');

    await user.click(handboek);
    expect(screen.getByRole('button', { name: 'Collapse the greeting' })).toBeInTheDocument();

    handboek.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Expand the greeting' })).toBeInTheDocument();
  });

  it('shows the Handboek article with read and watch choices in the tour', () => {
    renderBand({ tab: 'tour' });
    expect(screen.getByTestId('home-intro-article')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in Handboek/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Read' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Watch' })).not.toBeChecked();
    expect(screen.queryByText('What a meester is')).not.toBeInTheDocument();
    expect(screen.queryByText(/off-disk/i)).not.toBeInTheDocument();
  });

  it('swaps the startup copy for the live panel at once when nothing changed', () => {
    const node = startupCopy();
    const { rerender } = render(<StartupHarness node={node} handover="wait" />);
    expect(node.isConnected).toBe(true);
    expect(liveGreeting()).toHaveAttribute('inert');

    rerender(<StartupHarness node={node} handover="same" />);
    // The copy is not React's: reusing its host for another element left it
    // on screen beside the live panel.
    expect(node.isConnected).toBe(false);
    expect(document.querySelector('.startup-reading-overlay-leaving')).toBeNull();
    expect(liveGreeting()).not.toHaveAttribute('inert');
    expect(document.querySelector('.home-workshop-chips')).toHaveTextContent(/^3 ready for you$/);
  });

  it('fades to the live panel when it has news', async () => {
    const node = startupCopy();
    render(<StartupHarness node={node} handover="changed" />);
    expect(document.querySelector('.startup-reading-overlay-leaving')).not.toBeNull();
    await waitFor(() => expect(node.isConnected).toBe(false));
  });

  it('waits for the person to finish a press in the copy', () => {
    const node = startupCopy();
    const { rerender } = render(<StartupHarness node={node} handover="wait" />);
    fireEvent.pointerDown(node);
    rerender(<StartupHarness node={node} handover="same" />);
    expect(node.isConnected).toBe(true);
    fireEvent.pointerUp(window);
    expect(node.isConnected).toBe(false);
  });

  it('gives the Handboek reader the full sheet instead of the meester figure', () => {
    poppetjes.show = true;
    try {
      const { unmount } = renderBand();
      expect(screen.getByText('- Meester')).toBeInTheDocument();
      expect(document.querySelector('.home-workshop-greeting-cols-fill')).toBeNull();
      unmount();

      renderBand({ tab: 'tour' });
      expect(screen.queryByText('- Meester')).not.toBeInTheDocument();
      expect(document.querySelector('.home-workshop-greeting-cols-fill')).not.toBeNull();
    } finally {
      poppetjes.show = false;
    }
  });
});

describe('startupHandover', () => {
  const saved = { headline: REPORT.headline, content: REPORT.report, at: REPORT.generatedAt };
  const verdict = (overrides: Partial<Parameters<typeof startupHandover>[0]>) =>
    startupHandover({
      tab: 'greeting',
      savedStatus: null,
      liveStatus: null,
      statusSettled: true,
      nightSettled: true,
      ...overrides,
    });

  it('waits for the live data the tab shows', () => {
    expect(verdict({ statusSettled: false })).toBe('wait');
    expect(verdict({ tab: 'night', nightSettled: false })).toBe('wait');
  });

  it('swaps silently when the greeting would read the same', () => {
    expect(verdict({})).toBe('same');
    expect(verdict({ savedStatus: saved, liveStatus: REPORT })).toBe('same');
    expect(verdict({ tab: 'tour' })).toBe('same');
  });

  it('fades when the live panel has news', () => {
    expect(verdict({ liveStatus: REPORT })).toBe('changed');
    expect(verdict({ savedStatus: saved })).toBe('changed');
    expect(verdict({ savedStatus: saved, liveStatus: { ...REPORT, headline: 'Newer' } })).toBe(
      'changed',
    );
    expect(verdict({ tab: 'night' })).toBe('changed');
  });
});

describe('freshStatusReport', () => {
  it('passes a fresh report through and decays a stale one', () => {
    const now = Date.parse('2026-07-18T12:00:00Z');
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60_000).toISOString();
    expect(freshStatusReport({ ...REPORT, generatedAt: at(2) }, now)?.headline).toBe(
      REPORT.headline,
    );
    expect(freshStatusReport({ ...REPORT, generatedAt: at(37) }, now)).toBeNull();
    expect(freshStatusReport(null, now)).toBeNull();
    expect(freshStatusReport({ ...REPORT, generatedAt: 'not-a-date' }, now)).toBeNull();
  });
});
