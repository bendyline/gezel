import type { MeesterStatusReport } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GreetingBand } from './GreetingBand.js';
import { freshStatusReport, greetingForHour } from './utils.js';

vi.mock('../../components/useShowPoppetjes.js', () => ({
  useShowPoppetjes: () => false,
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

const REPORT: MeesterStatusReport = {
  headline: 'Your space war game is done! Click to play it!',
  cta: { label: 'Open the project', target: { kind: 'project', projectId: 'space-war' } },
  report: '## Space war\nAll levels ship.',
  generatedAt: new Date().toISOString(),
  trigger: 'auto',
  actions: [],
};

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

  it('shows the status report in Good morning instead of the tip when available', () => {
    renderBand({ statusReport: REPORT });
    expect(screen.getByRole('tabpanel', { name: 'Good morning' })).toHaveTextContent(
      'All levels ship.',
    );
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
      'Good morning',
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
    screen.getByRole('tab', { name: 'Good morning' }).focus();
    await userEvent.setup().keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Make something' })).toHaveFocus();
    expect(onTabChange).toHaveBeenCalledWith('make');
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
