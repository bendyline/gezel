import { type Project, isSharedLibraryProject, isUserCreatedProject } from '@bendyline/gezel';
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
  /** Makes the chip a small-radius button (see docs/ux.md, Corners). */
  onClick?: () => void;
  /** What the click does, for the tooltip and screen readers. */
  actionLabel?: string;
}

export { greetingForHour, freshStatusReport, isFreshStatus, STATUS_FRESH_MS } from './greeting.js';

/** Compact relative time, e.g. "just now" · "18m ago" · "yesterday" · "2w ago". */
export function timeAgo(iso: string | undefined, now: number = Date.now()): string {
  return formatRelativeTime(iso, { now });
}

/** New work uses the last project visited, or Default before one is chosen. */
export function deriveLaunchProjectId(config: ConfigResponse | null, projects: Project[]): string {
  const ids = new Set(projects.filter((p) => !isSharedLibraryProject(p)).map((p) => p.id));
  const recent = (config?.recentTabs ?? []).slice().sort((a, b) => b.at - a.at);
  for (const tab of recent) {
    if (tab.kind === 'project' && ids.has(tab.id)) return tab.id;
  }
  return 'default';
}

/**
 * Which project is "on the bench" right now:
 *   1. the most-recently-touched visible project tab that still exists, else
 *   2. the first user-created project, else
 *   3. `default` (or the first visible project, or the literal 'default').
 */
export function deriveActiveProjectId(config: ConfigResponse | null, projects: Project[]): string {
  const visibleProjects = projects.filter((p) => !isSharedLibraryProject(p));
  const ids = new Set(visibleProjects.map((p) => p.id));
  const recentProjects = (config?.recentTabs ?? [])
    .filter((t) => t.kind === 'project')
    .slice()
    .sort((a, b) => b.at - a.at);
  for (const t of recentProjects) {
    if (t.kind === 'project' && ids.has(t.id)) return t.id;
  }
  const firstCustom = visibleProjects.find(isUserCreatedProject);
  if (firstCustom) return firstCustom.id;
  return visibleProjects.find((p) => p.id === 'default')?.id ?? visibleProjects[0]?.id ?? 'default';
}
