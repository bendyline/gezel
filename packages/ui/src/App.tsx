import type {
  ChatEventEnvelope,
  NightShiftReviewResponse,
  NightShiftTallyResponse,
  NightShiftTasksResponse,
  RecentTab,
  RecentTabArea,
  SecurityPolicy,
} from '@bendyline/gezel';
import type { NightShiftStatusResponse, QuotaBucket, UsageResponse } from '@bendyline/gezel-client';
import {
  Suspense,
  lazy,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from './api.js';
import { ActivityControl } from './components/ActivityControl.js';
import { AddFolderSheet, openAddFolder } from './components/AddFolderSheet.js';
import { AppBrand } from './components/AppBrand.js';
import { BackupRestoreDialog } from './components/BackupRestoreDialog.js';
import { BoekwachterPill } from './components/BoekwachterPill.js';
import { ClaudeCliPoolPill } from './components/ClaudeCliPoolPill.js';
import { EngagementModeIcon } from './components/EngagementModeIcon.js';
import { EngagementModeMenu } from './components/EngagementModeMenu.js';
import { EngineStatusPill } from './components/EngineStatusPill.js';
import { GrantConsentDialog } from './components/GrantConsentDialog.js';
import { MacUninstallDialog } from './components/MacUninstallDialog.js';
import { ModelBundleImportController } from './components/ModelBundleControls.js';
import { NarrationStopButton } from './components/NarrationStopButton.js';
import { ResponsiveAppShell } from './components/ResponsiveAppShell.js';
import { SearchResultsOverlay } from './components/SearchResultsOverlay.js';
import { Sidebar } from './components/Sidebar.js';
import { StorageCleanupDialog } from './components/StorageCleanupDialog.js';
import { TabContent } from './components/TabContent.js';
import { TabErrorBoundary } from './components/TabErrorBoundary.js';
import { TitlebarSearch } from './components/TitlebarSearch.js';
import { ActivityProvider, useActivity } from './components/activity-context.js';
import { projectRecipientKey, writeChatThreadSelection } from './components/chat-thread-memory.js';
import { ENGAGEMENT_MODES } from './components/engagement-modes.js';
import { FirstRunProvider } from './components/first-run-context.js';
import { HeaderDensityContext, useHeaderDensityMeasurement } from './components/header-density.js';
import { navigateToTab, openProjectFileActions, runNavActions } from './components/nav-actions.js';
import { NIGHT_SHIFT_MOON_PATH, NightShiftMoonGlyph } from './components/night-shift-glyph.js';
import {
  OUTPUT_PANE_MAXIMIZED_EVENT,
  requestOutputPaneRestore,
} from './components/output-pane-maximize.js';
import { type RecentTabInput, tabKey, toRecentTab } from './components/recent-tabs.js';
import {
  loadHomeViewModule,
  preloadTabContent,
  preloadTabData,
} from './components/tab-content-loaders.js';
import { useHostNotifications } from './components/useHostNotifications.js';
import { useIsFirstRun } from './components/useIsFirstRun.js';
import { readAppSurface } from './embedded/app-surface.js';
import { type DocumentFocus, readDocumentFocus } from './embedded/document-focus.js';
import { useBackNavigation } from './hooks/useBackNavigation.js';
import { useResponsiveLayout } from './hooks/useResponsiveLayout.js';
import { beginNavigation } from './nav-timing.js';
import { DropdownMenu } from './primitives/index.js';
import { runtimeCapabilities } from './runtime-capabilities.js';
import { requestSettingsSection } from './settings-nav.js';
import { streamSharedAllChatEvents } from './shared-chat-events.js';
import { syncSidebarSideFromConfig } from './sidebar-side.js';
import { syncThemeFromConfig } from './theme.js';
import { setVisibleInterval } from './visible-interval.js';

const HomeView = lazy(() => loadHomeViewModule().then(({ HomeView }) => ({ default: HomeView })));
const EmbeddedChat = lazy(() =>
  import('./embedded/EmbeddedChat.js').then(({ EmbeddedChat }) => ({ default: EmbeddedChat })),
);

// Navigation is a single `selection` driven by the left Sidebar:
//   - `null`         → the Meester home / dashboard view
//   - a RecentTab    → an entity (project / gezel / document / task) or a
//                      top-level area, routed by TabContent.
// The old MRU tab bar is gone; the Sidebar lists live entities itself.
const AREA_NAMES: RecentTabArea[] = [
  'projects',
  'gezels',
  'documents',
  'tasks',
  'craftbooks',
  'scripts',
  'history',
  'knowledge',
  'handboek',
  'benchmarks',
  'settings',
];

const SELECTION_STORAGE_KEY = 'gezel:nav:selection';

/** Restore the last selection from localStorage; `null` = Meester home. */
function readStoredSelection(): RecentTab | null {
  try {
    const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecentTab;
    if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

type EngagementMode = 'proactive' | 'scheduled' | 'reactive' | 'off';

type ActiveTurnAddress = {
  projectId: string;
  gezelId: string;
};

/**
 * Embedded-mode detector. Read once at module load; the URL doesn't
 * change without a full reload, so a stable value avoids hooks-rules
 * complications between embedded and full modes.
 */
function readEmbeddedParams(): {
  projectId: string;
  gezelId: string;
  theme: string | null;
  accent: string | null;
  bg: string | null;
  fg: string | null;
  fontFamily: string | null;
  compact: boolean;
  documentFocus: DocumentFocus | null;
} | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('embedded') !== 'chat') return null;
  const projectId = params.get('projectId') ?? '';
  const gezelId = params.get('gezelId') ?? '';
  if (!projectId) return null;
  return {
    projectId,
    gezelId,
    theme: params.get('theme'),
    accent: params.get('accent'),
    bg: params.get('bg'),
    fg: params.get('fg'),
    fontFamily: params.get('fontFamily'),
    // Narrow hosts (the Office task pane) drop the chat's right rail.
    compact: params.get('compact') === '1',
    // The Office pane's document: one conversation about it, not the project.
    documentFocus: readDocumentFocus(params, readAppSurface(window.location.search)),
  };
}

const EMBEDDED_PARAMS = readEmbeddedParams();

// A host that names a gezel opens the chat addressed to them. ProjectChat
// reads this memory before its own lead/roster ranking.
if (EMBEDDED_PARAMS?.gezelId) {
  writeChatThreadSelection(projectRecipientKey(EMBEDDED_PARAMS.projectId), {
    gezelId: EMBEDDED_PARAMS.gezelId,
  });
}

export function App() {
  if (EMBEDDED_PARAMS) {
    return (
      <Suspense fallback={null}>
        <EmbeddedChat
          projectId={EMBEDDED_PARAMS.projectId}
          gezelId={EMBEDDED_PARAMS.gezelId}
          theme={EMBEDDED_PARAMS.theme}
          accent={EMBEDDED_PARAMS.accent}
          bg={EMBEDDED_PARAMS.bg}
          fg={EMBEDDED_PARAMS.fg}
          fontFamily={EMBEDDED_PARAMS.fontFamily}
          compact={EMBEDDED_PARAMS.compact}
          documentFocus={EMBEDDED_PARAMS.documentFocus}
        />
      </Suspense>
    );
  }
  return (
    <ActivityProvider>
      <FullApp />
      <AddFolderSheet />
    </ActivityProvider>
  );
}

function FullApp() {
  useHostNotifications();
  const { compact, preview, exitPreview } = useResponsiveLayout();
  const firstRun = useIsFirstRun();
  const setupOpened = useRef(false);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const openNavigation = useCallback(() => setNavigationOpen(true), []);
  const toggleNavigation = useCallback(() => setNavigationOpen((open) => !open), []);
  useBackNavigation(compact, navigationOpen, openNavigation);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [outputPaneMaximized, setOutputPaneMaximized] = useState(false);
  // Per-project signals painted on the sidebar rows: which projects have a
  // gezel mid-turn (the animated "thinking" indicator), and how many pending
  // questions each has (the "needs input" affordance). Both ride the single
  // global SSE stream + the same listQuestions call the Home badge makes — no
  // extra endpoints or connections.
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(new Set());
  const [activeProjectsByGezel, setActiveProjectsByGezel] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  const [activeTurnsReady, setActiveTurnsReady] = useState(false);
  const activity = useActivity();
  const pendingByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of activity?.snapshot?.items ?? []) {
      if (item.section === 'needs-you' && item.projectId) {
        counts.set(
          item.projectId,
          (counts.get(item.projectId) ?? 0) + Math.max(1, item.questionIds.length),
        );
      }
    }
    return counts;
  }, [activity?.snapshot]);
  // Projects with a "poisoned" session — last turn aborted, awaiting a user
  // turn to clear. Durable (survives reload) so it's seeded from a real fetch,
  // not the live stream; error/complete events + a 20s reconcile keep it fresh.
  const [poisonedProjects, setPoisonedProjects] = useState<
    Map<string, { sessionId: string; gezelId: string; error: string }>
  >(new Map());
  // sessionId → gezel/project address for every turn currently mid-flight.
  // Recomputed into navigation-friendly indexes only when turn membership
  // changes, so a burst of `delta` events doesn't thrash the sidebar.
  const activeSessionsRef = useRef<Map<string, ActiveTurnAddress>>(new Map());
  const recomputeActiveTurns = useCallback(() => {
    const next = new Set<string>();
    const nextByGezel = new Map<string, Set<string>>();
    for (const turn of activeSessionsRef.current.values()) {
      next.add(turn.projectId);
      const projects = nextByGezel.get(turn.gezelId) ?? new Set<string>();
      projects.add(turn.projectId);
      nextByGezel.set(turn.gezelId, projects);
    }
    setActiveProjectIds((prev) => {
      if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
      return next;
    });
    setActiveProjectsByGezel((prev) => {
      const unchanged =
        prev.size === nextByGezel.size &&
        [...prev].every(([gezelId, projectIds]) => {
          const nextProjectIds = nextByGezel.get(gezelId);
          return (
            nextProjectIds !== undefined &&
            projectIds.size === nextProjectIds.size &&
            [...projectIds].every((projectId) => nextProjectIds.has(projectId))
          );
        });
      return unchanged ? prev : nextByGezel;
    });
  }, []);
  const activeGezelIds = useMemo(
    () => new Set(activeProjectsByGezel.keys()),
    [activeProjectsByGezel],
  );
  const [engagementMode, setEngagementMode] = useState<EngagementMode>('proactive');
  const [nightShift, setNightShift] = useState<{
    active: boolean;
    source: 'scheduled' | 'manual' | null;
  }>({ active: false, source: null });
  // The single navigation selection. `null` = Meester home; otherwise the
  // entity / area shown in the main pane (routed by TabContent). Persisted
  // to localStorage so the last view is restored on boot.
  const [selection, setSelection] = useState<RecentTab | null>(() => readStoredSelection());
  // Ref mirror so long-lived window-event listeners can read the latest
  // selection without re-subscribing.
  const selectionRef = useRef<RecentTab | null>(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  // The titlebar's status cluster grows with the number of busy engines and
  // queued chats, and `.app-header-right` never shrinks — so the pills shed
  // words instead of running off the bar. One density for the whole cluster,
  // measured here and shared through context. See components/header-density.ts.
  const headerRef = useRef<HTMLElement | null>(null);
  const headerClusterRef = useRef<HTMLDivElement | null>(null);
  const headerDensity = useHeaderDensityMeasurement(headerRef, headerClusterRef);

  // ProjectOutputPane reports its local maximize state through a window
  // event so the persistent titlebar can provide the restore affordance
  // that the pane's covered toolbar cannot. This avoids threading a UI-only
  // callback through TabContent and every project-view layer in between.
  useEffect(() => {
    const onMaximizedChange = (event: Event) => {
      const detail = (event as CustomEvent<{ maximized?: boolean }>).detail;
      setOutputPaneMaximized(detail?.maximized === true);
    };
    window.addEventListener(OUTPUT_PANE_MAXIMIZED_EVENT, onMaximizedChange);
    return () => window.removeEventListener(OUTPUT_PANE_MAXIMIZED_EVENT, onMaximizedChange);
  }, []);
  const commitSelection = useCallback((next: RecentTab | null) => {
    // Any navigation closes the first-run window. The estimate is re-run on
    // every config save, and a provider switched before its key is pasted
    // reads as "not set up" — without this, saving in Settings would throw the
    // user back to Home and clear their stored selection.
    setupOpened.current = true;
    beginNavigation(next ? tabKey(next) : 'home');
    preloadTabData(next);
    startTransition(() => setSelection(next));
    setNavigationOpen(false);
    try {
      if (next) window.localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(SELECTION_STORAGE_KEY);
    } catch {
      /* private mode / quota — selection still lives in memory */
    }
  }, []);

  useEffect(() => {
    if (!firstRun || setupOpened.current) return;
    // Setup must be visible even when compact navigation or a restored project
    // would otherwise hide Home. This is a startup affordance only: navigating
    // or saving settings closes the window below, so a later estimate cannot
    // reopen it underneath someone mid-task.
    commitSelection(null);
  }, [firstRun, commitSelection]);

  useEffect(() => {
    // Saving settings re-runs the first-run estimate, and a provider switched
    // before its key is pasted reads as "not set up". A save is by definition
    // not app startup, so it must never pull the user back to Home.
    const close = () => {
      setupOpened.current = true;
    };
    window.addEventListener('gezel:config-updated', close);
    return () => window.removeEventListener('gezel:config-updated', close);
  }, []);

  const openArea = useCallback(
    (area: RecentTabArea) => commitSelection(toRecentTab({ kind: 'area', area })),
    [commitSelection],
  );
  const preloadSelection = useCallback((next: RecentTab | null) => {
    if (next === null) void loadHomeViewModule().catch(() => {});
    else preloadTabContent(next);
  }, []);
  const openModelBundleSettings = useCallback(
    (engine: 'llama-cpp' | 'mlx' | 'ds4') => {
      requestSettingsSection(engine === 'llama-cpp' ? 'llamaCpp' : engine);
      openArea('settings');
      // Settings may already be mounted; the queued section handles the
      // mount race while this event handles the live-view case.
      window.dispatchEvent(
        new CustomEvent('gezel:navigate', {
          detail: { view: 'settings', section: engine === 'llama-cpp' ? 'llamaCpp' : engine },
        }),
      );
    },
    [openArea],
  );
  const openProviderSettings = useCallback(
    (section: 'copilot' | 'codexCli' | 'anthropicCli') => {
      requestSettingsSection(section);
      openArea('settings');
      window.dispatchEvent(
        new CustomEvent('gezel:navigate', { detail: { view: 'settings', section } }),
      );
    },
    [openArea],
  );

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        setEngagementMode((cfg.aiEngagementMode ?? 'proactive') as EngagementMode);
      })
      .catch(() => {});
    if (runtimeCapabilities().background)
      api
        .getNightShiftStatus()
        .then(setNightShift)
        .catch(() => {});
    // Reconcile the local theme cache against the server-side pref —
    // localStorage strands itself across Electron's ephemeral-port
    // shuffle, so the gezel config is the cross-boot source of truth.
    void syncThemeFromConfig();
    void syncSidebarSideFromConfig();
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | {
            aiEngagementMode?: string;
            showSystemTray?: boolean;
            quitOnClose?: boolean;
            securityPolicy?: SecurityPolicy;
            ambientDisplay?: { applyWallpaper?: boolean };
          }
        | undefined;
      if (detail?.aiEngagementMode) {
        setEngagementMode(detail.aiEngagementMode as EngagementMode);
      }
      // Keep the desktop system tray in sync with any config change made
      // in-app (engagement mode, tray on/off). No-op in the browser/webview.
      if (detail) {
        window.__GEZEL__?.syncConfig?.({
          aiEngagementMode: detail.aiEngagementMode as
            | 'proactive'
            | 'scheduled'
            | 'reactive'
            | 'off'
            | undefined,
          showSystemTray: detail.showSystemTray,
          quitOnClose: detail.quitOnClose,
          securityPolicy: detail.securityPolicy,
          ambientDisplay: detail.ambientDisplay,
        });
      }
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    // Reflect mode changes made from the tray menu back into the UI by
    // re-dispatching the same event the in-app menus fire.
    window.__GEZEL__?.onEngagementModeChanged?.((mode) => {
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', { detail: { aiEngagementMode: mode } }),
      );
    });
    return () => window.removeEventListener('gezel:config-updated', onConfigUpdated);
  }, []);

  // The unified open-tab event: listing views, chat surfaces, and the
  // task panel dispatch this to navigate. We treat it as "select this
  // entity / area". The legacy `activate: false` variant
  // (record-in-MRU-without-focus) is a no-op now that there's no MRU.
  useEffect(() => {
    const onOpenTab = (e: Event) => {
      const detail = (e as CustomEvent<RecentTabInput & { activate?: boolean }>).detail;
      if (!detail?.kind) return;
      if (detail.activate === false) return;
      commitSelection(toRecentTab(detail));
    };
    window.addEventListener('gezel:open-tab', onOpenTab);
    return () => window.removeEventListener('gezel:open-tab', onOpenTab);
  }, [commitSelection]);

  // Gezel deletion → if that gezel occupies the main pane, return to the
  // Meester home. The same event refreshes roster surfaces independently.
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const detail = (e as CustomEvent<{ gezelId?: string }>).detail;
      if (!detail?.gezelId) return;
      const sel = selectionRef.current;
      if (sel?.kind === 'gezel' && sel.id === detail.gezelId) commitSelection(null);
    };
    window.addEventListener('gezel:gezel-deleted', onDeleted);
    return () => window.removeEventListener('gezel:gezel-deleted', onDeleted);
  }, [commitSelection]);

  // Project deletion → if the deleted project occupies the main pane,
  // return to the Meester home. Without clearing the persisted selection,
  // ProjectDetailView keeps trying to load an id that no longer exists.
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId) return;
      const sel = selectionRef.current;
      if (sel?.kind === 'project' && sel.id === detail.projectId) commitSelection(null);
    };
    window.addEventListener('gezel:project-deleted', onDeleted);
    return () => window.removeEventListener('gezel:project-deleted', onDeleted);
  }, [commitSelection]);

  // Document deletion → if the deleted doc (or a folder containing it) is
  // the current selection, fall back to Meester home. The Sidebar refreshes
  // its own document list.
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (!detail?.path) return;
      const sel = selectionRef.current;
      if (
        sel?.kind === 'document' &&
        (sel.path === detail.path || sel.path.startsWith(`${detail.path}/`))
      ) {
        commitSelection(null);
      }
    };
    window.addEventListener('gezel:document-deleted', onDeleted);
    return () => window.removeEventListener('gezel:document-deleted', onDeleted);
  }, [commitSelection]);

  // Document rename → keep a directly-open document (or a document inside a
  // renamed folder) attached to its new path instead of leaving a stale tab.
  useEffect(() => {
    const onRenamed = (e: Event) => {
      const detail = (e as CustomEvent<{ fromPath?: string; toPath?: string }>).detail;
      if (!detail?.fromPath || !detail.toPath) return;
      const sel = selectionRef.current;
      if (
        sel?.kind === 'document' &&
        (sel.path === detail.fromPath || sel.path.startsWith(`${detail.fromPath}/`))
      ) {
        commitSelection({
          ...sel,
          path: `${detail.toPath}${sel.path.slice(detail.fromPath.length)}`,
        });
      }
    };
    window.addEventListener('gezel:document-renamed', onRenamed);
    return () => window.removeEventListener('gezel:document-renamed', onRenamed);
  }, [commitSelection]);

  // Global search shortcuts: ⌘P / Ctrl+P → quick-open (names/files),
  // ⌘K / Ctrl+K → full unified search. Both focus the titlebar box via
  // `gezel:focus-search`; TitlebarSearch owns the rest. Kept here so App
  // stays ignorant of the search internals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'p') {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent('gezel:focus-search', { detail: { mode: 'quick-open' } }),
        );
      } else if (key === 'k') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('gezel:focus-search', { detail: { mode: 'search' } }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshUsage = useCallback(() => {
    if (!runtimeCapabilities().daemonSettings) return;
    // A fresh object every 10 s re-renders the whole tree, active view
    // included, even when nothing moved.
    api
      .getUsage()
      .then((next) =>
        setUsage((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshUsage();
    const interval = setVisibleInterval(refreshUsage, 10_000);
    return () => interval();
  }, [refreshUsage]);

  // Seed the mid-turn set from every in-flight turn (each tagged with its
  // projectId), and re-sync on an interval to self-heal any missed `done`.
  const reconcileActiveProjects = useCallback(() => {
    api
      .listInflightTurns()
      .then(({ inflight }) => {
        const m = new Map<string, ActiveTurnAddress>();
        for (const t of inflight) {
          m.set(t.sessionId, { projectId: t.projectId, gezelId: t.gezelId });
        }
        activeSessionsRef.current = m;
        recomputeActiveTurns();
        setActiveTurnsReady(true);
      })
      .catch(() => setActiveTurnsReady(true));
  }, [recomputeActiveTurns]);
  const refreshPoisoned = useCallback(() => {
    api
      .listPoisonedProjects()
      .then(({ poisoned }) => {
        const m = new Map<string, { sessionId: string; gezelId: string; error: string }>();
        for (const p of poisoned)
          m.set(p.projectId, { sessionId: p.sessionId, gezelId: p.gezelId, error: p.error });
        setPoisonedProjects((prev) =>
          JSON.stringify([...prev]) === JSON.stringify([...m]) ? prev : m,
        );
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    reconcileActiveProjects();
    refreshPoisoned();
    const t = setVisibleInterval(() => {
      reconcileActiveProjects();
      refreshPoisoned();
    }, 20_000);
    return () => t();
  }, [reconcileActiveProjects, refreshPoisoned]);
  // A chat banner cleared a session's error — re-check the sidebar indicator.
  useEffect(() => {
    const onCleared = () => refreshPoisoned();
    window.addEventListener('gezel:session-error-cleared', onCleared);
    return () => window.removeEventListener('gezel:session-error-cleared', onCleared);
  }, [refreshPoisoned]);
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          // Keep the sidebar "thinking" set live: a turn opens on user_message
          // and closes on done/error/cancelled. Mount seed + 20s reconcile cover turns we
          // joined mid-flight.
          if (ev.type === 'user_message') {
            activeSessionsRef.current.set(env.sessionId, {
              projectId: env.projectId,
              gezelId: env.gezelId,
            });
            recomputeActiveTurns();
          } else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
            if (activeSessionsRef.current.delete(env.sessionId)) recomputeActiveTurns();
          }
          // Poisoned tracking: a failed turn poisons the session (optimistic
          // paint now, since the persisted lastTurnError lands a beat later);
          // a successful turn's `complete` may clear it. Reconcile authoritatively.
          if (ev.type === 'error') {
            setPoisonedProjects((prev) => {
              const m = new Map(prev);
              m.set(env.projectId, {
                sessionId: env.sessionId,
                gezelId: env.gezelId,
                error: ev.error,
              });
              return m;
            });
            refreshPoisoned();
          } else if (ev.type === 'complete') {
            refreshPoisoned();
          }
          // Night Shift flipped on/off (scheduled window, drain, or a
          // manual shift) — reflect it in the header pill + menu live.
          if (ev.type === 'night_shift') {
            setNightShift({ active: ev.active, source: ev.source });
          }
          // A project was created anywhere (New Project dialog, or a
          // `start_project` macro a gezel ran mid-chat). Re-broadcast as
          // a window event the sidebar refreshes on, so the PROJECTS
          // list folds it in live instead of after the next tab-focus
          // poll.
          if (ev.type === 'project_created') {
            window.dispatchEvent(
              new CustomEvent('gezel:project-created', {
                detail: { id: ev.projectId, name: ev.name },
              }),
            );
          }
          // A project was deleted anywhere (the Project Actions menu, or a
          // gezel via the API). Re-broadcast so the sidebar + Projects rail
          // drop the row without waiting for a manual refresh.
          if (ev.type === 'project_deleted') {
            window.dispatchEvent(
              new CustomEvent('gezel:project-deleted', {
                detail: { projectId: ev.projectId, name: ev.name },
              }),
            );
          }
          // A shared gezel was recruited anywhere — most importantly via
          // `ensure_gezel` during a live project turn. Reuse the roster-change
          // event already consumed by the sidebar + Gezellen screen.
          if (ev.type === 'gezel_created') {
            window.dispatchEvent(
              new CustomEvent('gezel:gezel-updated', {
                detail: { id: ev.gezelId, name: ev.name },
              }),
            );
          }
          // Level-ups and recomputed XP reload the growth surfaces. OS
          // notifications are not raised here: Electron's main process and
          // the phone's host notifier own them (core `notifications`).
          if (ev.type === 'growth_updated') {
            window.dispatchEvent(
              new CustomEvent('gezel:growth-updated', { detail: { gezelId: ev.gezelId } }),
            );
          }
          if (ev.type === 'growth_level_up') {
            window.dispatchEvent(
              new CustomEvent('gezel:growth-updated', { detail: { gezelId: ev.gezelId } }),
            );
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return () => ctrl.abort();
  }, [recomputeActiveTurns, refreshPoisoned]);

  useEffect(() => {
    const platform = window.__GEZEL__?.platform;
    if (platform) document.documentElement.setAttribute('data-platform', platform);
  }, []);

  useEffect(() => {
    const route = (v: string) => {
      // Legacy deep links to the removed Chat view route to Home (where
      // the Meester chat now lives).
      if (v === 'chat' || v === 'home') {
        commitSelection(null);
        return;
      }
      // The File menu's Add Folder…, and a folder opened from the Dock.
      if (v === 'add-folder' || v.startsWith('add-folder:')) {
        const path = v.slice('add-folder:'.length);
        openAddFolder(v === 'add-folder' ? undefined : path);
        return;
      }
      if ((AREA_NAMES as string[]).includes(v)) {
        openArea(v as RecentTabArea);
      }
    };
    window.__GEZEL__?.onNavigate?.(route);
    const onCustomNavigate = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: string }>).detail;
      if (detail?.view) route(detail.view);
    };
    window.addEventListener('gezel:navigate', onCustomNavigate);
    return () => window.removeEventListener('gezel:navigate', onCustomNavigate);
  }, [openArea, commitSelection]);

  return (
    <div className={`app${compact ? ' app-compact' : ''}${preview ? ' app-mobile-preview' : ''}`}>
      {/* Global consent dialog for /v1/apps/register. Mounts here so a
          pending grant can surface from any view without the user having
          to navigate to Settings → Connected Apps. */}
      {runtimeCapabilities().connections && <GrantConsentDialog />}
      {runtimeCapabilities().daemonSettings && <MacUninstallDialog />}
      {runtimeCapabilities().daemonSettings && <StorageCleanupDialog />}
      {runtimeCapabilities().backups && <BackupRestoreDialog />}
      {runtimeCapabilities().daemonSettings && (
        <ModelBundleImportController onEngineIdentified={openModelBundleSettings} />
      )}
      {/* The top bar remains the OS title bar (drag region + native
          window-control reservations via CSS padding). The brand mark routes
          to the Meester home. Compact layouts trade it for the navigation
          button instead of spending a separate content row: the navigation
          leads with Home, so the brand would be a second key for one place. */}
      <HeaderDensityContext.Provider value={headerDensity}>
        <header ref={headerRef} className="app-header" data-testid="app-header">
          {/* Leads the bar, where a phone's menu button sits, and stays while
              the navigation is open so the keys beside it never shift. */}
          {compact && (
            <button
              type="button"
              className="app-header-navigation"
              onClick={toggleNavigation}
              aria-label="Navigation"
              aria-pressed={navigationOpen}
              title="Navigation"
            >
              <NavigationMenuIcon />
            </button>
          )}
          {!compact && (
            <AppBrand active={selection === null} onClick={() => commitSelection(null)} />
          )}
          {/* Unified search is anchored near the brand so changing status-pill
            widths do not recenter it. It stays shrinkable in the flex row, so
            crowded titlebars still give the pills room without overlap — and
            because only its right edge moves when it shrinks, the results
            palette hangs off its left edge (`align="start"`) and holds still
            while the pills breathe. */}
          {runtimeCapabilities().search && (
            <>
              <TitlebarSearch compact={compact} />
              <SearchResultsOverlay />
            </>
          )}
          {/* The empty stretch between the brand and the status cluster is the
            primary OS drag target — `.app-header-right`'s `margin-left: auto`
            pushes the pills right, leaving the remaining gap (and the
            reserved window-control padding) as draggable titlebar. */}
          <div className="app-header-right" ref={headerClusterRef}>
            <NarrationStopButton />
            {/* First run is a conversation with the meester, and the welcome
              already shows the one download in flight. Activity, engine,
              quota, indexing and tempo controls describe a running workshop
              (on a fresh install Activity counted the scheduled Night Shift
              oversight as "1 waiting"), so they join once there is one. */}
            {!firstRun &&
              (runtimeCapabilities().engineStatus || runtimeCapabilities().structuredQuestions) && (
                <ActivityControl />
              )}
            {!firstRun && runtimeCapabilities().daemonSettings && <BoekwachterPill />}
            {!firstRun && runtimeCapabilities().engineStatus && <EngineStatusPill />}
            {!firstRun && runtimeCapabilities().daemonSettings && (
              <>
                <ClaudeCliPoolPill />
                <QuotaMeters usage={usage} onOpenSettings={openProviderSettings} />
                <TaskSpeedMenu
                  mode={engagementMode}
                  nightShift={nightShift}
                  onNightShiftChange={setNightShift}
                />
              </>
            )}
            {outputPaneMaximized && (
              <button
                type="button"
                className="app-output-restore"
                onClick={requestOutputPaneRestore}
                title="Restore output pane (F5)"
                aria-label="Restore output pane"
              >
                <OutputPaneRestoreIcon />
              </button>
            )}
          </div>
        </header>
      </HeaderDensityContext.Provider>
      {compact && (outputPaneMaximized || preview) && (
        <div className="app-compact-navigation">
          {outputPaneMaximized && (
            <button
              type="button"
              onClick={requestOutputPaneRestore}
              aria-label="Restore output pane"
            >
              Restore workspace
            </button>
          )}
          {preview && (
            <button type="button" onClick={exitPreview}>
              Exit mobile preview
            </button>
          )}
        </div>
      )}
      <FirstRunProvider value={firstRun}>
        <ResponsiveAppShell
          compact={compact}
          navigationOpen={navigationOpen}
          navigation={
            <Sidebar
              compact={compact}
              selection={selection}
              onSelect={commitSelection}
              onOpenArea={openArea}
              onPreload={preloadSelection}
              activeProjectIds={activeProjectIds}
              activeGezelIds={activeGezelIds}
              pendingByProject={pendingByProject}
              poisonedProjects={poisonedProjects}
            />
          }
        >
          <Suspense fallback={null}>
            {selection === null ? (
              <HomeView
                platform={window.__GEZEL__?.platform}
                onNavigate={(v) => {
                  if (v === 'home') commitSelection(null);
                  else openArea(v);
                }}
              />
            ) : (
              <TabErrorBoundary key={tabKey(selection)} resetKey={tabKey(selection)}>
                <TabContent
                  tab={selection}
                  activeProjectsByGezel={activeProjectsByGezel}
                  activeTurnsReady={activeTurnsReady}
                />
              </TabErrorBoundary>
            )}
          </Suspense>
        </ResponsiveAppShell>
      </FirstRunProvider>
    </div>
  );
}

function OutputPaneRestoreIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.5 6.5H9.5V3.5" />
      <path d="M9.5 6.5 12.8 3.2" />
      <path d="M3.5 9.5H6.5V12.5" />
      <path d="M6.5 9.5 3.2 12.8" />
    </svg>
  );
}

function NavigationMenuIcon() {
  return (
    <svg
      className="app-header-navigation-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 5.25h14M3 10h14M3 14.75h14" />
    </svg>
  );
}

type NightShiftState = { active: boolean; source: 'scheduled' | 'manual' | null };

function NightShiftGlyph({ active }: { active: boolean }) {
  return (
    <svg
      className="app-nightshift-glyph"
      width="24"
      height="18"
      viewBox="0 0 32 24"
      fill="currentColor"
      aria-hidden="true"
    >
      {active && (
        <g className="app-nightshift-cloud app-nightshift-cloud-far">
          <g transform="translate(0 -4) scale(.74)">
            <path d="M1 17h10.4a2 2 0 0 0 .1-4 3.2 3.2 0 0 0-6.15-1.1A2.5 2.5 0 0 0 1 13.4 1.8 1.8 0 0 0 1 17Z" />
          </g>
        </g>
      )}
      <path
        className={`app-nightshift-moon${active ? ' is-active' : ''}`}
        transform="translate(4 0)"
        d={NIGHT_SHIFT_MOON_PATH}
      />
      {active && (
        <g className="app-nightshift-cloud app-nightshift-cloud-near">
          <path d="M1 17h10.4a2 2 0 0 0 .1-4 3.2 3.2 0 0 0-6.15-1.1A2.5 2.5 0 0 0 1 13.4 1.8 1.8 0 0 0 1 17Z" />
        </g>
      )}
    </svg>
  );
}

/**
 * The titlebar's task-speed control. Engagement mode and Night Shift are
 * independent settings presented in one menu: the mode remains latched while
 * the shift runs, and the animated moon temporarily becomes the trigger icon.
 */
function TaskSpeedMenu({
  mode: savedMode,
  nightShift: state,
  onNightShiftChange: onChange,
}: {
  mode: EngagementMode;
  nightShift: NightShiftState;
  onNightShiftChange: (s: NightShiftState) => void;
}) {
  // The menu stays open after a pick, so show it at once rather than after
  // the config save round-trips; a failed save falls back to the saved mode.
  const [picked, setPicked] = useState<EngagementMode | null>(null);
  const mode = picked ?? savedMode;
  useEffect(() => {
    setPicked((was) => (was === savedMode ? null : was));
  }, [savedMode]);
  const current = ENGAGEMENT_MODES.find((o) => o.mode === mode) ?? ENGAGEMENT_MODES[0]!;
  const title = state.active
    ? `Crew activity: ${current.label}. Night Shift running. Click to change.`
    : `Crew activity: ${current.label}. Click to change.`;

  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<NightShiftTasksResponse | null>(null);
  const [review, setReview] = useState<NightShiftReviewResponse | null>(null);
  const [status, setStatus] = useState<NightShiftStatusResponse | null>(null);
  const [tally, setTally] = useState<NightShiftTallyResponse | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) window.dispatchEvent(new CustomEvent('gezel:close-header-popovers'));
  };

  const handleModeSelect = (next: EngagementMode) => {
    if (next !== mode) {
      setPicked(next === savedMode ? null : next);
      void api
        .updateConfig({ aiEngagementMode: next })
        .then((res) => {
          window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        })
        .catch(() => {
          // Back to the saved mode; the user can retry.
          setPicked((was) => (was === next ? null : was));
        });
    }

    // Reactive and Off cannot leave unattended work running. Keep mode and
    // shift orthogonal for every other transition, including Tasks/Proactive.
    if (state.active && (next === 'reactive' || next === 'off')) {
      void api
        .setNightShiftManual('stop')
        .then(onChange)
        .catch(() => {
          /* the SSE event remains the source of truth */
        });
    }
  };

  // "Done last night" — fetched on open regardless of active state, so the
  // menu answers the morning-after question, not just the live one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .getNightShiftReview()
      .then((r) => {
        if (!cancelled) setReview(r);
      })
      .catch(() => {
        /* the menu still shows status + actions */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Opened from elsewhere — the queue popover's scheduled-work section
  // sends the user here rather than explaining the shift twice.
  useEffect(() => {
    const openMenu = () => setOpen(true);
    window.addEventListener('gezel:open-night-shift', openMenu);
    return () => window.removeEventListener('gezel:open-night-shift', openMenu);
  }, []);

  // While the menu is open, surface what the shift is working on — or, when
  // it isn't running, what is already queued up for tonight. Answering that
  // during the day is the point: work parked for the night window is
  // deliberately absent from the header queue, so this is where the user
  // confirms it's accounted for. Poll lightly so the active/upcoming split
  // tracks progress as tasks finish and the next one picks up.
  useEffect(() => {
    if (!open) {
      setTasks(null);
      setStatus(null);
      setTally(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .getNightShiftTasks()
        .then((t) => {
          if (!cancelled) setTasks(t);
        })
        .catch(() => {
          /* swallow — the menu still shows the status + action */
        });
      // The quota-hold detail and the window bounds ride the same poll: one
      // explains why queued work isn't moving, the other counts down to the
      // window's close, and both should track the same refresh cadence.
      api
        .getNightShiftStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          /* swallow — the pill's SSE state remains the on/off truth */
        });
      // Counted work for the period. Service-side memo absorbs this cadence.
      api
        .getNightShiftTally()
        .then((t) => {
          if (!cancelled) setTally(t);
        })
        .catch(() => {
          /* swallow — an unavailable tally just hides its block */
        });
    };
    load();
    const id = setVisibleInterval(load, 5_000);
    return () => {
      cancelled = true;
      id();
    };
  }, [open]);

  const run = (action: 'start' | 'stop') => {
    void api
      .setNightShiftManual(action)
      .then(onChange)
      .catch(() => {
        /* swallow — the SSE event is the source of truth; pill stays put */
      });
  };

  const backgroundWork = tasks?.background ?? [];
  const hasWork =
    tasks !== null &&
    (backgroundWork.length > 0 || tasks.active.length > 0 || tasks.upcoming.length > 0);
  const tallyItems = tally ? nightShiftTallyItems(tally) : [];
  // The review reports on a window that may still be running — calling that
  // "last night" at 2am, directly under a live tally, reads as a different
  // night's work when it is in fact tonight's.
  const reviewHeading =
    review && Date.parse(review.windowEnd) > Date.now() ? 'Finished so far' : 'Done last night';
  const paused = mode === 'reactive' || mode === 'off';
  const lastNight =
    review && Date.parse(review.windowEnd) <= Date.now()
      ? {
          tasks: review.tasksCompleted.length,
          reports: review.reports.length,
          questions: tally && !tally.live ? tally.questionsRaised : 0,
        }
      : null;
  const summary = nightShiftSummary(state, status, mode, lastNight);

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`app-engagement-trigger app-engagement-trigger-${mode}${state.active ? ' app-engagement-trigger-nightshift' : ''}`}
          aria-label={title}
          title={title}
        >
          {state.active ? <NightShiftGlyph active /> : <EngagementModeIcon mode={mode} />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="app-nav-menu app-task-speed-menu"
          sideOffset={4}
          align="end"
        >
          <EngagementModeMenu mode={mode} onSelect={handleModeSelect} />
          <DropdownMenu.Separator className="app-task-speed-separator" />
          <div className="app-nightshift">
            <div className="app-nightshift-head">
              <span
                className={`app-nightshift-sky${state.active ? ' is-live' : ''}`}
                aria-hidden="true"
              >
                <NightShiftMoonGlyph />
              </span>
              <div className="app-nightshift-heading">
                <DropdownMenu.Label className="app-nightshift-title">
                  Night Shift
                </DropdownMenu.Label>
                <span className="app-nightshift-line">{summary.line}</span>
              </div>
              {summary.badge && (
                <span className={`app-nightshift-badge is-${summary.badge.tone}`}>
                  {summary.badge.tone === 'live' && (
                    <span className="app-nightshift-badge-dot" aria-hidden="true" />
                  )}
                  {summary.badge.text}
                </span>
              )}
            </div>
            {status?.quotaHold && (
              <p className="app-nightshift-note">{quotaHoldLine(status.quotaHold)}</p>
            )}
            {summary.track && (
              <div className="app-nightshift-track">
                <div className="app-nightshift-track-bar" aria-hidden="true">
                  {summary.track.progress > 0 && (
                    <>
                      <span
                        className="app-nightshift-track-fill"
                        style={{ width: `${summary.track.progress * 100}%` }}
                      />
                      <span
                        className="app-nightshift-track-now"
                        style={{ left: `${summary.track.progress * 100}%` }}
                      />
                    </>
                  )}
                </div>
                <div className="app-nightshift-track-ticks">
                  <span>{summary.track.start}</span>
                  <span>{summary.track.end}</span>
                </div>
              </div>
            )}
            {tallyItems.length > 0 && tally && (
              <div className="app-nightshift-group">
                <div className="app-nightshift-task-heading">
                  {tally.live ? 'So far this shift' : 'Last night'}
                </div>
                <div className="app-nightshift-tally-items">
                  {tallyItems.map((item) => (
                    <span className="app-nightshift-tally-item" key={item.key}>
                      <span className="app-nightshift-tally-count">
                        {item.count.toLocaleString()}
                      </span>{' '}
                      {item.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {hasWork && tasks && (backgroundWork.length > 0 || tasks.active.length > 0) && (
              <div className="app-nightshift-group">
                <div className="app-nightshift-task-heading">Working on</div>
                {backgroundWork.map((work) => (
                  <NightShiftWorkRow
                    key={work.id}
                    title={work.title}
                    meta={[work.projectName, work.detail].filter(Boolean).join(' · ')}
                    active
                  />
                ))}
                {tasks.active.map((t) => (
                  <NightShiftTaskRow key={t.ref} task={t} active />
                ))}
              </div>
            )}
            {hasWork && tasks && tasks.upcoming.length > 0 && (
              <div className="app-nightshift-group">
                <div className="app-nightshift-task-heading">
                  {paused ? 'Waiting' : state.active ? 'Up next' : 'Queued for tonight'}
                </div>
                {tasks.upcoming.map((t) => (
                  <NightShiftTaskRow key={t.ref} task={t} />
                ))}
              </div>
            )}
            {state.active && tasks !== null && !hasWork && (
              <div className="app-nightshift-empty">No work is running or queued.</div>
            )}
            {review && (review.tasksCompleted.length > 0 || review.reports.length > 0) && (
              <div className="app-nightshift-group">
                <div className="app-nightshift-task-heading">{reviewHeading}</div>
                {review.reports.map((r) => (
                  <DropdownMenu.Item
                    key={`${r.projectId}:${r.path}`}
                    className="app-nightshift-task app-nightshift-report"
                    onSelect={() =>
                      runNavActions(
                        openProjectFileActions({
                          projectId: r.projectId,
                          path: r.path,
                          source: 'artifacts',
                        }),
                      )
                    }
                  >
                    <span className="app-nightshift-task-dot is-done" aria-hidden="true" />
                    <span className="app-nightshift-task-text">
                      <span className="app-nightshift-task-title">{r.title}</span>
                      <span className="app-nightshift-task-meta">
                        {r.projectName}
                        {r.actionCounts.total > 0
                          ? ` · ${r.actionCounts.suggested > 0 ? `${r.actionCounts.suggested} action${r.actionCounts.suggested === 1 ? '' : 's'} to review` : `${r.actionCounts.total} action${r.actionCounts.total === 1 ? '' : 's'}`}`
                          : ''}
                      </span>
                    </span>
                  </DropdownMenu.Item>
                ))}
                {review.tasksCompleted.slice(0, 5).map((t) => (
                  <DropdownMenu.Item
                    key={t.ref}
                    className="app-nightshift-task app-nightshift-report"
                    onSelect={() => navigateToTab({ kind: 'task', ref: t.ref })}
                  >
                    <span className="app-nightshift-task-dot is-done" aria-hidden="true" />
                    <span className="app-nightshift-task-text">
                      <span className="app-nightshift-task-title">{t.title}</span>
                      <span className="app-nightshift-task-meta">{t.projectName}</span>
                    </span>
                  </DropdownMenu.Item>
                ))}
              </div>
            )}
          </div>
          {summary.action && (
            <div className="app-nightshift-action-tray gz-tray" role="presentation">
              <DropdownMenu.Item
                className="app-nav-menu-item app-nightshift-action gz-key gz-key--stacked"
                onSelect={() => run(summary.action!.run)}
              >
                <span className="app-engagement-menu-label">{summary.action.label}</span>
                <span className="app-engagement-menu-hint">{summary.action.hint}</span>
              </DropdownMenu.Item>
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One task row in the Night Shift menu's "working on" / "up next" lists. */
function NightShiftTaskRow({
  task,
  active = false,
}: {
  task: NightShiftTasksResponse['active'][number];
  active?: boolean;
}) {
  const base = task.stepName ? `${task.projectName} · ${task.stepName}` : task.projectName;
  const meta = task.quotaHeld ? `${base} · waiting for quota` : base;
  const report = task.latestReport;
  return (
    <DropdownMenu.Item
      className="app-nightshift-report"
      title={report ? 'Open latest report' : 'View task details'}
      onSelect={() => {
        if (report) {
          runNavActions(openProjectFileActions({ ...report, source: 'artifacts' }));
        } else {
          navigateToTab({ kind: 'task', ref: task.ref });
        }
      }}
    >
      <NightShiftWorkRow title={task.title} meta={meta} active={active} />
    </DropdownMenu.Item>
  );
}

interface NightShiftSummary {
  line: string;
  badge: { text: string; tone: 'idle' | 'live' | 'held' | 'paused' } | null;
  /** The window drawn as a track, with the share of it already behind us. */
  track: { start: string; end: string; progress: number } | null;
  action: { run: 'start' | 'stop'; label: string; hint: string } | null;
}

/** Last night's finished work, for the line shown the morning after. */
interface LastNight {
  tasks: number;
  reports: number;
  questions: number;
}

/**
 * Everything the Night Shift section says, decided in one place.
 *
 * Chat only and Off hold every task, so a shift there would do nothing: the
 * section says so and offers no Start key. A scheduled shift is bounded by
 * its window, so it can promise a close; a manual one runs until its work
 * drains, whatever the clock says, so it promises none.
 */
function nightShiftSummary(
  state: NightShiftState,
  status: NightShiftStatusResponse | null,
  mode: EngagementMode,
  lastNight: LastNight | null,
): NightShiftSummary {
  const window = status?.window ?? null;
  const start = window ? formatClock(window.start) : null;
  const end = window ? formatClock(window.end) : null;
  const ticks = start && end ? { start, end } : null;
  const running = { text: 'Running', tone: 'live' } as const;
  const stop =
    state.source === 'manual'
      ? {
          run: 'stop' as const,
          label: 'Stop the Night Shift',
          hint: start ? `The ${start} schedule carries on.` : 'It stops now.',
        }
      : {
          run: 'stop' as const,
          label: 'Stop for tonight',
          hint: start ? `It starts again tomorrow at ${start}.` : 'It starts again next window.',
        };

  if (mode === 'reactive' || mode === 'off') {
    return {
      line:
        mode === 'off'
          ? 'Off pauses everything, so the Night Shift waits.'
          : 'Chat only pauses task work, so the Night Shift waits.',
      badge: { text: 'Paused', tone: 'paused' },
      track: null,
      action: state.active ? stop : null,
    };
  }

  if (state.active) {
    if (state.source !== 'manual' && window?.open && ticks) {
      const left = formatTimeLeft(Date.parse(window.end) - Date.now());
      return {
        line: left ? `Ends at ${ticks.end}, ${left} from now.` : `Ends at ${ticks.end}.`,
        badge: running,
        track: { ...ticks, progress: windowProgress(window) },
        action: stop,
      };
    }
    const started = status?.startedAt ? formatClock(status.startedAt) : null;
    const who = state.source === 'manual' ? 'You started it' : 'Started';
    return {
      line: started
        ? `${who} at ${started}. It stops when the queue is empty.`
        : 'It stops when the queue is empty.',
      badge: running,
      track: null,
      action: stop,
    };
  }

  if (status?.heldOnBattery) {
    return {
      line: 'Waiting while this computer runs on battery. It picks up when you plug in.',
      badge: { text: 'On hold', tone: 'held' },
      track: ticks && { ...ticks, progress: 0 },
      action: null,
    };
  }

  const startNow = {
    run: 'start' as const,
    label: 'Start the Night Shift now',
    hint:
      window && !window.open && start
        ? `Instead of waiting until ${start}.`
        : 'Your gezellen work through the queue now.',
  };
  if (!window) {
    return {
      line: lastNightLine(lastNight) ?? 'No nightly schedule is set. Start it when you step away.',
      badge: null,
      track: null,
      action: startNow,
    };
  }
  if (window.open) {
    return {
      line: end ? `Not running. Tonight's window closes at ${end}.` : 'Not running tonight.',
      badge: { text: 'Idle', tone: 'idle' },
      track: ticks && { ...ticks, progress: 0 },
      action: startNow,
    };
  }
  return {
    line:
      lastNightLine(lastNight) ??
      (start
        ? `Your gezellen work through the queue from ${start}.`
        : 'Your gezellen work through the queue overnight.'),
    badge: { text: nightWord(window.start), tone: 'idle' },
    track: ticks && { ...ticks, progress: 0 },
    action: startNow,
  };
}

function lastNightLine(night: LastNight | null): string | null {
  if (!night || (night.tasks === 0 && night.reports === 0)) return null;
  const did =
    night.tasks > 0
      ? `finished ${night.tasks} task${night.tasks === 1 ? '' : 's'}`
      : `wrote ${night.reports} report${night.reports === 1 ? '' : 's'}`;
  const ask =
    night.questions === 0
      ? ''
      : night.questions === 1
        ? ' One question is waiting for you.'
        : ` ${night.questions} questions are waiting for you.`;
  return `Last night your gezellen ${did}.${ask}`;
}

/** "Tonight", "Tomorrow", or the weekday a window opens on. */
function nightWord(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Tonight';
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(new Date())) / 86_400_000);
  if (days <= 0) return 'Tonight';
  if (days === 1) return 'Tomorrow';
  return at.toLocaleDateString(undefined, { weekday: 'long' });
}

/** Share of an open window already behind us, 0 to 1. */
function windowProgress(window: { start: string; end: string }): number {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!(end > start)) return 0;
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

/** Local wall-clock time of an ISO instant, or null when unparseable. */
function formatClock(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Coarse "3h 46m" / "24m" remaining; null once the moment has passed. */
function formatTimeLeft(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The tally, as chips. Ordered by how much a person cares about the number
 * — finished work first, effort last — and zeroes are dropped rather than
 * rendered as a wall of noughts: a quiet night should read as a short list,
 * not a full grid of nothing.
 */
const NIGHT_SHIFT_TALLY_ITEMS: Array<{
  key: keyof NightShiftTallyResponse;
  one: string;
  many: string;
}> = [
  { key: 'tasksCompleted', one: 'task done', many: 'tasks done' },
  { key: 'stepsCompleted', one: 'step finished', many: 'steps finished' },
  { key: 'questionsRaised', one: 'question for you', many: 'questions for you' },
  { key: 'filesIndexed', one: 'file indexed', many: 'files indexed' },
  { key: 'filesReviewed', one: 'file reviewed', many: 'files reviewed' },
  { key: 'mediaDescribed', one: 'media file described', many: 'media files described' },
  { key: 'filesWritten', one: 'file written', many: 'files written' },
  { key: 'documentsCreated', one: 'new document', many: 'new documents' },
  { key: 'imagesRendered', one: 'image made', many: 'images made' },
  { key: 'toolCalls', one: 'tool call', many: 'tool calls' },
];

function nightShiftTallyItems(
  tally: NightShiftTallyResponse,
): Array<{ key: string; count: number; label: string }> {
  const out: Array<{ key: string; count: number; label: string }> = [];
  for (const item of NIGHT_SHIFT_TALLY_ITEMS) {
    const count = tally[item.key];
    if (typeof count !== 'number' || count <= 0) continue;
    out.push({ key: item.key, count, label: count === 1 ? item.one : item.many });
  }
  return out;
}

/**
 * One sentence for the status strip while the quota reserve is holding
 * night work. All percentages come from the server's verdict — the UI
 * never recomputes quota math (the buckets' scales have bitten before).
 */
function quotaHoldLine(hold: NonNullable<NightShiftStatusResponse['quotaHold']>): string {
  const n = hold.heldTaskCount;
  const head = `Holding ${n} task${n === 1 ? '' : 's'} to protect your quota`;
  const reason = hold.reasons[0];
  if (!reason) return `${head}.`;
  const label = QUOTA_PROVIDERS.find((p) => p.key === reason.provider)?.label ?? reason.provider;
  const bucket = humanizeBucketName(reason.bucket).toLowerCase();
  const detail = `${label} ${bucket} at ${reason.remainingPercent}% (reserve ${reason.floorPercent}%)`;
  const more = hold.reasons.length > 1 ? ` and ${hold.reasons.length - 1} more` : '';
  const resume = reason.resetDate ? ` · resumes after ${formatResetDate(reason.resetDate)}` : '';
  return `${head} — ${detail}${more}${resume}`;
}

function NightShiftWorkRow({
  title,
  meta,
  active = false,
}: {
  title: string;
  meta: string;
  active?: boolean;
}) {
  return (
    <div className="app-nightshift-task">
      <span className={`app-nightshift-task-dot${active ? ' is-active' : ''}`} aria-hidden="true" />
      <span className="app-nightshift-task-text">
        <span className="app-nightshift-task-title">{title}</span>
        <span className="app-nightshift-task-meta">{meta}</span>
      </span>
    </div>
  );
}

const QUOTA_PROVIDERS = [
  { key: 'copilot', label: 'Copilot', settingsSection: 'copilot', showTurnsFallback: true },
  { key: 'codex-cli', label: 'Codex', settingsSection: 'codexCli', showTurnsFallback: false },
  {
    key: 'anthropic-cli',
    label: 'Claude',
    settingsSection: 'anthropicCli',
    showTurnsFallback: false,
  },
] as const;

const QUOTA_ACTIVITY_POLL_MS = 3_000;

type QuotaProviderKey = (typeof QUOTA_PROVIDERS)[number]['key'];
type QuotaSettingsSection = (typeof QUOTA_PROVIDERS)[number]['settingsSection'];

function QuotaMeters({
  usage,
  onOpenSettings,
}: {
  usage: UsageResponse | null;
  onOpenSettings: (section: QuotaSettingsSection) => void;
}) {
  const [activeProviders, setActiveProviders] = useState<ReadonlySet<QuotaProviderKey>>(
    () => new Set(),
  );

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void api
        .getQueueStatus()
        .then((status) => {
          if (!mounted) return;
          const next = new Set<QuotaProviderKey>();
          for (const provider of QUOTA_PROVIDERS) {
            if ((status.providers[provider.key]?.running ?? 0) > 0) next.add(provider.key);
          }
          setActiveProviders((current) => {
            if (current.size === next.size && [...current].every((key) => next.has(key))) {
              return current;
            }
            return next;
          });
        })
        .catch(() => {});
    };

    refresh();
    const interval = setVisibleInterval(refresh, QUOTA_ACTIVITY_POLL_MS);
    return () => {
      mounted = false;
      interval();
    };
  }, []);

  if (!usage) return null;
  return (
    <>
      {QUOTA_PROVIDERS.map((provider) => {
        if (!activeProviders.has(provider.key)) return null;
        const providerUsage = usage.providers[provider.key];
        if (!providerUsage) return null;
        const limitedBuckets = providerUsage.quotaBuckets.filter((bucket) => !bucket.isUnlimited);
        if (
          limitedBuckets.length === 0 &&
          (!provider.showTurnsFallback || providerUsage.todayTurns === 0)
        ) {
          return null;
        }
        return (
          <ProviderQuotaMeter
            key={provider.key}
            providerKey={provider.key}
            label={provider.label}
            buckets={limitedBuckets}
            todayTurns={providerUsage.todayTurns}
            todayTokensIn={providerUsage.todayTokensIn}
            todayTokensCached={providerUsage.todayTokensCached ?? 0}
            todayTokensOut={providerUsage.todayTokensOut}
            onOpenSettings={() => onOpenSettings(provider.settingsSection)}
          />
        );
      })}
    </>
  );
}

function ProviderQuotaMeter({
  providerKey,
  label,
  buckets,
  todayTurns,
  todayTokensIn,
  todayTokensCached,
  todayTokensOut,
  onOpenSettings,
}: {
  providerKey: string;
  label: string;
  buckets: QuotaBucket[];
  todayTurns: number;
  todayTokensIn: number;
  todayTokensCached: number;
  todayTokensOut: number;
  onOpenSettings: () => void;
}) {
  // Clicking the pill opens the same numbers the tooltip carries, so they
  // survive a pointer leaving the pill (and exist at all for keyboard and
  // touch, which never see a `title`). Settings moves into the popover
  // rather than being the click target. Open/close mirrors
  // EngineStatusPill — the sibling pill in this header.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Cooperative dismissal with the other header popovers — a Radix trigger
  // can swallow the mousedown before it reaches the handler above.
  useEffect(() => {
    const close = (event: Event) => {
      if ((event as CustomEvent<{ source?: string }>).detail?.source === `quota-${providerKey}`)
        return;
      setOpen(false);
    };
    window.addEventListener('gezel:close-header-popovers', close);
    return () => window.removeEventListener('gezel:close-header-popovers', close);
  }, [providerKey]);

  const toggle = useCallback(() => {
    setOpen((current) => {
      if (!current) {
        window.dispatchEvent(
          new CustomEvent('gezel:close-header-popovers', {
            detail: { source: `quota-${providerKey}` },
          }),
        );
      }
      return !current;
    });
  }, [providerKey]);

  const mostConstrained = useMemo<QuotaBucket | null>(() => {
    if (buckets.length === 0) return null;
    return [...buckets].sort((a, b) => a.remainingPercent - b.remainingPercent)[0] ?? null;
  }, [buckets]);

  const tokensToValue = formatTokensWithCache(todayTokensIn, todayTokensCached);
  const tokensFromValue = formatTokenCount(todayTokensOut);

  // Copilot may have turn usage before its SDK emits the first quota event.
  // Keep its existing lightweight "today" fallback; Codex and Claude only
  // mount after a real account window arrives.
  if (!mostConstrained) {
    return (
      <div className="quota-meter-root" ref={rootRef}>
        <button
          type="button"
          className="quota-meter"
          onClick={toggle}
          aria-expanded={open}
          title={`${label}: ${todayTurns} turns today in Gezel`}
        >
          <span className="quota-label quota-label-provider">{label}</span>
          <span className="quota-label">{todayTurns} today</span>
        </button>
        {open && (
          <div className="quota-popover">
            <div className="quota-popover-header">{label} usage</div>
            <dl className="quota-popover-stats">
              <dt>Turns today in Gezel</dt>
              <dd>{todayTurns}</dd>
              <dt>Tokens to {label}</dt>
              <dd>{tokensToValue}</dd>
              <dt>Tokens from {label}</dt>
              <dd>{tokensFromValue}</dd>
            </dl>
            <p className="quota-popover-note">
              No quota limit reported yet — it appears after {label} returns one.
            </p>
            <button
              type="button"
              className="quota-popover-action"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Provider settings
            </button>
          </div>
        )}
      </div>
    );
  }

  const q = mostConstrained;
  // Derive used-% directly from the counts. The SDK's `remainingPercentage`
  // is already in 0–100 form, not a fraction, so the previous
  // `(1 - remainingPercent) * 100` gave nonsensical values like -2870.
  const rawUsedPercent = q.limit > 0 ? (q.used / q.limit) * 100 : 0;
  const clampedUsedPercent = Math.max(0, Math.min(100, rawUsedPercent));
  const usedPercent = Math.round(rawUsedPercent);
  const isWarn = usedPercent > 80;
  const isCritical = usedPercent > 95;
  const tooltip = [
    `${label} quota`,
    ...buckets.map((bucket) => {
      const bucketUsedPercent =
        bucket.limit > 0 ? Math.round((bucket.used / bucket.limit) * 100) : 0;
      return `${humanizeBucketName(bucket.name)}: ${bucketUsedPercent}% used, ${Math.round(bucket.remainingPercent)}% left${bucket.resetDate ? `; resets ${formatResetDate(bucket.resetDate)}` : ''}`;
    }),
    `${todayTurns} turns today in Gezel`,
    `Tokens to ${label}: ${tokensToValue}`,
    `Tokens from ${label}: ${tokensFromValue}`,
  ].join('\n');

  return (
    <div className="quota-meter-root" ref={rootRef}>
      <button
        type="button"
        className="quota-meter"
        onClick={toggle}
        aria-expanded={open}
        aria-label={`${label} quota: ${q.used}/${q.limit} used, ${Math.round(q.remainingPercent)}% left`}
        title={tooltip}
      >
        <div className="quota-ring-wrap">
          <svg className="quota-ring" viewBox="0 0 36 36" aria-hidden="true">
            <circle
              className="quota-ring-bg"
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              strokeWidth="4"
            />
            <circle
              className={`quota-ring-fill${isCritical ? ' critical' : isWarn ? ' warn' : ''}`}
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              strokeWidth="4"
              pathLength={100}
              strokeDasharray={`${clampedUsedPercent} ${100 - clampedUsedPercent}`}
              strokeDashoffset="25"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <span className="quota-label quota-label-provider">{label}</span>
        <span className="quota-label quota-label-remaining">
          {Math.round(q.remainingPercent)}% left
        </span>
      </button>
      {open && (
        <div className="quota-popover">
          <div className="quota-popover-header">{label} quota</div>
          <dl className="quota-popover-stats">
            {buckets.map((bucket) => {
              const bucketUsedPercent =
                bucket.limit > 0 ? Math.round((bucket.used / bucket.limit) * 100) : 0;
              return (
                <div className="quota-popover-bucket" key={bucket.name}>
                  <dt>{humanizeBucketName(bucket.name)}</dt>
                  <dd>
                    {formatQuotaCount(bucket.used)} / {formatQuotaCount(bucket.limit)} (
                    {bucketUsedPercent}%)
                    {bucket.resetDate && (
                      <span className="quota-popover-reset">
                        Resets {formatResetDate(bucket.resetDate)}
                      </span>
                    )}
                  </dd>
                  <dt>Remaining</dt>
                  <dd>{formatQuotaCount(bucket.remaining)}</dd>
                </div>
              );
            })}
            <dt>Turns today in Gezel</dt>
            <dd>{todayTurns}</dd>
            <dt>Tokens to {label}</dt>
            <dd>{tokensToValue}</dd>
            <dt>Tokens from {label}</dt>
            <dd>{tokensFromValue}</dd>
          </dl>
          <button
            type="button"
            className="quota-popover-action"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Provider settings
          </button>
        </div>
      )}
    </div>
  );
}

function formatQuotaCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Compact token count for the quota popover: raw below 1K, then K/M with
 * one decimal until the number is wide enough that the fraction is noise
 * ("482", "12.4K", "310K", "1.2M").
 */
function formatTokenCount(value: number): string {
  const scaled = (n: number, unit: string) =>
    `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (value < 1000) return String(value);
  if (value < 999_500) return scaled(value / 1000, 'K');
  return scaled(value / 1_000_000, 'M');
}

/**
 * Input-token count with its prompt-cache share: "27.7M (57% cached)".
 * The cached note is omitted when zero, since providers without a cache
 * breakdown report nothing and 0 would read as a 0% hit rate.
 */
function formatTokensWithCache(tokensIn: number, tokensCached: number): string {
  if (tokensCached > 0 && tokensIn > 0) {
    const pct = Math.round((tokensCached / tokensIn) * 100);
    return `${formatTokenCount(tokensIn)} (${pct < 1 ? '<1' : pct}% cached)`;
  }
  return formatTokenCount(tokensIn);
}

/**
 * Format a bucket's machine-style name ("premium_interactions") into
 * something we can show to a human ("Premium interactions"). Only the
 * first word gets capitalized — "premium_interactions" reads more
 * naturally as a sentence than in title case.
 */
function humanizeBucketName(raw: string): string {
  const spaced = raw.replace(/_/g, ' ').trim();
  if (!spaced) return raw;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Render the Copilot-supplied ISO reset date as a friendlier local
 * string, e.g. "Friday, May 1 at 5:00 PM". Falls back to the raw string
 * on parse failure so we never hide the information outright.
 */
function formatResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart} at ${timePart}`;
}
