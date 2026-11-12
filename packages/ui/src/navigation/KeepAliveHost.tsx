import type { RecentTab } from '@bendyline/gezel';
import {
  Activity,
  type ReactNode,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { PaneFrame } from '../components/PaneFrame.js';
import { LiveRenderGate } from '../components/live-render-gate.js';
import { ViewLocationRoot } from '../components/view-history/ViewHistoryContext.js';
import { openBackgroundSpan } from '../nav-timing.js';
import { setVisibleInterval } from '../visible-interval.js';
import { destinationFor } from './destinations.js';

/**
 * Recently visited destinations stay mounted but hidden (React `<Activity>`),
 * so returning to one paints at once with its state, tab and scroll intact.
 *
 * - Home is kept once visited. Besides it, the newest `hiddenLimit` hidden
 *   destinations are kept (three on a desktop, one on a phone); older ones
 *   unmount, as does one hidden for longer than ten minutes.
 * - Destinations the registry marks `keepAlive: false` (Settings, editors)
 *   unmount as soon as they are left.
 * - A destination whose project, gezel or document is deleted unmounts, and
 *   one that crashed unmounts when left, so coming back starts it fresh.
 *
 * Hidden views keep their DOM and state but not their effects: React runs
 * their cleanups on hide, so their polls and streams stop, and runs them
 * again on show. Views must tolerate that (see docs/ui-architecture.md,
 * "Kept alive").
 */

interface KeptView {
  key: string;
  tab: RecentTab | null;
  /** When it was last hidden; null while shown. */
  hiddenAt: number | null;
}

const HIDDEN_FOR_MS = 10 * 60_000;

export function nextKeptViews(
  previous: readonly KeptView[],
  shown: { key: string; tab: RecentTab | null; keepAlive: boolean },
  options: { hiddenLimit: number; now: number },
): KeptView[] {
  const kept: KeptView[] = [];
  for (const view of previous) {
    if (view.key === shown.key) {
      kept.push({ ...view, tab: shown.tab, hiddenAt: null });
      continue;
    }
    if (!destinationFor(view.tab).keepAlive) continue;
    const hiddenAt = view.hiddenAt ?? options.now;
    if (view.key !== 'home' && options.now - hiddenAt >= HIDDEN_FOR_MS) continue;
    kept.push({ ...view, hiddenAt });
  }
  if (!kept.some((view) => view.key === shown.key)) {
    kept.push({ key: shown.key, tab: shown.tab, hiddenAt: null });
  }
  // Order stays the order of first visit: moving a mounted subtree in the
  // DOM reloads its iframes and resets its scroll.
  const hidden = kept
    .filter((view) => view.hiddenAt !== null && view.key !== 'home')
    .sort((a, b) => (b.hiddenAt ?? 0) - (a.hiddenAt ?? 0));
  const evicted = new Set(hidden.slice(options.hiddenLimit).map((view) => view.key));
  return kept.filter((view) => !evicted.has(view.key));
}

/** Drop hidden views that have been hidden too long. */
function withoutExpired(views: readonly KeptView[], now: number): readonly KeptView[] {
  const next = views.filter(
    (view) => view.hiddenAt === null || view.key === 'home' || now - view.hiddenAt < HIDDEN_FOR_MS,
  );
  return next.length === views.length ? views : next;
}

/** Whether a deletion event names the thing a kept view shows. */
function deletedBy(view: KeptView, event: Event): boolean {
  const detail = ((event as CustomEvent).detail ?? {}) as Record<string, unknown>;
  const tab = view.tab;
  if (!tab) return false;
  if (event.type === 'gezel:project-deleted') {
    return tab.kind === 'project' && tab.id === detail.projectId;
  }
  if (event.type === 'gezel:gezel-deleted') {
    return tab.kind === 'gezel' && (tab.id === detail.id || tab.id === detail.gezelId);
  }
  if (event.type === 'gezel:document-deleted') {
    const path = typeof detail.path === 'string' ? detail.path : null;
    return (
      tab.kind === 'document' &&
      path !== null &&
      (tab.path === path || tab.path.startsWith(`${path}/`))
    );
  }
  return false;
}

const DELETION_EVENTS = ['gezel:project-deleted', 'gezel:gezel-deleted', 'gezel:document-deleted'];

export function KeepAliveHost({
  selection,
  hiddenLimit,
  render,
}: {
  selection: RecentTab | null;
  hiddenLimit: number;
  /** The view for a destination, error boundary included. */
  render: (tab: RecentTab | null, onCrash: () => void) => ReactNode;
}) {
  const shown = destinationFor(selection);
  const [views, setViews] = useState<readonly KeptView[]>(() =>
    nextKeptViews(
      [],
      { key: shown.key, tab: selection, keepAlive: shown.keepAlive },
      {
        hiddenLimit,
        now: Date.now(),
      },
    ),
  );
  const [crashed, setCrashed] = useState<ReadonlySet<string>>(new Set());
  // Adjust the kept set in render when the shown destination changes, so the
  // new view mounts in the same commit instead of one frame later.
  const [shownKey, setShownKey] = useState(shown.key);
  if (shownKey !== shown.key) {
    setShownKey(shown.key);
    setViews((previous) =>
      nextKeptViews(
        previous.filter((view) => !crashed.has(view.key) || view.key === shown.key),
        { key: shown.key, tab: selection, keepAlive: shown.keepAlive },
        { hiddenLimit, now: Date.now() },
      ),
    );
    if (crashed.size > 0) setCrashed(new Set());
  }

  useEffect(
    () =>
      setVisibleInterval(() => setViews((current) => withoutExpired(current, Date.now())), 60_000),
    [],
  );

  useEffect(() => {
    const onDeleted = (event: Event) =>
      setViews((current) => {
        const next = current.filter((view) => view.hiddenAt === null || !deletedBy(view, event));
        return next.length === current.length ? current : next;
      });
    for (const type of DELETION_EVENTS) window.addEventListener(type, onDeleted);
    return () => {
      for (const type of DELETION_EVENTS) window.removeEventListener(type, onDeleted);
    };
  }, []);

  return (
    <>
      {views.map((view) => {
        const visible = view.key === shown.key;
        return (
          <Activity key={view.key} mode={visible ? 'visible' : 'hidden'}>
            <LiveRenderGate shown={visible}>
              <ScrollKeeper visible={visible}>
                <RevealSpan edge="open" />
                <Suspense fallback={<PaneFrame kind={destinationFor(view.tab).frame} />}>
                  <ViewLocationRoot selection={view.tab}>
                    {render(view.tab, () =>
                      setCrashed((current) => new Set(current).add(view.key)),
                    )}
                  </ViewLocationRoot>
                </Suspense>
                <RevealSpan edge="close" />
              </ScrollKeeper>
            </LiveRenderGate>
          </Activity>
        );
      })}
    </>
  );
}

interface RevealState {
  shownBefore: boolean;
  release: (() => void) | null;
}

const RevealContext = createContext<{ current: RevealState } | null>(null);

/**
 * A kept view shown again runs its effects again, and their reads refresh
 * what is already on screen. Requests they start are background work for
 * navigation timing, as any revalidation of a painted view is. React runs a
 * subtree's effects in order, so a marker before the view opens the span and
 * one after it closes it, within the one flush that shows the view. Its first
 * mount is not a reveal: those reads are the view's own.
 */
function RevealSpan({ edge }: { edge: 'open' | 'close' }) {
  const state = useContext(RevealContext);
  useEffect(() => {
    if (!state) return;
    if (edge === 'open') {
      if (state.current.shownBefore) state.current.release = openBackgroundSpan();
      return;
    }
    state.current.release?.();
    state.current.release = null;
    state.current.shownBefore = true;
  }, [edge, state]);
  return null;
}

/**
 * Hiding a view sets `display: none`, which drops the scroll position of
 * everything inside it. Scroll positions are recorded as they change while
 * the view is shown and put back on show, before paint, unless the view
 * already placed them (a chat pinned to its newest message scrolls itself).
 */
function ScrollKeeper({ visible, children }: { visible: boolean; children: ReactNode }) {
  const positions = useRef(new Map<Element, { top: number; left: number }>());
  const reveal = useRef<RevealState>({ shownBefore: false, release: null });
  useLayoutEffect(() => {
    if (!visible) return;
    for (const [element, { top, left }] of positions.current) {
      if (!element.isConnected) {
        positions.current.delete(element);
        continue;
      }
      if (element.scrollTop !== 0 || element.scrollLeft !== 0) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }, [visible]);
  return (
    <div
      className="keep-alive-view"
      // The shown view, for layout rules that read the pane's content (app-shell.css).
      data-shown={visible ? '' : undefined}
      onScrollCapture={(event) => {
        if (!visible) return;
        const element = event.target as Element;
        if (element.scrollTop === 0 && element.scrollLeft === 0) positions.current.delete(element);
        else positions.current.set(element, { top: element.scrollTop, left: element.scrollLeft });
      }}
    >
      <RevealContext.Provider value={reveal}>{children}</RevealContext.Provider>
    </div>
  );
}
