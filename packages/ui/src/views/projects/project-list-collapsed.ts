import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'gezel.projectsSidebarCollapsed';
const CHANGE_EVENT = 'gezel:project-list-collapsed-change';

/** Holds the choice for this visit when storage cannot. */
let unstored = false;

/**
 * Whether the Projects area's own project list is folded to its icons. The
 * navigation rail reads it too: while the list is open beside a project, the
 * rail folds so one list of projects shows at a time.
 */
export function isProjectListCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return unstored;
  }
}

export function setProjectListCollapsed(collapsed: boolean): void {
  unstored = collapsed;
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* storage unavailable: `unstored` carries it */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function useProjectListCollapsed(): boolean {
  return useSyncExternalStore(subscribe, isProjectListCollapsed, () => false);
}
