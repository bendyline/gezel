import type {
  ChatEventEnvelope,
  MeesterStatusResponse,
  NightShiftReviewResponse,
  Poppetje as PoppetjeStruct,
  Project,
  Question,
  Task,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { navigateToTab, openUpdates } from '../../components/nav-actions.js';
import { runtimeCapabilities } from '../../runtime-capabilities.js';
import { streamSharedAllChatEvents } from '../../shared-chat-events.js';
import { GreetingBand, type HomeGreetingTab } from './GreetingBand.js';
import { MeesterConversation } from './MeesterConversation.js';
import {
  type HomeChip,
  type HomeNavView,
  deriveActiveProjectId,
  freshStatusReport,
} from './utils.js';

/**
 * The onboarded "workshop" home: a full-width greeting band over the meester
 * conversation. Owns its Home data fetching and the greeting's local UI state.
 */
export function HomeWorkshop({
  config,
  projects,
  meesterGezelId,
  meesterName,
  meesterIcon,
  meesterPoppetje,
  meesterIconOverride,
  banner,
  onNavigate,
}: {
  config: ConfigResponse | null;
  projects: Project[];
  meesterGezelId?: string;
  meesterName: string;
  meesterIcon: string | null;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIconOverride: boolean;
  /**
   * Service-health banner from HomeView, rendered above the greeting band.
   * It has to be threaded through rather than left in HomeView's own JSX:
   * once the user is configured, HomeView returns this component and never
   * reaches the markup where the banner used to live, so every degraded
   * service notice was invisible to everyone past first-run setup.
   */
  banner?: ReactNode;
  onNavigate?: (view: HomeNavView) => void;
}) {
  // Collapsed state is a persisted preference (server config, so it
  // survives Electron's per-launch port shuffle). Seed from config, then
  // reconcile once when it first arrives; toggles write through.
  const [collapsed, setCollapsed] = useState(config?.homeGreetingCollapsed ?? false);
  const reconciledCollapse = useRef(false);
  // A manual toggle is authoritative: if the user collapses/expands before
  // config has loaded, the late-arriving reconcile must not clobber their
  // choice back to the persisted value. Latch on first toggle and bail.
  const userToggledCollapse = useRef(false);
  useEffect(() => {
    if (reconciledCollapse.current || userToggledCollapse.current || !config) return;
    reconciledCollapse.current = true;
    setCollapsed(config.homeGreetingCollapsed === true);
  }, [config]);
  const toggleCollapse = useCallback(() => {
    userToggledCollapse.current = true;
    setCollapsed((v) => {
      const next = !v;
      void api.updateConfig({ homeGreetingCollapsed: next }).catch(() => {});
      return next;
    });
  }, []);
  const [tab, setTab] = useState<HomeGreetingTab>('greeting');
  const [status, setStatus] = useState<MeesterStatusResponse | null>(null);
  const [statusRunning, setStatusRunning] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);

  const activeProjectId = useMemo(
    () => deriveActiveProjectId(config, projects),
    [config, projects],
  );

  const refreshQuestions = useCallback(() => {
    if (!runtimeCapabilities().structuredQuestions) return;
    api
      .listQuestions({ pending: true })
      .then((r) => setQuestions(r.questions ?? []))
      .catch(() => {});
  }, []);

  // Pending questions contribute to the greeting's "waiting on you" chip.
  // Loaded once, then kept live off the SSE stream below: answering or
  // dismissing a question anywhere else in the app (the titlebar Updates
  // drawer, the sidebar intervene popup) has to drain this chip too, or
  // the greeting keeps counting work the user already cleared.
  useEffect(() => {
    refreshQuestions();
  }, [refreshQuestions]);

  // Jobs for the active project — reloads when the active project changes,
  // and again on any task audit event (a job the user owned being finished
  // elsewhere also drains the "waiting on you" chip).
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const refreshTasks = useCallback(() => {
    if (!runtimeCapabilities().tasks) return;
    const pid = activeProjectIdRef.current;
    if (!pid) {
      setTasks([]);
      return;
    }
    api
      .listProjectTasks(pid)
      .then((r) => {
        // A slower response for a project the user has already navigated
        // away from must not clobber the current one's jobs.
        if (activeProjectIdRef.current === pid) setTasks(r.tasks ?? []);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!activeProjectId) {
      setTasks([]);
      return;
    }
    refreshTasks();
  }, [activeProjectId, refreshTasks]);

  // The meester's status report: load once, then follow the global SSE
  // stream — `meester_status` events flip the "writing…" state and
  // trigger a refetch when a run lands, so no polling is needed.
  const refreshStatus = useCallback(() => {
    if (!runtimeCapabilities().background) return;
    api
      .getMeesterStatus()
      .then((r) => {
        setStatus(r);
        setStatusRunning(r.running);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshStatus();
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (ev.type === 'question_asked' || ev.type === 'question_answered') {
            refreshQuestions();
            continue;
          }
          if (ev.type === 'task_event') {
            refreshTasks();
            continue;
          }
          if (ev.type !== 'meester_status') continue;
          if (ev.state === 'started') {
            setStatusRunning(true);
          } else {
            setStatusRunning(false);
            refreshStatus();
          }
        }
      } catch {
        /* stream ended (shutdown / navigation) */
      }
    })();
    return () => ctrl.abort();
  }, [refreshStatus, refreshQuestions, refreshTasks]);

  // Staleness decay: an old report falls back to the plain time-of-day
  // greeting rather than greeting the user with last week's news.
  const statusReport = useMemo(() => freshStatusReport(status?.report), [status]);

  // Last night's review — the "Last night" tab appears only while the
  // window's end is recent (~12h) and the shift actually did something.
  const [nightReview, setNightReview] = useState<NightShiftReviewResponse | null>(null);
  useEffect(() => {
    if (!runtimeCapabilities().background) return;
    let cancelled = false;
    api
      .getNightShiftReview()
      .then((review) => {
        if (cancelled) return;
        const endedMs = Date.parse(review.windowEnd);
        const fresh = Number.isFinite(endedMs) && Date.now() - endedMs < 12 * 60 * 60 * 1000;
        const hasContent = review.tasksCompleted.length > 0 || review.reports.length > 0;
        setNightReview(fresh && hasContent ? review : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const runStatusReport = useCallback(() => {
    setStatusRunning(true);
    api.runMeesterStatus().catch(() => setStatusRunning(false));
  }, []);

  // System jobs use a user assignee to keep TaskRunner from launching a model,
  // but they are service controls, not work waiting on the person at Home.
  const visibleTasks = useMemo(
    () => tasks.filter((t) => t.status !== 'canceled' && t.origin?.kind !== 'system-job'),
    [tasks],
  );

  // "Ready" cards (finished work) ask nothing, so they get their own chip
  // rather than inflating "waiting on you".
  const pendingQuestions = useMemo(
    () => questions.filter((q) => !q.answer && q.intent?.kind !== 'task-finished'),
    [questions],
  );
  const readyForYou = useMemo(
    () => questions.filter((q) => !q.answer && q.intent?.kind === 'task-finished').length,
    [questions],
  );

  const ownerTasks = visibleTasks.filter(
    (t) => t.assignee.kind === 'user' && t.status !== 'complete',
  );
  const waitingOnYou = pendingQuestions.length + ownerTasks.length;

  const chips: HomeChip[] = [];
  if (waitingOnYou > 0) {
    // The count is a to-do list, so it opens one: the Updates drawer when a
    // question is waiting, else the task that is.
    const firstTask = ownerTasks[0];
    chips.push({
      dot: 'var(--ochre)',
      label: `${waitingOnYou} waiting on you`,
      actionLabel: pendingQuestions.length > 0 ? 'Open your updates' : 'Open the task',
      onClick: () => {
        if (pendingQuestions.length > 0) openUpdates();
        else if (firstTask) navigateToTab({ kind: 'task', ref: firstTask.ref });
      },
    });
  }
  if (readyForYou > 0) {
    chips.push({
      dot: 'var(--sage)',
      label: `${readyForYou} ready for you`,
      actionLabel: 'Open your updates',
      onClick: openUpdates,
    });
  }

  return (
    <div className="home-workshop" data-testid="home-workshop">
      {banner}
      <GreetingBand
        chips={chips}
        meesterName={meesterName}
        meesterPoppetje={meesterPoppetje}
        meesterIcon={meesterIcon}
        meesterIconOverride={meesterIconOverride}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        tab={tab}
        onTabChange={setTab}
        statusReport={statusReport}
        statusRunning={statusRunning}
        onRunStatusReport={runtimeCapabilities().background ? runStatusReport : undefined}
        nightReview={nightReview}
        onNavigate={onNavigate}
      />
      <div className="home-workshop-body">
        <div className="home-workshop-main">
          {meesterGezelId ? (
            <MeesterConversation
              meesterGezelId={meesterGezelId}
              meesterName={meesterName}
              meesterIcon={meesterIcon}
              meesterPoppetje={meesterPoppetje}
              meesterIconOverride={meesterIconOverride}
            />
          ) : (
            <section className="home-workshop-conversation">
              <div className="home-workshop-eyebrow home-workshop-conversation-eyebrow">
                Talk to your meester
              </div>
              <p className="home-workshop-rail-empty">
                No meester is designated yet. Pick one in{' '}
                <button
                  type="button"
                  className="home-workshop-tip-action"
                  onClick={() => onNavigate?.('settings')}
                >
                  Settings
                </button>
                .
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
