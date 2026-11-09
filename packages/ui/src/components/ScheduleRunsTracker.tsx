import {
  type AIEngagementMode,
  type GezelSummary,
  type NightShiftStatusResponse,
  type Task,
  type TaskAssignee,
  displayName,
  plainRoleTitle,
  scheduleNextRun,
  taskEffectiveStatus,
} from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { Poppetje } from '../poppetje/index.js';
import { type StepMeta, type StepStatus, StepTracker } from './StepTracker.js';
import { clock, scheduleRunsSummary, shortDate } from './schedule-runs-summary.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';
import { useShowPoppetjes } from './useShowPoppetjes.js';

/** Older runs stay in the full list on the Task tab. */
const MAX_RUNS_SHOWN = 12;
const NEXT_STOP_ID = '__next-run';

interface Stop {
  id: string;
  name: string;
  run?: Task;
  ordinal?: number;
}

const PAUSE_GLYPH = (
  <svg viewBox="0 0 24 24" fill="currentColor" className="step-stop-glyph" aria-hidden="true">
    <rect x="7" y="6" width="3.5" height="12" rx="1" />
    <rect x="13.5" y="6" width="3.5" height="12" rx="1" />
  </svg>
);

const CLOCK_GLYPH = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className="step-stop-glyph"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

function runStatus(run: Task): StepStatus {
  const status = taskEffectiveStatus(run);
  if (status === 'complete') return 'done';
  if (status === 'active') return 'active';
  return 'pending';
}

/** Who holds the run now: its current step's gezel, else the run's own assignee. */
function runHolder(run: Task): TaskAssignee {
  const step = run.craftbook.steps.find((s) => s.id === run.activeStepId);
  return (
    step?.assignee ??
    (step?.suggestedGezelId ? { kind: 'gezel', gezelId: step.suggestedGezelId } : run.assignee)
  );
}

function runWord(run: Task, nightShiftActive: boolean | undefined): string {
  const status = taskEffectiveStatus(run);
  const steps = run.craftbook.steps;
  const at = steps.findIndex((s) => s.id === run.activeStepId);
  const position = at >= 0 && steps.length > 1 ? ` at step ${at + 1} of ${steps.length}` : '';
  switch (status) {
    case 'complete':
      return 'Finished';
    case 'canceled':
      return 'Canceled';
    case 'paused':
      return `Paused${position}`;
    case 'draft':
      return 'Not started';
    case 'active':
      // Night work is held until a shift is running; say so rather than
      // implying the crew is on it now.
      if (run.nightShift?.enabled === true && nightShiftActive === false) {
        return 'Waits for the Night Shift';
      }
      return at >= 0 && steps.length > 1 ? `Step ${at + 1} of ${steps.length}` : 'Working';
  }
}

function useMinuteClock(fixed?: number): Date {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [fixed]);
  return new Date(fixed ?? now);
}

/**
 * The bench for a schedule host. A schedule never works its own placeholder
 * step, so the route shows what matters instead: its runs, oldest to newest,
 * each opening that run, and a dashed stop for the next one with when it
 * starts. The sentence beneath says the cadence and why the next run starts
 * when it does.
 */
export function ScheduleRunsTracker({
  host,
  runs,
  gezels,
  nightShift,
  engagementMode,
  busy = false,
  onOpenRun,
  onRunNow,
  now: fixedNow,
}: {
  host: Task;
  /** The host's runs, in any order. */
  runs: Task[];
  gezels: GezelSummary[];
  /** Null until loaded, or on a host without background work. */
  nightShift: NightShiftStatusResponse | null;
  engagementMode?: AIEngagementMode;
  busy?: boolean;
  onOpenRun: (ref: string) => void;
  /** Omit where runs cannot be started from here. */
  onRunNow?: () => void;
  /** Injected in tests. */
  now?: number;
}) {
  const now = useMinuteClock(fixedNow);
  const showFigures = useShowPoppetjes();
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();

  const ordered = useMemo(
    () => [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs],
  );
  const shown = ordered.slice(-MAX_RUNS_SHOWN);
  const earlier = ordered.length - shown.length;

  const nightWindow = nightShift?.window
    ? {
        start: new Date(nightShift.window.start),
        end: new Date(nightShift.window.end),
        open: nightShift.window.open,
      }
    : null;
  const next = scheduleNextRun(host, ordered, {
    now,
    nightWindow,
    ...(engagementMode ? { engagementMode } : {}),
  });
  const summary = scheduleRunsSummary({ host, next, runs: ordered, nightWindow, now });
  // Until a night host's Night Shift status arrives, a missing window would
  // read as "the Night Shift is turned off": say nothing about the next run yet.
  const statusKnown = nightShift !== null || host.nightShift?.enabled !== true;
  const stopped = next.kind === 'stopped';

  const stops: Stop[] = [
    ...shown.map((run, i) => ({
      id: run.ref,
      name: shortDate(new Date(run.createdAt)),
      run,
      ordinal: earlier + i + 1,
    })),
    ...(stopped || !statusKnown ? [] : [{ id: NEXT_STOP_ID, name: 'Next run' }]),
  ];

  const stopOf = (stop: Stop): StepMeta => {
    const run = stop.run;
    if (!run) {
      return {
        upcoming: true,
        glyph: CLOCK_GLYPH,
        numLabel: summary.nextClock,
        statusWord: summary.nextWord,
        title: `Next run: ${summary.nextWord}`,
      };
    }
    const status = taskEffectiveStatus(run);
    const holder = runHolder(run);
    const gezel = holder.kind === 'gezel' ? gezels.find((g) => g.id === holder.gezelId) : undefined;
    const name =
      holder.kind === 'user'
        ? 'You'
        : gezel
          ? displayName(gezel, roleBasedNameOnlyMode)
          : undefined;
    const role = roleBasedNameOnlyMode || !gezel?.role ? undefined : plainRoleTitle(gezel.role);
    const word = runWord(run, nightShift?.active);
    const started = new Date(run.createdAt);
    return {
      ...(name ? { assigneeName: name } : {}),
      ...(role ? { assigneeRole: role } : {}),
      ...(status === 'active' && showFigures && gezel?.poppetje
        ? {
            figure: (
              <Poppetje
                poppetje={gezel.poppetje}
                variant="headshot"
                size={32}
                svgId={`run-${run.num}`}
                {...(name ? { title: name } : {})}
              />
            ),
          }
        : {}),
      ...(status === 'paused' ? { glyph: PAUSE_GLYPH } : {}),
      ...(status === 'canceled' ? { glyph: '✕' } : {}),
      numLabel: clock(started),
      statusWord: word,
      title: `Run ${stop.ordinal} from ${shortDate(started)} at ${clock(started)}: ${word}. Open it.`,
    };
  };

  return (
    <div className="schedule-runs">
      <StepTracker
        variant="bench"
        stepRole="button"
        steps={stops}
        selectedStepId={null}
        onSelect={(id) => {
          if (id !== NEXT_STOP_ID) onOpenRun(id);
        }}
        statusOf={(stop) => (stop.run ? runStatus(stop.run) : 'pending')}
        stepOf={stopOf}
        busy={busy}
        ariaLabel="Runs of this schedule"
        centerStepId={stops.at(-1)?.id ?? null}
        {...(stopped
          ? {
              terminal: {
                word: summary.nextWord,
                tone:
                  next.kind === 'stopped' && next.status === 'complete' ? 'complete' : 'canceled',
              },
            }
          : {})}
      />
      <div className="schedule-runs-readout">
        <p>
          {ordered.length === 0 ? 'No runs yet. ' : ''}
          {earlier > 0
            ? `Showing the latest ${shown.length} of ${ordered.length} runs; the rest are listed on the Task tab. `
            : ''}
          {statusKnown ? summary.line : ''}
        </p>
        {onRunNow && !stopped && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onRunNow}
            title="Start one run of this plan now, without waiting for the schedule"
          >
            Run now
          </button>
        )}
      </div>
    </div>
  );
}
