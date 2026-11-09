import { type RecentTab, parseTaskRef } from '@bendyline/gezel';
import { NAVIGATION_AREA_LABELS } from '../PrimaryNavigation.js';
import type { ViewEntry } from './view-history.js';

/** A name for a place whose view has not named it yet (or never loaded). */
export function fallbackTitle(selection: RecentTab | null): string {
  if (!selection) return 'Home';
  switch (selection.kind) {
    case 'area':
      return NAVIGATION_AREA_LABELS[selection.area];
    case 'project':
      return 'Project';
    case 'gezel':
      return 'Gezel';
    case 'document':
      return selection.path.split('/').filter(Boolean).pop() ?? 'Document';
    case 'task': {
      const parsed = parseTaskRef(selection.ref);
      return parsed ? `Task ${parsed.num}` : 'Task';
    }
    case 'script':
      return selection.name;
    case 'craftbook':
      return selection.id;
    case 'craftbook-script':
      return selection.name;
  }
}

export function entryTitle(entry: ViewEntry): string {
  return entry.title ?? fallbackTitle(entry.selection);
}

/** Where inside the view, outermost first: "Tasks · Draft the invoices". */
export function entryDetail(entry: ViewEntry): string {
  return Object.keys(entry.parts)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map((scope) => entry.parts[scope]!.label)
    .filter((label): label is string => Boolean(label))
    .join(' · ');
}

/** One line naming a place, for a key's tooltip: "Invoices · Tasks". */
export function entryLabel(entry: ViewEntry): string {
  const detail = entryDetail(entry);
  return detail ? `${entryTitle(entry)} · ${detail}` : entryTitle(entry);
}
