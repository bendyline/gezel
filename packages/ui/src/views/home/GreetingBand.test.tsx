import type { MeesterStatusReport } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('offers a Status report tab and renders the report panel when selected', () => {
    const onTabChange = vi.fn();
    renderBand({ statusReport: REPORT, onTabChange });
    fireEvent.click(screen.getByRole('tab', { name: 'Status report' }));
    expect(onTabChange).toHaveBeenCalledWith('status');

    renderBand({ statusReport: REPORT, tab: 'status' });
    expect(screen.getByTestId('status-report-panel')).toHaveTextContent('All levels ship.');
  });

  it('shows the status headline in the collapsed row too', () => {
    renderBand({ statusReport: REPORT, collapsed: true });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Your space war game is done!',
    );
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
