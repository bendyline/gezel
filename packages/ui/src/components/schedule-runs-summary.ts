import type { ScheduleNextRun, Task } from '@bendyline/gezel';

/**
 * Everything a schedule's runs view says, decided in one place: the stop at
 * the end of the route and the sentence beneath it. Times are named plainly
 * ("tonight at 10:00 PM"), never the machinery behind them — the half-hourly
 * check, the cron expression, or "the scheduled window".
 */

export interface ScheduleRunsSummary {
  /** The upcoming stop's small label above its name: a clock time, or empty. */
  nextClock: string;
  /** The upcoming stop's word beneath its name: "Tonight", "After this run". */
  nextWord: string;
  /** One or two sentences: the cadence, then when the next run starts. */
  line: string;
}

type HostFields = Pick<Task, 'nightShift'>;
type RunFields = Pick<Task, 'ref' | 'createdAt'>;

export function scheduleRunsSummary(opts: {
  host: HostFields;
  next: ScheduleNextRun;
  runs: readonly RunFields[];
  /** The Night Shift window open now or next due, when it has one. */
  nightWindow: { start: Date; end: Date } | null;
  now: Date;
}): ScheduleRunsSummary {
  const { host, next, runs, nightWindow, now } = opts;
  const cadence = cadenceSentence(host, nightWindow);
  const say = (nextWord: string, sentence: string, nextClock = '') => ({
    nextClock,
    nextWord,
    line: [cadence, sentence].filter(Boolean).join(' '),
  });

  switch (next.kind) {
    case 'at': {
      if (next.soon) {
        const within = next.at.getTime() - now.getTime() <= 60_000;
        return say(
          'Starting soon',
          within
            ? 'The Night Shift is on, so the next run starts any minute now.'
            : `The Night Shift is on, so the next run starts at ${clock(next.at)}.`,
          within ? '' : clock(next.at),
        );
      }
      return say(
        capitalize(dayWord(next.at, now)),
        `The next run starts ${dayWord(next.at, now)} at ${clock(next.at)}.`,
        clock(next.at),
      );
    }
    case 'after-run': {
      const run = runs.find((r) => r.ref === next.runRef);
      const which = run ? `The run from ${shortDate(new Date(run.createdAt))}` : 'The last run';
      return say(
        'After this run',
        `${which} is still going, so the next one starts after it finishes.`,
      );
    }
    case 'held':
      return say(
        'On hold',
        next.mode === 'off'
          ? 'Crew activity is Off, which pauses everything, so no new runs start.'
          : 'Crew activity is Chat only, which pauses task work, so no new runs start until you choose Tasks + chat or Proactive.',
      );
    case 'paused':
      return say('Paused', 'This schedule is paused. Set it to Active to start runs again.');
    case 'not-started':
      return say('Not started', 'This schedule has not started yet.');
    case 'stopped':
      return say(
        next.status === 'complete' ? 'Complete' : 'Canceled',
        next.status === 'complete'
          ? 'This schedule is complete and starts no more runs.'
          : 'This schedule was canceled and starts no more runs.',
      );
    case 'no-night-shift':
      return say(
        'Not scheduled',
        'The Night Shift is turned off, so this never starts on its own. Turn on Enable Night Shift in Settings → Night Shift, or use Run now.',
      );
    case 'unknown':
      return say('Scheduled', '');
  }
}

function cadenceSentence(host: HostFields, window: { start: Date; end: Date } | null): string {
  if (host.nightShift?.enabled !== true) return 'Runs on a repeating schedule.';
  const often = host.nightShift.onceADay === true ? 'once a night' : 'through the night';
  if (!window || window.start.getHours() === window.end.getHours()) {
    return `Runs ${often} during the Night Shift.`;
  }
  return `Runs ${often} during the Night Shift, ${clock(window.start)} to ${clock(window.end)}.`;
}

/** "tonight", "today", "tomorrow", "on Wednesday", or "on Nov 20". */
export function dayWord(at: Date, now: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(now)) / 86_400_000);
  if (days <= 0) return at.getHours() >= 17 ? 'tonight' : 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `on ${at.toLocaleDateString(undefined, { weekday: 'long' })}`;
  return `on ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** Local wall-clock time: "10:00 PM". */
export function clock(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Sun, Nov 9". */
export function shortDate(at: Date): string {
  return at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function capitalize(text: string): string {
  // "on Wednesday" reads as a badge without its preposition.
  const bare = text.startsWith('on ') ? text.slice(3) : text;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}
