import type { NightShiftStatusResponse, Task } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { clock } from './schedule-runs-summary.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ScheduleRunsTracker } = await import('./ScheduleRunsTracker.js');
const { api } = await import('../api.js');

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

const STEPS = ['Scope', 'Audit', 'Report', 'Evaluate', 'Finish'].map((name, i) => ({
  id: `s${i + 1}`,
  name,
  createdAt: '2026-10-01T00:00:00Z',
}));

function task(num: number, overrides: Partial<Task> = {}): Task {
  return {
    projectId: 'squisq',
    num,
    ref: `squisq/${num}`,
    title: 'Night shift: Test Coverage Review',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'ayza' },
    craftbook: {
      id: 'cb',
      name: 'cb',
      steps: STEPS,
      entryStepId: 's1',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    },
    activeStepId: 's1',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  } as Task;
}

/** squisq/18 on the morning of Nov 9: last night's run is still on step 1. */
const HOST = task(18, {
  craftbook: {
    id: 'host',
    name: 'host',
    steps: [{ id: 'wait', name: 'Wait for schedule', createdAt: '2026-10-01T00:00:00Z' }],
    entryStepId: 'wait',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  activeStepId: 'wait',
  cron: { expression: '*/30 * * * *', overlap: 'skip' },
  nightShift: { enabled: true, onceADay: true, lastRunDay: '2026-11-08' },
  spawnsCraftbook: {
    id: 'test-coverage-review',
    name: 'Test Coverage Review',
    steps: STEPS,
    entryStepId: 's1',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
});
const RUNS = [
  task(37, { createdAt: at(9, 5, 53).toISOString(), nightShift: { enabled: true } }),
  task(22, { status: 'paused', createdAt: at(1, 0, 43).toISOString() }),
];
const OFF_SHIFT: NightShiftStatusResponse = {
  active: false,
  source: null,
  window: { start: at(9, 22).toISOString(), end: at(10, 6).toISOString(), open: false },
};

function renderTracker(props: Partial<Parameters<typeof ScheduleRunsTracker>[0]> = {}) {
  const onOpenRun = vi.fn();
  const onRunNow = vi.fn();
  render(
    <ScheduleRunsTracker
      host={HOST}
      runs={RUNS}
      gezels={[]}
      nightShift={OFF_SHIFT}
      engagementMode="proactive"
      onOpenRun={onOpenRun}
      onRunNow={onRunNow}
      now={at(9, 15).getTime()}
      {...props}
    />,
  );
  return { onOpenRun, onRunNow };
}

describe('ScheduleRunsTracker', () => {
  beforeEach(() => {
    vi.mocked(api.getConfig).mockResolvedValue({
      provider: 'llama-cpp',
      roleBasedNameOnlyMode: false,
      showPoppetjes: false,
    } as ConfigResponse);
  });

  it('shows the runs oldest first, then the next one, in place of the placeholder step', () => {
    renderTracker();
    const route = screen.getByRole('group', { name: 'Runs of this schedule' });
    const stops = Array.from(route.querySelectorAll('[data-step-id]')).map(
      (el) => (el as HTMLElement).dataset.stepId,
    );
    expect(stops).toEqual(['squisq/22', 'squisq/37', '__next-run']);
    expect(screen.queryByText('Wait for schedule')).toBeNull();
    expect(screen.getByText('Paused at step 1 of 5')).toBeInTheDocument();
    // Night work waits for a shift to be running, so it does not claim a step.
    expect(screen.getByText('Waits for the Night Shift')).toBeInTheDocument();
    expect(screen.getByText('After this run')).toBeInTheDocument();
    expect(
      screen.getByText(/is still going, so the next one starts after it finishes\./),
    ).toBeInTheDocument();
  });

  it('opens a run from its stop and starts one from Run now', async () => {
    const user = userEvent.setup();
    const { onOpenRun, onRunNow } = renderTracker();
    await user.click(screen.getAllByRole('button', { name: /^Run 2 from/ })[0]!);
    expect(onOpenRun).toHaveBeenCalledWith('squisq/37');
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(onRunNow).toHaveBeenCalledOnce();
    // The next run is a promise, not a control: neither its stop nor its caption opens anything.
    const next = screen.getAllByRole('button', { name: /^Next run/ });
    expect(next.length).toBeGreaterThan(0);
    for (const control of next) expect(control).toBeDisabled();
  });

  it('names tonight once nothing is running', () => {
    renderTracker({ runs: [RUNS[1]!] });
    expect(screen.getByText('Tonight')).toBeInTheDocument();
    expect(screen.getByText(clock(at(9, 22)))).toBeInTheDocument();
    expect(screen.getByText(/The next run starts tonight at/)).toBeInTheDocument();
  });

  it('says nothing about the next run until the Night Shift status arrives', () => {
    renderTracker({ nightShift: null });
    expect(screen.queryByText(/Night Shift is turned off/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Next run/ })).toBeNull();
  });
});
