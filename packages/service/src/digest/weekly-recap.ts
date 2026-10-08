import type { HistoryEvent, NightShiftQuietReason, Project } from '@bendyline/gezel';
import { createLogger, describeQuietNight, isSharedLibraryProject } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { isoWeek } from './generator.js';

const log = createLogger('digest');

const DAY_MS = 24 * 60 * 60_000;

export interface WeeklyRecapDeps {
  store: Pick<
    Store,
    'listProjects' | 'readProjectArtifact' | 'writeProjectArtifact' | 'getProject'
  >;
  history: {
    listEvents(filter: {
      kinds?: Array<HistoryEvent['kind']>;
      from?: string;
      to?: string;
    }): Promise<HistoryEvent[]>;
  };
}

export interface WeeklyRecap {
  week: string;
  /** Artifacts path in the Default project. */
  path: string;
}

/**
 * The week in one page, written the first morning of a new ISO week: how
 * many nights the crew worked and what they left, why the quiet nights were
 * quiet, and a link to each project's weekly digest. Model-free — it reads
 * the `night-shift.window-settled` records and the digests already on disk —
 * and written once: an existing recap for the week is left alone.
 */
export async function writeWeeklyRecap(
  deps: WeeklyRecapDeps,
  now: Date,
): Promise<WeeklyRecap | null> {
  const lastWeek = new Date(now.getTime() - 7 * DAY_MS);
  const week = isoWeek(lastWeek);
  if (week === isoWeek(now)) return null;
  const path = `reports/weekly-recap-${week}.md`;
  if ((await deps.store.readProjectArtifact('default', path).catch(() => null)) !== null) {
    return null;
  }
  const { from, to } = isoWeekBounds(lastWeek);
  const nights = await deps.history
    .listEvents({
      kinds: ['night-shift.window-settled'],
      from: from.toISOString(),
      to: to.toISOString(),
    })
    .catch(() => [] as HistoryEvent[]);
  const projects = (await deps.store.listProjects().catch(() => [] as Project[])).filter(
    (p) => p.id !== 'default' && !isSharedLibraryProject(p),
  );
  const digests: Array<{ project: Project; path: string }> = [];
  for (const project of projects) {
    const digestPath = `reports/digest-${week}.md`;
    const body = await deps.store.readProjectArtifact(project.id, digestPath).catch(() => null);
    if (body !== null) digests.push({ project, path: digestPath });
  }
  if (nights.length === 0 && digests.length === 0) return null;

  await deps.store.writeProjectArtifact('default', path, renderRecap(week, nights, digests));
  log.info(`[digest] weekly recap ${week} written (${nights.length} night(s))`);
  return { week, path };
}

/** Monday 00:00 to the next Monday 00:00 (local) of the ISO week containing `date`. */
export function isoWeekBounds(date: Date): { from: Date; to: Date } {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to };
}

export function renderRecap(
  week: string,
  nights: HistoryEvent[],
  digests: Array<{ project: Project; path: string }>,
): string {
  const n = (key: string) =>
    nights.reduce((sum, e) => {
      const value = (e.details as Record<string, unknown> | undefined)?.[key];
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);
  const worked = nights.filter((e) => (e.details as { ran?: boolean } | undefined)?.ran === true);
  const quiet = new Map<string, number>();
  for (const e of nights) {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    const ran = (e.details as { ran?: boolean } | undefined)?.ran === true;
    if (!ran && reason) quiet.set(reason, (quiet.get(reason) ?? 0) + 1);
  }

  const lines = [`# Your crew's week · ${week}`, ''];
  lines.push(
    `The night shift worked ${plural(worked.length, 'night')} of ${plural(nights.length, 'recorded night')}.`,
  );
  const made = [
    n('tasksCompleted') > 0 ? `${plural(n('tasksCompleted'), 'task')} finished` : '',
    n('reports') > 0 ? `${plural(n('reports'), 'report')} written` : '',
    n('proposals') > 0 ? `${plural(n('proposals'), 'change proposal')} drafted` : '',
  ].filter(Boolean);
  if (made.length > 0) lines.push('', `Over the week: ${made.join(', ')}.`);
  if (quiet.size > 0) {
    lines.push('', '## Quiet nights', '');
    for (const [reason, count] of quiet) {
      lines.push(
        `- ${plural(count, 'night')}: ${describeQuietNight(reason as NightShiftQuietReason)}`,
      );
    }
  }
  if (digests.length > 0) {
    lines.push('', '## Each folder this week', '');
    for (const d of digests) {
      lines.push(`- **${d.project.name}**: \`${d.path}\` in its artifacts`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : `${word}s`}`;
}
