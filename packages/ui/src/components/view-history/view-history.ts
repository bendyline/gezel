import { type RecentTab, RecentTabSchema } from '@bendyline/gezel';
import { tabKey } from '../recent-tabs.js';

/**
 * The view stack behind the titlebar's Back, Forward and history keys. Pure:
 * every function takes a history and returns the next one, so the rules are
 * testable without React. App owns the state; views report where they are
 * inside themselves through `useViewLocation` (ViewHistoryContext.tsx).
 *
 * An entry is one place a person stood: a top-level selection (what the
 * sidebar picks) plus the "parts" views reported inside it, keyed by scope
 * path — `project` is a project's tab, `project/tasks` the task chosen on
 * that tab, `project/tasks/task` that task's own tab.
 */

/** Browsers keep more, but a trail longer than this is never read back. */
export const VIEW_HISTORY_LIMIT = 50;
/** sessionStorage: the trail lasts one window session, like a browser tab's. */
export const VIEW_HISTORY_STORAGE_KEY = 'gezel:nav:history';

export interface ViewPart {
  /** Equality: two parts with the same key are the same place. */
  key: string;
  /** What the view needs to put itself back there. JSON-serializable. */
  value: unknown;
  /** Plain name for the history menu: "Chat", "Draft the invoices". */
  label?: string;
}

export interface ViewEntry {
  id: number;
  /** `null` is Home. */
  selection: RecentTab | null;
  parts: Record<string, ViewPart>;
  /** The view's own name for what it shows: a project's name, a task's title. */
  title?: string;
  at: number;
}

export interface ViewHistory {
  entries: ViewEntry[];
  index: number;
  nextId: number;
}

/** `toRecentTab` stamps a fresh `at` on every call, so identity is the tab key. */
export function selectionKey(selection: RecentTab | null): string {
  return selection ? tabKey(selection) : 'home';
}

export function createHistory(selection: RecentTab | null, at = Date.now()): ViewHistory {
  return { entries: [{ id: 1, selection, parts: {}, at }], index: 0, nextId: 2 };
}

export function currentEntry(history: ViewHistory): ViewEntry {
  return history.entries[history.index] ?? history.entries[0]!;
}

export function canGoBack(history: ViewHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: ViewHistory): boolean {
  return history.index < history.entries.length - 1;
}

function withCurrent(history: ViewHistory, entry: ViewEntry): ViewHistory {
  const entries = history.entries.slice();
  entries[history.index] = entry;
  return { ...history, entries };
}

/** Navigating somewhere new after going Back drops the entries ahead, as a browser does. */
function append(history: ViewHistory, entry: Omit<ViewEntry, 'id'>): ViewHistory {
  const kept = history.entries.slice(0, history.index + 1);
  kept.push({ ...entry, id: history.nextId });
  const entries = kept.length > VIEW_HISTORY_LIMIT ? kept.slice(-VIEW_HISTORY_LIMIT) : kept;
  return { entries, index: entries.length - 1, nextId: history.nextId + 1 };
}

/** A new top-level place. Re-selecting where you already are adds nothing. */
export function pushSelection(
  history: ViewHistory,
  selection: RecentTab | null,
  at = Date.now(),
): ViewHistory {
  if (selectionKey(currentEntry(history).selection) === selectionKey(selection)) return history;
  return append(history, { selection, parts: {}, at });
}

/** Swap the current place without adding a step (first run's forced Home). */
export function replaceSelection(
  history: ViewHistory,
  selection: RecentTab | null,
  at = Date.now(),
): ViewHistory {
  const current = currentEntry(history);
  if (selectionKey(current.selection) === selectionKey(selection)) return history;
  return withCurrent(history, { id: current.id, selection, parts: {}, at });
}

function withoutNested(parts: Record<string, ViewPart>, scope: string): Record<string, ViewPart> {
  const next: Record<string, ViewPart> = {};
  for (const [key, part] of Object.entries(parts)) {
    if (!key.startsWith(`${scope}/`)) next[key] = part;
  }
  return next;
}

export interface SetPartOptions {
  /** The selection the reporting view belongs to; a report from a view on its way out is dropped. */
  selectionKey: string;
  /** Record the move without adding a step: a view correcting itself, not a person moving. */
  annotate?: boolean;
  at?: number;
}

/**
 * A view reports where it is inside itself. The first report for a scope is
 * the view's default and only annotates the entry. A different place is a
 * step of its own, and the parts below it belong to the place being left.
 */
export function setPart(
  history: ViewHistory,
  scope: string,
  part: ViewPart,
  options: SetPartOptions,
): ViewHistory {
  const current = currentEntry(history);
  if (selectionKey(current.selection) !== options.selectionKey) return history;
  const existing = current.parts[scope];
  if (existing && existing.key === part.key) {
    if (existing.label === part.label) return history;
    return withCurrent(history, { ...current, parts: { ...current.parts, [scope]: part } });
  }
  if (!existing) {
    // A child view's effect can land before its parent's first report, so a
    // first report never clears what is nested under it.
    return withCurrent(history, { ...current, parts: { ...current.parts, [scope]: part } });
  }
  const parts = { ...withoutNested(current.parts, scope), [scope]: part };
  if (options.annotate) return withCurrent(history, { ...current, parts });
  return append(history, {
    selection: current.selection,
    parts,
    ...(current.title ? { title: current.title } : {}),
    at: options.at ?? Date.now(),
  });
}

/** A view names what it shows. Every entry for that selection takes the name. */
export function setTitle(history: ViewHistory, key: string, title: string): ViewHistory {
  let changed = false;
  const entries = history.entries.map((entry) => {
    if (entry.title === title || selectionKey(entry.selection) !== key) return entry;
    changed = true;
    return { ...entry, title };
  });
  return changed ? { ...history, entries } : history;
}

export function traverse(history: ViewHistory, index: number): ViewHistory {
  const clamped = Math.max(0, Math.min(history.entries.length - 1, index));
  return clamped === history.index ? history : { ...history, index: clamped };
}

function placeKey(entry: ViewEntry): string {
  const parts = Object.keys(entry.parts)
    .sort()
    .map((scope) => `${scope}=${entry.parts[scope]!.key}`);
  return [selectionKey(entry.selection), ...parts].join('|');
}

/**
 * Drop every entry a deleted thing occupied. Removing one can leave the same
 * place twice in a row, which would make Back look broken, so neighbors that
 * are the same place collapse into one.
 */
export function purge(
  history: ViewHistory,
  isGone: (selection: RecentTab | null) => boolean,
): ViewHistory {
  const entries: ViewEntry[] = [];
  let index = -1;
  history.entries.forEach((entry, i) => {
    if (!isGone(entry.selection)) {
      const previous = entries[entries.length - 1];
      if (!previous || placeKey(previous) !== placeKey(entry)) entries.push(entry);
    }
    if (i === history.index) index = entries.length - 1;
  });
  if (entries.length === 0) {
    return {
      entries: [{ id: history.nextId, selection: null, parts: {}, at: Date.now() }],
      index: 0,
      nextId: history.nextId + 1,
    };
  }
  return { entries, index: Math.max(0, index), nextId: history.nextId };
}

/** Follow a rename: every entry keeps its place under the thing's new address. */
export function rewrite(
  history: ViewHistory,
  map: (selection: RecentTab | null) => RecentTab | null,
): ViewHistory {
  let changed = false;
  const entries = history.entries.map((entry) => {
    const selection = map(entry.selection);
    if (selection === entry.selection) return entry;
    changed = true;
    return { ...entry, selection };
  });
  return changed ? { ...history, entries } : history;
}

export function serializeHistory(history: ViewHistory): string {
  return JSON.stringify(history);
}

function parseEntry(raw: unknown): ViewEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'number' || typeof entry.at !== 'number') return null;
  let selection: RecentTab | null = null;
  if (entry.selection !== null) {
    const parsed = RecentTabSchema.safeParse(entry.selection);
    if (!parsed.success) return null;
    selection = parsed.data;
  }
  const parts: Record<string, ViewPart> = {};
  if (entry.parts && typeof entry.parts === 'object') {
    for (const [scope, value] of Object.entries(entry.parts as Record<string, unknown>)) {
      const part = value as Partial<ViewPart> | null;
      if (!part || typeof part.key !== 'string') return null;
      parts[scope] = {
        key: part.key,
        value: part.value,
        ...(typeof part.label === 'string' ? { label: part.label } : {}),
      };
    }
  }
  return {
    id: entry.id,
    selection,
    parts,
    ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
    at: entry.at,
  };
}

/** A trail from storage, or `null` when any of it is not one this build wrote. */
export function parseHistory(raw: string | null): ViewHistory | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ViewHistory>;
    if (!Array.isArray(value.entries) || value.entries.length === 0) return null;
    if (typeof value.index !== 'number' || typeof value.nextId !== 'number') return null;
    if (value.index < 0 || value.index >= value.entries.length) return null;
    const entries: ViewEntry[] = [];
    for (const raw of value.entries) {
      const entry = parseEntry(raw);
      if (!entry) return null;
      entries.push(entry);
    }
    const nextId = Math.max(value.nextId, ...entries.map((entry) => entry.id + 1));
    const trimmed = Math.max(0, entries.length - VIEW_HISTORY_LIMIT);
    return {
      entries: entries.slice(trimmed),
      index: Math.max(0, value.index - trimmed),
      nextId,
    };
  } catch {
    return null;
  }
}
