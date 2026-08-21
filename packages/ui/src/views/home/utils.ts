import type { MeesterStatusReport, Project } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { formatRelativeTime } from '../../relative-time.js';

/** The views HomeView can route to (matches App.tsx's nav handler). */
export type HomeNavView =
  | 'home'
  | 'gezels'
  | 'projects'
  | 'documents'
  | 'tasks'
  | 'scripts'
  | 'history'
  | 'settings';

/** A status chip in the greeting band: a colored dot + a short label. */
export interface HomeChip {
  dot: string;
  label: string;
}

/** Time-of-day greeting. There is no stored user name, so callers append none. */
export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * How long a meester status report stays on the headline before the
 * band decays back to the time-of-day greeting. Long enough to survive
 * a quiet day (runs only happen when projects change), short enough
 * that a days-old "your game is done!" never greets the user.
 */
export const STATUS_FRESH_MS = 36 * 60 * 60_000;

/** The report if it's still fresh enough to headline, else null. */
export function freshStatusReport(
  report: MeesterStatusReport | null | undefined,
  now: number = Date.now(),
): MeesterStatusReport | null {
  if (!report) return null;
  const age = now - Date.parse(report.generatedAt);
  return Number.isFinite(age) && age < STATUS_FRESH_MS ? report : null;
}

/** Compact relative time, e.g. "just now" · "18m ago" · "yesterday" · "2w ago". */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  return formatRelativeTime(iso, { now });
}

/**
 * Which project is "on the bench" right now:
 *   1. the most-recently-touched project tab that still exists, else
 *   2. the first non-`default` project, else
 *   3. `default` (or the first project, or the literal 'default').
 */
export function deriveActiveProjectId(config: ConfigResponse | null, projects: Project[]): string {
  const ids = new Set(projects.map((p) => p.id));
  const recentProjects = (config?.recentTabs ?? [])
    .filter((t) => t.kind === 'project')
    .slice()
    .sort((a, b) => b.at - a.at);
  for (const t of recentProjects) {
    if (t.kind === 'project' && ids.has(t.id)) return t.id;
  }
  const firstCustom = projects.find((p) => p.id !== 'default');
  if (firstCustom) return firstCustom.id;
  return projects[0]?.id ?? 'default';
}
