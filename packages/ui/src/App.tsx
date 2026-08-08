import type {
  ChatEventEnvelope,
  NightShiftReviewResponse,
  NightShiftTasksResponse,
  RecentTab,
  RecentTabArea,
} from '@bendyline/gezel';
import type { QuotaBucket, UsageResponse } from '@bendyline/gezel-client';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import logotypeUrl from './assets/gezellogotype.png';
import woodtexUrl from './assets/woodtex.png';
import { BoekwachterPill } from './components/BoekwachterPill.js';
import { ClaudeCliPoolPill } from './components/ClaudeCliPoolPill.js';
import { EngineStatusPill } from './components/EngineStatusPill.js';
import { GrantConsentDialog } from './components/GrantConsentDialog.js';
import { MacUninstallDialog } from './components/MacUninstallDialog.js';
import { ModelBundleImportController } from './components/ModelBundleControls.js';
import { NeedsInputPanel } from './components/NeedsInputPanel.js';
import { QueueMeter } from './components/QueueMeter.js';
import { Sidebar } from './components/Sidebar.js';
import { TabContent } from './components/TabContent.js';
import { TabErrorBoundary } from './components/TabErrorBoundary.js';
import { TitlebarSearch } from './components/TitlebarSearch.js';
import { NIGHT_SHIFT_MOON_PATH } from './components/night-shift-glyph.js';
import {
  OUTPUT_PANE_MAXIMIZED_EVENT,
  requestOutputPaneRestore,
} from './components/output-pane-maximize.js';
import { openQuestionInChat } from './components/question-nav.js';
import { type RecentTabInput, tabKey, toRecentTab } from './components/recent-tabs.js';
import { EmbeddedChat } from './embedded/EmbeddedChat.js';
import { requestSettingsSection } from './settings-nav.js';
import { streamSharedAllChatEvents } from './shared-chat-events.js';
import { syncSidebarSideFromConfig } from './sidebar-side.js';
import { syncThemeFromConfig } from './theme.js';
import { HomeView } from './views/HomeView.js';

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
  };
}

const EMBEDDED_PARAMS = readEmbeddedParams();

export function App() {
  if (EMBEDDED_PARAMS) {
    return (
      <EmbeddedChat
        projectId={EMBEDDED_PARAMS.projectId}
        gezelId={EMBEDDED_PARAMS.gezelId}
        theme={EMBEDDED_PARAMS.theme}
        accent={EMBEDDED_PARAMS.accent}
        bg={EMBEDDED_PARAMS.bg}
        fg={EMBEDDED_PARAMS.fg}
        fontFamily={EMBEDDED_PARAMS.fontFamily}
      />
    );
  }
  return <FullApp />;
}

function FullApp() {
  // Random vertical slice into the wood texture, picked once per app
  // launch so each session shows a different band of grain across the
  // titlebar. The CSS renders the 1024-tall source compressed to
  // 512px (background-size: auto 512px) so the visible strip shows
  // ~2× as many grain lines as native; the random offset has to
  // range over that *rendered* height — `Math.random() * 512`, not
  // 1024. `background-repeat: repeat` wraps naturally. Negated
  // because CSS `background-position` is measured from the top-left
  // of the painted area inward.
  const [titlebarBgPosY] = useState(() => -Math.floor(Math.random() * 512));
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [pendingQuestionCount, setPendingQuestionCount] = useState(0);
  const [outputPaneMaximized, setOutputPaneMaximized] = useState(false);
  // Per-project signals painted on the sidebar rows: which projects have a
  // gezel mid-turn (the animated "thinking" indicator), and how many pending
  // questions each has (the "needs input" affordance). Both ride the single
  // global SSE stream + the same listQuestions call the Home badge makes — no
  // extra endpoints or connections.
  const [activeProjectIds, setActiveProjectIds] = useState<Set<string>>(new Set());
  const [pendingByProject, setPendingByProject] = useState<Map<string, number>>(new Map());
  // Projects with a "poisoned" session — last turn aborted, awaiting a user
  // turn to clear. Durable (survives reload) so it's seeded from a real fetch,
  // not the live stream; error/complete events + a 20s reconcile keep it fresh.
  const [poisonedProjects, setPoisonedProjects] = useState<
    Map<string, { sessionId: string; gezelId: string; error: string }>
  >(new Map());
  // sessionId → projectId for every turn currently mid-flight. Recomputed into
  // `activeProjectIds` only when project membership actually changes, so a
  // burst of `delta` events doesn't thrash the sidebar.
  const activeSessionsRef = useRef<Map<string, string>>(new Map());
  const recomputeActiveProjects = useCallback(() => {
    const next = new Set(activeSessionsRef.current.values());
    setActiveProjectIds((prev) => {
      if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
      return next;
    });
  }, []);
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
  // Questions overlay — top-of-window dropdown that renders the pending
  // structured questions across every project. Opens on nav click.
  // Auto-closes when the last question is answered.
  const [questionsOpen, setQuestionsOpen] = useState(false);

  const commitSelection = useCallback((next: RecentTab | null) => {
    setSelection(next);
    try {
      if (next) window.localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(SELECTION_STORAGE_KEY);
    } catch {
      /* private mode / quota — selection still lives in memory */
    }
  }, []);

  const openArea = useCallback(
    (area: RecentTabArea) => commitSelection(toRecentTab({ kind: 'area', area })),
    [commitSelection],
  );
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
        | { aiEngagementMode?: string; showSystemTray?: boolean; quitOnClose?: boolean }
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

  // Auto-close the Questions overlay once the queue drains. Esc also
  // closes it so the user can dismiss without reaching for the mouse.
  useEffect(() => {
    if (questionsOpen && pendingQuestionCount === 0) setQuestionsOpen(false);
  }, [questionsOpen, pendingQuestionCount]);
  useEffect(() => {
    if (!questionsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQuestionsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [questionsOpen]);

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
    api
      .getUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshUsage();
    const interval = setInterval(refreshUsage, 10_000);
    return () => clearInterval(interval);
  }, [refreshUsage]);

  // Pending-question count for the Home tab badge. Loaded once at mount,
  // refreshed whenever a `question_asked` / `question_answered` SSE
  // envelope arrives — same global stream the Home pane subscribes to,
  // so a single source feeds both surfaces.
  const refreshPendingCount = useCallback(() => {
    api
      .listQuestions({ pending: true })
      .then((r) => {
        setPendingQuestionCount(r.questions.length);
        const m = new Map<string, number>();
        for (const q of r.questions) m.set(q.projectId, (m.get(q.projectId) ?? 0) + 1);
        setPendingByProject(m);
      })
      .catch(() => {});
  }, []);
  // Seed the mid-turn set from every in-flight turn (each tagged with its
  // projectId), and re-sync on an interval to self-heal any missed `done`.
  const reconcileActiveProjects = useCallback(() => {
    api
      .listInflightTurns()
      .then(({ inflight }) => {
        const m = new Map<string, string>();
        for (const t of inflight) m.set(t.sessionId, t.projectId);
        activeSessionsRef.current = m;
        recomputeActiveProjects();
      })
      .catch(() => {});
  }, [recomputeActiveProjects]);
  const refreshPoisoned = useCallback(() => {
    api
      .listPoisonedProjects()
      .then(({ poisoned }) => {
        const m = new Map<string, { sessionId: string; gezelId: string; error: string }>();
        for (const p of poisoned)
          m.set(p.projectId, { sessionId: p.sessionId, gezelId: p.gezelId, error: p.error });
        setPoisonedProjects(m);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    reconcileActiveProjects();
    refreshPoisoned();
    const t = window.setInterval(() => {
      reconcileActiveProjects();
      refreshPoisoned();
    }, 20_000);
    return () => window.clearInterval(t);
  }, [reconcileActiveProjects, refreshPoisoned]);
  // A chat banner cleared a session's error — re-check the sidebar indicator.
  useEffect(() => {
    const onCleared = () => refreshPoisoned();
    window.addEventListener('gezel:session-error-cleared', onCleared);
    return () => window.removeEventListener('gezel:session-error-cleared', onCleared);
  }, [refreshPoisoned]);
  useEffect(() => {
    refreshPendingCount();
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
          if (ev.type === 'question_asked' || ev.type === 'question_answered') {
            refreshPendingCount();
          }
          // Keep the sidebar "thinking" set live: a turn opens on user_message
          // and closes on done/error/cancelled. Mount seed + 20s reconcile cover turns we
          // joined mid-flight.
          if (ev.type === 'user_message') {
            activeSessionsRef.current.set(env.sessionId, env.projectId);
            recomputeActiveProjects();
          } else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
            if (activeSessionsRef.current.delete(env.sessionId)) recomputeActiveProjects();
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
          // Surface a "Gezel needs your input" OS notification when a new
          // question arrives and the window is backgrounded — the tray is
          // the locus, so the user can be elsewhere and still get pulled
          // back. Gated on visibility to avoid notifying the active window.
          if (ev.type === 'question_asked' && document.visibilityState === 'hidden') {
            const prompt = ev.question.prompt.split('\n')[0]?.slice(0, 140) ?? '';
            void window.__GEZEL__?.notify?.({
              title: 'Gezel needs your input',
              body: prompt,
              view: 'chat',
            });
          }
          // Level-ups: fan out to the roster badge / Growth-tab surfaces,
          // and nudge via OS notification only when the window is hidden —
          // one calm notification, never a foreground interruption.
          if (ev.type === 'growth_level_up') {
            window.dispatchEvent(
              new CustomEvent('gezel:growth-updated', { detail: { gezelId: ev.gezelId } }),
            );
            if (document.visibilityState === 'hidden') {
              void window.__GEZEL__?.notify?.({
                title: `${ev.gezelName} reached level ${ev.toLevel}`,
                body: 'Growth choices are waiting — open the Growth tab when you have a minute.',
                view: 'gezels',
              });
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return () => ctrl.abort();
  }, [refreshPendingCount, recomputeActiveProjects, refreshPoisoned]);

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
    <div className="app">
      {/* Global consent dialog for /v1/apps/register. Mounts here so a
          pending grant can surface from any view without the user having
          to navigate to Settings → Connected Apps. */}
      <GrantConsentDialog />
      <MacUninstallDialog />
      <ModelBundleImportController onEngineIdentified={openModelBundleSettings} />
      {/* The top bar is now status-only — it remains the OS title bar (drag
          region + native window-control reservations via CSS padding). The
          brand mark routes to the Meester home; navigation lives in the
          left Sidebar. */}
      <header
        className="app-header"
        data-testid="app-header"
        style={
          {
            ['--titlebar-bg-url' as string]: `url(${woodtexUrl})`,
            ['--titlebar-bg-pos-y' as string]: `${titlebarBgPosY}px`,
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          className={`app-header-brand${selection === null ? ' active' : ''}`}
          onClick={() => commitSelection(null)}
          title="Meester"
          aria-label="Meester home"
        >
          <span
            className="app-nav-home-logotype"
            role="img"
            aria-label="gezel"
            style={{ ['--gezel-logo-url' as string]: `url(${logotypeUrl})` } as React.CSSProperties}
          />
        </button>
        {pendingQuestionCount > 0 && (
          <button
            type="button"
            className={
              questionsOpen
                ? 'nav active app-nav-questions app-header-questions'
                : 'nav app-nav-questions app-header-questions'
            }
            onClick={() => setQuestionsOpen((o) => !o)}
            title={`${pendingQuestionCount} pending question${pendingQuestionCount === 1 ? '' : 's'}`}
            aria-expanded={questionsOpen}
          >
            Questions
            <span className="app-nav-badge">{pendingQuestionCount}</span>
            <span aria-hidden="true"> {questionsOpen ? '▴' : '▾'}</span>
          </button>
        )}
        {/* Unified search is anchored near the brand so changing status-pill
            widths do not recenter it. It stays shrinkable in the flex row, so
            crowded titlebars still give the pills room without overlap. */}
        <TitlebarSearch />
        {/* The empty stretch between the brand and the status cluster is the
            primary OS drag target — `.app-header-right`'s `margin-left: auto`
            pushes the pills right, leaving the remaining gap (and the
            reserved window-control padding) as draggable titlebar. */}
        <div className="app-header-right">
          <QueueMeter />
          <BoekwachterPill />
          <EngineStatusPill />
          <ClaudeCliPoolPill />
          <NightShiftMenu state={nightShift} onChange={setNightShift} />
          <EngagementMenu mode={engagementMode} />
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
          <QuotaMeters usage={usage} onOpenSettings={openProviderSettings} />
        </div>
      </header>
      {questionsOpen && (
        <>
          {/* Scrim is a real <button> so keyboard users can close the
             overlay (Enter / Space) — biome's useKeyWithClickEvents
             caught the original <div onClick> version. Styling in
             `.app-questions-scrim` strips every native button look so
             it still reads as a dim translucent layer. */}
          <button
            type="button"
            className="app-questions-scrim"
            onClick={() => setQuestionsOpen(false)}
            aria-label="Close questions panel"
          />
          {/* Native <dialog open> satisfies biome's useSemanticElements
             rule (beats <div role="dialog">). `open` (not `showModal`)
             keeps the existing non-modal behavior — the rest of the UI
             stays interactive — and all our custom affordances (Esc
             handler, auto-close on empty queue, scrim click) still
             apply. Going fully modal via showModal would trap focus
             and inert the rest of the app, which is stricter than
             intended for a top-of-window notification drawer. */}
          <dialog open className="app-questions-overlay" aria-label="Needs your input">
            <button
              type="button"
              className="app-questions-overlay-close"
              onClick={() => setQuestionsOpen(false)}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
            <NeedsInputPanel
              onOpenInChat={(question) => {
                openQuestionInChat(question);
                setQuestionsOpen(false);
              }}
            />
          </dialog>
        </>
      )}
      <div className="app-body">
        <Sidebar
          selection={selection}
          onSelect={commitSelection}
          onOpenArea={openArea}
          activeProjectIds={activeProjectIds}
          pendingByProject={pendingByProject}
          poisonedProjects={poisonedProjects}
        />
        <main className="app-main">
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
              <TabContent tab={selection} />
            </TabErrorBoundary>
          )}
        </main>
      </div>
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

/**
 * Header control for the install-wide AI engagement mode. The trigger
 * reflects the selected mode with the same glyph used in the dropdown.
 * The dropdown lets the user pick any of the four modes directly without
 * the round-trip through Settings.
 *
 * Persists by calling `api.updateConfig({ aiEngagementMode })` and
 * dispatches the same `gezel:config-updated` event SettingsView fires —
 * `App` listens for it and reflects the change locally without a
 * second roundtrip.
 */
type EngagementOption = {
  mode: EngagementMode;
  label: string;
  hint: string;
};
const ENGAGEMENT_OPTIONS: EngagementOption[] = [
  {
    mode: 'proactive',
    label: 'Proactive',
    hint: 'Full activity — task work, scheduled triggers, nudges, fan-out.',
  },
  {
    mode: 'scheduled',
    label: 'Tasks + Reactive',
    hint: 'Task work and scheduled triggers run; no proactive nudges.',
  },
  {
    mode: 'reactive',
    label: 'Reactive only',
    hint: 'AI replies to your messages; task work is paused.',
  },
  { mode: 'off', label: 'Off', hint: 'AI is paused entirely.' },
];

function EngagementModeIcon({ mode }: { mode: EngagementMode }) {
  if (mode === 'scheduled') {
    return (
      <svg
        className={`app-engagement-mode-icon app-engagement-mode-icon-${mode}`}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m4 6 1.5 1.5L8 5" />
        <path d="M11 6h9" />
        <path d="m4 12 1.5 1.5L8 11" />
        <path d="M11 12h9" />
        <path d="M5 18h15" />
      </svg>
    );
  }

  return (
    <svg
      className={`app-engagement-mode-icon app-engagement-mode-icon-${mode}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      {mode === 'proactive' ? <path d="M8 5v14l11-7z" /> : null}
      {mode === 'reactive' ? <path d="M6 5h4v14H6zM14 5h4v14h-4z" /> : null}
      {mode === 'off' ? <path d="M6 6h12v12H6z" /> : null}
    </svg>
  );
}

function EngagementMenu({ mode }: { mode: EngagementMode }) {
  const current = ENGAGEMENT_OPTIONS.find((o) => o.mode === mode) ?? ENGAGEMENT_OPTIONS[0]!;
  const title = `AI engagement: ${current.label}. Click to change.`;

  // Mirrors NavMenu's broadcast: opening this dropdown should dismiss
  // any other header popover so they don't stack.
  const handleOpenChange = (open: boolean) => {
    if (open) window.dispatchEvent(new CustomEvent('gezel:close-header-popovers'));
  };

  const handleSelect = (next: EngagementMode) => {
    if (next === mode) return;
    void api
      .updateConfig({ aiEngagementMode: next })
      .then((res) => {
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      })
      .catch(() => {
        /* swallow — the badge stays on the previous mode and the user can retry */
      });
  };

  return (
    <DropdownMenu.Root onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`app-engagement-trigger app-engagement-trigger-${mode}`}
          aria-label={title}
          title={title}
        >
          <EngagementModeIcon mode={mode} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
          {ENGAGEMENT_OPTIONS.map((opt) => (
            <DropdownMenu.Item
              key={opt.mode}
              className={`app-nav-menu-item${opt.mode === mode ? ' active' : ''}`}
              onSelect={() => handleSelect(opt.mode)}
            >
              <span className="app-engagement-menu-row">
                <span className="app-engagement-menu-icon">
                  <EngagementModeIcon mode={opt.mode} />
                </span>
                <span className="app-engagement-menu-label">{opt.label}</span>
                <span className="app-engagement-menu-check" aria-hidden="true">
                  {opt.mode === mode ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : null}
                </span>
              </span>
              <span className="app-engagement-menu-hint">{opt.hint}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

type NightShiftState = { active: boolean; source: 'scheduled' | 'manual' | null };

/**
 * Header control for Night Shift. Passing clouds + a quiet moon glow show
 * when a shift is active; the dropdown lets the user start a shift on demand
 * (e.g. stepping out) and end a manual one. Scheduled shifts can't be
 * force-ended here — they latch off on their own once their work drains.
 */
function NightShiftMenu({
  state,
  onChange,
}: {
  state: NightShiftState;
  onChange: (s: NightShiftState) => void;
}) {
  const title = state.active ? `Night Shift: on (${state.source ?? 'active'})` : 'Night Shift: off';

  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<NightShiftTasksResponse | null>(null);
  const [review, setReview] = useState<NightShiftReviewResponse | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) window.dispatchEvent(new CustomEvent('gezel:close-header-popovers'));
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
    };
    load();
    const id = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
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

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`app-nightshift-trigger${state.active ? ' app-nightshift-trigger-active' : ''}`}
          aria-label={title}
          title={title}
        >
          <svg
            className="app-nightshift-glyph"
            width="24"
            height="18"
            viewBox="0 0 32 24"
            fill="currentColor"
            aria-hidden="true"
          >
            {state.active && (
              <g className="app-nightshift-cloud app-nightshift-cloud-far">
                <g transform="translate(0 -4) scale(.74)">
                  <path d="M1 17h10.4a2 2 0 0 0 .1-4 3.2 3.2 0 0 0-6.15-1.1A2.5 2.5 0 0 0 1 13.4 1.8 1.8 0 0 0 1 17Z" />
                </g>
              </g>
            )}
            <path
              className={`app-nightshift-moon${state.active ? ' is-active' : ''}`}
              transform="translate(4 0)"
              d={NIGHT_SHIFT_MOON_PATH}
            />
            {state.active && (
              <g className="app-nightshift-cloud app-nightshift-cloud-near">
                <path d="M1 17h10.4a2 2 0 0 0 .1-4 3.2 3.2 0 0 0-6.15-1.1A2.5 2.5 0 0 0 1 13.4 1.8 1.8 0 0 0 1 17Z" />
              </g>
            )}
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
          <div className="app-nightshift-status">
            {state.active
              ? `Running — ${state.source === 'manual' ? 'manual shift' : 'scheduled window'}`
              : 'Not running'}
          </div>
          {hasWork && tasks && (
            <div className="app-nightshift-tasks">
              {(backgroundWork.length > 0 || tasks.active.length > 0) && (
                <div className="app-nightshift-task-group">
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
              {tasks.upcoming.length > 0 && (
                <div className="app-nightshift-task-group">
                  <div className="app-nightshift-task-heading">
                    {state.active ? 'Up next' : 'Queued for tonight'}
                  </div>
                  {tasks.upcoming.map((t) => (
                    <NightShiftTaskRow key={t.ref} task={t} />
                  ))}
                </div>
              )}
            </div>
          )}
          {state.active && tasks !== null && !hasWork && (
            <div className="app-nightshift-empty">No work is running or queued.</div>
          )}
          {review && (review.tasksCompleted.length > 0 || review.reports.length > 0) && (
            <div className="app-nightshift-tasks">
              <div className="app-nightshift-task-group">
                <div className="app-nightshift-task-heading">Done last night</div>
                {review.reports.map((r) => (
                  <button
                    key={`${r.projectId}:${r.path}`}
                    type="button"
                    className="app-nightshift-task app-nightshift-report"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('gezel:open-tab', {
                          detail: { kind: 'project', id: r.projectId },
                        }),
                      )
                    }
                  >
                    <span className="app-nightshift-task-dot" aria-hidden="true" />
                    <span className="app-nightshift-task-text">
                      <span className="app-nightshift-task-title">{r.title}</span>
                      <span className="app-nightshift-task-meta">
                        {r.projectName}
                        {r.actionCounts.total > 0
                          ? ` · ${r.actionCounts.suggested > 0 ? `${r.actionCounts.suggested} action${r.actionCounts.suggested === 1 ? '' : 's'} to review` : `${r.actionCounts.total} action${r.actionCounts.total === 1 ? '' : 's'}`}`
                          : ''}
                      </span>
                    </span>
                  </button>
                ))}
                {review.tasksCompleted.slice(0, 5).map((t) => (
                  <button
                    key={t.ref}
                    type="button"
                    className="app-nightshift-task app-nightshift-report"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('gezel:open-tab', {
                          detail: { kind: 'task', ref: t.ref },
                        }),
                      )
                    }
                  >
                    <span className="app-nightshift-task-dot" aria-hidden="true" />
                    <span className="app-nightshift-task-text">
                      <span className="app-nightshift-task-title">{t.title}</span>
                      <span className="app-nightshift-task-meta">{t.projectName}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="app-nightshift-action-tray gz-tray" role="presentation">
            {state.active ? (
              <DropdownMenu.Item
                className="app-nav-menu-item app-nightshift-action gz-key gz-key--stacked"
                onSelect={() => run('stop')}
              >
                <span className="app-engagement-menu-label">Stop night shift</span>
                <span className="app-engagement-menu-hint">
                  {state.source === 'manual'
                    ? 'Stop now and revert to the schedule.'
                    : "Stop for tonight — it won't auto-restart until the next window."}
                </span>
              </DropdownMenu.Item>
            ) : (
              <DropdownMenu.Item
                className="app-nav-menu-item app-nightshift-action gz-key gz-key--stacked"
                onSelect={() => run('start')}
              >
                <span className="app-engagement-menu-label">Start night shift now</span>
                <span className="app-engagement-menu-hint">
                  Run deferred indexing + the meester review while you're away.
                </span>
              </DropdownMenu.Item>
            )}
          </div>
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
  const meta = task.stepName ? `${task.projectName} · ${task.stepName}` : task.projectName;
  return <NightShiftWorkRow title={task.title} meta={meta} active={active} />;
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

type QuotaSettingsSection = (typeof QUOTA_PROVIDERS)[number]['settingsSection'];

function QuotaMeters({
  usage,
  onOpenSettings,
}: {
  usage: UsageResponse | null;
  onOpenSettings: (section: QuotaSettingsSection) => void;
}) {
  if (!usage) return null;
  return (
    <>
      {QUOTA_PROVIDERS.map((provider) => {
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
  onOpenSettings,
}: {
  providerKey: string;
  label: string;
  buckets: QuotaBucket[];
  todayTurns: number;
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
          title={`${label}: ${todayTurns} turns today`}
        >
          <span className="quota-label quota-label-provider">{label}</span>
          <span className="quota-label">{todayTurns} today</span>
        </button>
        {open && (
          <div className="quota-popover">
            <div className="quota-popover-header">{label} usage</div>
            <dl className="quota-popover-stats">
              <dt>Today</dt>
              <dd>
                {todayTurns} {todayTurns === 1 ? 'turn' : 'turns'}
              </dd>
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
    `${todayTurns} turns today`,
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
            <dt>Today</dt>
            <dd>
              {todayTurns} {todayTurns === 1 ? 'turn' : 'turns'}
            </dd>
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
