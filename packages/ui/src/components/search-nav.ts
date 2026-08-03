import type { UnifiedSearchResult, UnifiedSearchResultKind } from '@bendyline/gezel';
import { type NavAction, openTabAction as openTab } from './nav-actions.js';
import type { OpenFileIntent } from './pending-open-file.js';
import type { OpenSessionIntent } from './pending-open-session.js';

/** Fixed display order + labels for the result groups in the palette. */
const GROUP_ORDER: Array<{ kind: UnifiedSearchResultKind; label: string }> = [
  { kind: 'project', label: 'Projects' },
  { kind: 'gezel', label: 'Gezellen' },
  { kind: 'file', label: 'Files' },
  { kind: 'document', label: 'Documents' },
  { kind: 'content', label: 'Content' },
  { kind: 'symbol', label: 'Symbols' },
  { kind: 'session', label: 'Threads' },
  { kind: 'memory', label: 'Memories' },
];

export interface SearchGroup {
  kind: UnifiedSearchResultKind;
  label: string;
  items: UnifiedSearchResult[];
}

/** Bucket merged results into fixed-order, non-empty display groups. */
export function groupResults(results: UnifiedSearchResult[]): SearchGroup[] {
  return GROUP_ORDER.map((g) => ({
    ...g,
    items: results.filter((r) => r.kind === g.kind),
  })).filter((g) => g.items.length > 0);
}

/** The visual top-to-bottom order — the flat list keyboard nav indexes into. */
export function flattenGroups(groups: SearchGroup[]): UnifiedSearchResult[] {
  return groups.flatMap((g) => g.items);
}

/**
 * Pure mapping from a unified-search result to the navigation actions the
 * titlebar search should perform when the user picks it. Kept side-effect-free
 * so it can be unit-tested without rendering: `runNavActions` interprets each
 * action (queue a file intent / dispatch a window CustomEvent).
 */
export function resultToActions(r: UnifiedSearchResult): NavAction[] {
  switch (r.kind) {
    case 'project':
      return r.projectId ? [openTab({ kind: 'project', id: r.projectId })] : [];
    case 'gezel': {
      const gezelId = r.id.slice('gezel:'.length);
      return gezelId ? [openTab({ kind: 'gezel', id: gezelId })] : [];
    }
    case 'document':
      return r.path ? [openTab({ kind: 'document', path: r.path })] : [];
    case 'file':
    case 'content':
    case 'symbol':
      if (r.projectId && r.path && r.source) {
        const intent: OpenFileIntent = {
          projectId: r.projectId,
          path: r.path,
          source: r.source,
        };
        return [
          // Queue first so the freshly-remounted ProjectsView can consume it.
          { kind: 'open-file', intent },
          openTab({ kind: 'project', id: r.projectId }),
          // Live event for the already-open-project case (no remount).
          { kind: 'event', type: 'gezel:open-file', detail: intent },
        ];
      }
      return r.projectId ? [openTab({ kind: 'project', id: r.projectId })] : [];
    case 'session': {
      if (!r.gezelId) return [];
      const intent: OpenSessionIntent = {
        gezelId: r.gezelId,
        sessionId: r.id.slice('session:'.length),
        ...(r.projectId ? { projectId: r.projectId } : {}),
      };
      return [
        // Queue first so the freshly-mounted gezel view can consume it;
        // the live event covers the already-open case (no remount).
        { kind: 'open-session', intent },
        openTab({ kind: 'gezel', id: r.gezelId }),
        { kind: 'event', type: 'gezel:open-session', detail: intent },
      ];
    }
    case 'memory': {
      if (r.projectId) return [openTab({ kind: 'project', id: r.projectId })];
      const prefix = 'memory:gezel:';
      if (r.id.startsWith(prefix)) {
        const gezelId = r.id.slice(prefix.length).split(':')[0];
        if (gezelId) return [openTab({ kind: 'gezel', id: gezelId })];
      }
      return [];
    }
  }
}
