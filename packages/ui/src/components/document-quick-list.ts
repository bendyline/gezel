import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileEntry } from './FileTree.js';

export const DOCUMENT_QUICK_LIST_STORAGE_KEY = 'gezel:documents:quick-list:v1';
export const DOCUMENT_QUICK_LIST_CHANGED_EVENT = 'gezel:document-quick-list-changed';

const RECENT_DOCUMENT_LIMIT = 5;
const MAX_TRACKED_DOCUMENTS = 250;

export interface DocumentQuickListState {
  pinnedPaths: string[];
  lastUsedAt: Record<string, number>;
}

const EMPTY_STATE: DocumentQuickListState = { pinnedPaths: [], lastUsedAt: {} };
const alphabetic = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readDocumentQuickListState(): DocumentQuickListState {
  if (typeof window === 'undefined') return EMPTY_STATE;
  try {
    const raw = window.localStorage.getItem(DOCUMENT_QUICK_LIST_STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return EMPTY_STATE;

    const pinnedPaths = Array.isArray(parsed.pinnedPaths)
      ? Array.from(
          new Set(parsed.pinnedPaths.filter((path): path is string => typeof path === 'string')),
        )
      : [];
    const lastUsedAt: Record<string, number> = {};
    if (isRecord(parsed.lastUsedAt)) {
      for (const [path, timestamp] of Object.entries(parsed.lastUsedAt)) {
        if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0) {
          lastUsedAt[path] = timestamp;
        }
      }
    }
    return { pinnedPaths, lastUsedAt };
  } catch {
    return EMPTY_STATE;
  }
}

function writeDocumentQuickListState(next: DocumentQuickListState): void {
  try {
    window.localStorage.setItem(DOCUMENT_QUICK_LIST_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: the current interaction still succeeds.
  }
  window.dispatchEvent(new CustomEvent(DOCUMENT_QUICK_LIST_CHANGED_EVENT));
}

export function setDocumentPinned(path: string, pinned: boolean): void {
  const current = readDocumentQuickListState();
  const paths = new Set(current.pinnedPaths);
  if (pinned) paths.add(path);
  else paths.delete(path);
  writeDocumentQuickListState({ ...current, pinnedPaths: Array.from(paths) });
}

export function recordDocumentUsed(path: string, at = Date.now()): void {
  const current = readDocumentQuickListState();
  const lastUsedAt = { ...current.lastUsedAt, [path]: at };
  const newest = Object.entries(lastUsedAt)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_TRACKED_DOCUMENTS);
  writeDocumentQuickListState({ ...current, lastUsedAt: Object.fromEntries(newest) });
}

function pathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function renameDocumentQuickListPath(fromPath: string, toPath: string): void {
  const current = readDocumentQuickListState();
  let changed = false;
  const rename = (path: string) => {
    if (!pathWithin(path, fromPath)) return path;
    changed = true;
    return `${toPath}${path.slice(fromPath.length)}`;
  };

  const pinnedPaths = Array.from(new Set(current.pinnedPaths.map(rename)));
  const lastUsedAt: Record<string, number> = {};
  for (const [path, timestamp] of Object.entries(current.lastUsedAt)) {
    const nextPath = rename(path);
    lastUsedAt[nextPath] = Math.max(lastUsedAt[nextPath] ?? 0, timestamp);
  }
  if (changed) writeDocumentQuickListState({ pinnedPaths, lastUsedAt });
}

export function removeDocumentQuickListPath(path: string): void {
  const current = readDocumentQuickListState();
  const pinnedPaths = current.pinnedPaths.filter((candidate) => !pathWithin(candidate, path));
  const lastUsedAt = Object.fromEntries(
    Object.entries(current.lastUsedAt).filter(([candidate]) => !pathWithin(candidate, path)),
  );
  if (
    pinnedPaths.length !== current.pinnedPaths.length ||
    Object.keys(lastUsedAt).length !== Object.keys(current.lastUsedAt).length
  ) {
    writeDocumentQuickListState({ pinnedPaths, lastUsedAt });
  }
}

/**
 * Pinned documents plus the five most recently opened or modified documents.
 * Recency decides membership; the visible rail stays alphabetic and calm.
 */
export function documentQuickListEntries(
  entries: readonly FileEntry[],
  state: DocumentQuickListState,
  recentLimit = RECENT_DOCUMENT_LIMIT,
): FileEntry[] {
  const files = entries.filter((entry) => !entry.isDirectory);
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  const pinned = new Set(state.pinnedPaths.filter((path) => byPath.has(path)));
  const recent = files
    .filter((entry) => !pinned.has(entry.path))
    .slice()
    .sort((left, right) => {
      const leftAt = Math.max(left.mtimeMs ?? 0, state.lastUsedAt[left.path] ?? 0);
      const rightAt = Math.max(right.mtimeMs ?? 0, state.lastUsedAt[right.path] ?? 0);
      return rightAt - leftAt || alphabetic.compare(left.name, right.name);
    })
    .slice(0, recentLimit);

  return [...files.filter((entry) => pinned.has(entry.path)), ...recent].sort(
    (left, right) =>
      alphabetic.compare(left.name, right.name) || alphabetic.compare(left.path, right.path),
  );
}

export function useDocumentQuickList() {
  const [state, setState] = useState<DocumentQuickListState>(() => readDocumentQuickListState());

  useEffect(() => {
    const sync = () => setState(readDocumentQuickListState());
    const onStorage = (event: StorageEvent) => {
      if (event.key === DOCUMENT_QUICK_LIST_STORAGE_KEY) sync();
    };
    const onRenamed = (event: Event) => {
      const detail = (event as CustomEvent<{ fromPath?: string; toPath?: string }>).detail;
      if (detail?.fromPath && detail.toPath) {
        renameDocumentQuickListPath(detail.fromPath, detail.toPath);
      }
    };
    const onDeleted = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path) removeDocumentQuickListPath(path);
    };

    window.addEventListener(DOCUMENT_QUICK_LIST_CHANGED_EVENT, sync);
    window.addEventListener('storage', onStorage);
    window.addEventListener('gezel:document-renamed', onRenamed);
    window.addEventListener('gezel:document-deleted', onDeleted);
    return () => {
      window.removeEventListener(DOCUMENT_QUICK_LIST_CHANGED_EVENT, sync);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('gezel:document-renamed', onRenamed);
      window.removeEventListener('gezel:document-deleted', onDeleted);
    };
  }, []);

  const pinnedPaths = useMemo(() => new Set(state.pinnedPaths), [state.pinnedPaths]);
  const pin = useCallback((path: string) => setDocumentPinned(path, true), []);
  const unpin = useCallback((path: string) => setDocumentPinned(path, false), []);
  const noteUsed = useCallback((path: string) => recordDocumentUsed(path), []);

  return { state, pinnedPaths, pin, unpin, noteUsed };
}
