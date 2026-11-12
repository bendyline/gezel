import type { RecentTab } from '@bendyline/gezel';
import {
  type Dispatch,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { beginNavigation } from '../../nav-timing.js';
import {
  VIEW_HISTORY_STORAGE_KEY,
  type ViewHistory,
  type ViewPart,
  canGoBack,
  canGoForward,
  createHistory,
  currentEntry,
  parseHistory,
  purge,
  pushSelection,
  replaceSelection,
  rewrite,
  selectionKey,
  serializeHistory,
  setPart,
  setTitle,
  traverse,
} from './view-history.js';

/**
 * React side of the view stack (model in view-history.ts). App owns the
 * state and turns a traversal into a selection; views report where they are
 * inside themselves with {@link useViewLocation}. Hosts without the provider
 * (the embedded chat, tests of one view) get inert hooks.
 */

export type ViewHistoryAction =
  | { type: 'push'; selection: RecentTab | null }
  | { type: 'replace'; selection: RecentTab | null }
  | { type: 'set-part'; scope: string; part: ViewPart; selectionKey: string; annotate: boolean }
  | { type: 'set-title'; selectionKey: string; title: string }
  | { type: 'go'; index: number }
  | { type: 'step'; delta: number }
  | { type: 'purge'; isGone: (selection: RecentTab | null) => boolean }
  | { type: 'rewrite'; map: (selection: RecentTab | null) => RecentTab | null };

export interface ViewHistoryState {
  history: ViewHistory;
  /** Bumped by every traversal, so views can tell Back from a fresh step. */
  revision: number;
}

function withHistory(state: ViewHistoryState, history: ViewHistory): ViewHistoryState {
  return history === state.history ? state : { ...state, history };
}

function traversed(state: ViewHistoryState, history: ViewHistory): ViewHistoryState {
  return history === state.history ? state : { history, revision: state.revision + 1 };
}

export function viewHistoryReducer(
  state: ViewHistoryState,
  action: ViewHistoryAction,
): ViewHistoryState {
  switch (action.type) {
    case 'push':
      return withHistory(state, pushSelection(state.history, action.selection));
    case 'replace':
      return withHistory(state, replaceSelection(state.history, action.selection));
    case 'set-part':
      return withHistory(
        state,
        setPart(state.history, action.scope, action.part, {
          selectionKey: action.selectionKey,
          annotate: action.annotate,
        }),
      );
    case 'set-title':
      return withHistory(state, setTitle(state.history, action.selectionKey, action.title));
    case 'go':
      return traversed(state, traverse(state.history, action.index));
    case 'step':
      return traversed(state, traverse(state.history, state.history.index + action.delta));
    case 'purge':
      return withHistory(state, purge(state.history, action.isGone));
    case 'rewrite':
      return withHistory(state, rewrite(state.history, action.map));
  }
}

function initialState(selection: RecentTab | null): ViewHistoryState {
  let stored: ViewHistory | null = null;
  try {
    stored = parseHistory(window.sessionStorage.getItem(VIEW_HISTORY_STORAGE_KEY));
  } catch {
    /* storage blocked — the trail starts here */
  }
  // A reload keeps the trail only when it ends where the app reopens.
  const history =
    stored && selectionKey(currentEntry(stored).selection) === selectionKey(selection)
      ? stored
      : createHistory(selection);
  return { history, revision: 0 };
}

/** App's state for the view stack, kept in sessionStorage for the window's life. */
export function useViewHistoryState(
  initialSelection: RecentTab | null,
): [ViewHistoryState, Dispatch<ViewHistoryAction>] {
  const [state, dispatch] = useReducer(viewHistoryReducer, initialSelection, initialState);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(VIEW_HISTORY_STORAGE_KEY, serializeHistory(state.history));
    } catch {
      /* private mode / quota — the trail still lives in memory */
    }
  }, [state.history]);
  return [state, dispatch];
}

export interface ViewHistoryApi {
  history: ViewHistory;
  revision: number;
  canGoBack: boolean;
  canGoForward: boolean;
  back: () => void;
  forward: () => void;
  go: (index: number) => void;
  setPart: (
    scope: string,
    part: ViewPart,
    options: { selectionKey: string; annotate: boolean },
  ) => void;
  setTitle: (selectionKey: string, title: string) => void;
}

export function useViewHistoryApi(
  state: ViewHistoryState,
  dispatch: Dispatch<ViewHistoryAction>,
): ViewHistoryApi {
  const actions = useMemo(
    () => ({
      back: () => dispatch({ type: 'step', delta: -1 }),
      forward: () => dispatch({ type: 'step', delta: 1 }),
      go: (index: number) => dispatch({ type: 'go', index }),
      setPart: (
        scope: string,
        part: ViewPart,
        options: { selectionKey: string; annotate: boolean },
      ) => dispatch({ type: 'set-part', scope, part, ...options }),
      setTitle: (key: string, title: string) =>
        dispatch({ type: 'set-title', selectionKey: key, title }),
    }),
    [dispatch],
  );
  return useMemo(
    () => ({
      ...actions,
      history: state.history,
      revision: state.revision,
      canGoBack: canGoBack(state.history),
      canGoForward: canGoForward(state.history),
    }),
    [actions, state],
  );
}

const ViewHistoryContext = createContext<ViewHistoryApi | null>(null);

export const ViewHistoryProvider = ViewHistoryContext.Provider;

export function useViewHistory(): ViewHistoryApi | null {
  return useContext(ViewHistoryContext);
}

/**
 * Where a view sits: the selection it was mounted for, its scope path, and
 * the place each enclosing view was at when it rendered this one. A child
 * acts only while every enclosing view still stands where the current entry
 * says — otherwise its report would land on the place its parent is leaving.
 */
interface LocationScope {
  selectionKey: string;
  prefix: string;
  ancestors: { scope: string; key: string }[];
}

const LocationScopeContext = createContext<LocationScope | null>(null);

/** Wraps the main pane, so a view's reports name the selection it belongs to. */
export function ViewLocationRoot({
  selection,
  children,
}: {
  selection: RecentTab | null;
  children: ReactNode;
}) {
  const key = selectionKey(selection);
  const value = useMemo<LocationScope>(
    () => ({ selectionKey: key, prefix: '', ancestors: [] }),
    [key],
  );
  return <LocationScopeContext.Provider value={value}>{children}</LocationScopeContext.Provider>;
}

function isLive(history: ViewHistory, scope: LocationScope): boolean {
  const entry = currentEntry(history);
  if (selectionKey(entry.selection) !== scope.selectionKey) return false;
  return scope.ancestors.every((ancestor) => {
    const part = entry.parts[ancestor.scope];
    return !part || part.key === ancestor.key;
  });
}

function scopeName(parent: LocationScope | null, name: string): string | null {
  return parent ? (parent.prefix ? `${parent.prefix}/${name}` : name) : null;
}

/**
 * The place Back left for this scope, read once at mount. For seeding a
 * view's own state before it can call {@link useViewLocation} (which needs
 * that state to report), so the view opens straight onto the restored tab.
 */
export function useRestoredViewPart(name: string): ViewPart | undefined {
  const api = useViewHistory();
  const parent = useContext(LocationScopeContext);
  const [restored] = useState<ViewPart | undefined>(() => {
    const scope = scopeName(parent, name);
    if (!api || !parent || !scope || !isLive(api.history, parent)) return undefined;
    return currentEntry(api.history).parts[scope];
  });
  return restored;
}

export interface ViewLocationOptions {
  /** Where the view is now; `null` while it is still loading and has nowhere to report. */
  part: ViewPart | null;
  /** What the view shows. Names the entry only for a top-level view. */
  title?: string;
  /** Back or Forward landed on a different place inside this view: go there. */
  onRestore?: (part: ViewPart) => void;
}

export interface ViewLocation {
  /** This scope's part in the entry the view mounted on — its starting place after Back. */
  restored: ViewPart | undefined;
  /** For views nested inside this one: pass to {@link ViewLocationScope}. */
  scope: LocationScope | null;
  /**
   * The view is about to correct itself to `key` (a redirect away from a
   * closed section, a list landing on its first row): record arriving there
   * without a step. Any other report disarms it, so a correction that never
   * happens cannot swallow the person's next move.
   */
  replaceNext: (key: string) => void;
}

/**
 * Report where a view is inside itself. A person's move to a different place
 * adds a step; the first report only annotates the entry; Back and Forward
 * call `onRestore` instead of reporting.
 */
export function useViewLocation(name: string, options: ViewLocationOptions): ViewLocation {
  const api = useViewHistory();
  const parent = useContext(LocationScopeContext);
  const scope = scopeName(parent, name);
  const live = Boolean(api && parent && isLive(api.history, parent));
  const restored = useRestoredViewPart(name);

  const partRef = useRef(options.part);
  partRef.current = options.part;
  const onRestoreRef = useRef(options.onRestore);
  onRestoreRef.current = options.onRestore;
  const historyRef = useRef(api?.history);
  historyRef.current = api?.history;
  const revision = api?.revision ?? 0;
  const seenRevision = useRef(revision);
  // A restore in flight: reports of the place being left are held until the
  // view arrives, so Back never records the view's last frame as a new step.
  const pending = useRef<{ from: string | undefined; to: string } | null>(null);
  const correctionTo = useRef<string | null>(null);
  const reportedKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    const history = historyRef.current;
    if (!history || !scope || !live) return;
    const target = currentEntry(history).parts[scope];
    const from = partRef.current?.key;
    if (!target || target.key === from) return;
    pending.current = { from, to: target.key };
    onRestoreRef.current?.(target);
  }, [revision, scope, live]);

  const setPartAction = api?.setPart;
  const parentKey = parent?.selectionKey;
  const partKey = options.part?.key;
  const partLabel = options.part?.label;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a view builds its part afresh each render, so the effect re-runs on the part's key and label and reads the part itself through a ref.
  useEffect(() => {
    const part = partRef.current;
    if (!setPartAction || !scope || !parentKey || !part || !live) return;
    let annotate = correctionTo.current === part.key;
    correctionTo.current = null;
    const waiting = pending.current;
    if (waiting) {
      if (part.key === waiting.from) return;
      pending.current = null;
      // The view landed somewhere other than where Back asked: it corrected
      // itself (a closed section), which is not a step of its own.
      if (part.key !== waiting.to) annotate = true;
    }
    const previousKey = reportedKey.current;
    reportedKey.current = part.key;
    // A person's move to another place inside the view is timed like a move
    // between views; the first report and self-corrections are not moves.
    if (previousKey !== undefined && previousKey !== part.key && !annotate) {
      beginNavigation(`${parentKey}/${scope}:${part.key}`, { scope: 'part' });
    }
    setPartAction(scope, part, { selectionKey: parentKey, annotate });
  }, [setPartAction, scope, parentKey, partKey, partLabel, live]);

  const replaceNext = useCallback((key: string) => {
    correctionTo.current = key;
  }, []);

  const setTitleAction = api?.setTitle;
  const title = options.title;
  const topLevel = parent?.prefix === '';
  useEffect(() => {
    if (!setTitleAction || !parentKey || !title || !topLevel) return;
    setTitleAction(parentKey, title);
  }, [setTitleAction, parentKey, title, topLevel]);

  const childScope = useMemo<LocationScope | null>(
    () =>
      parent && scope && partKey !== undefined
        ? {
            selectionKey: parent.selectionKey,
            prefix: scope,
            ancestors: [...parent.ancestors, { scope, key: partKey }],
          }
        : null,
    [parent, scope, partKey],
  );

  return useMemo(
    () => ({ restored, scope: childScope, replaceNext }),
    [restored, childScope, replaceNext],
  );
}

/** Nests the views rendered inside one that reported a location. */
export function ViewLocationScope({
  location,
  children,
}: {
  location: ViewLocation;
  children: ReactNode;
}) {
  return (
    <LocationScopeContext.Provider value={location.scope}>{children}</LocationScopeContext.Provider>
  );
}
