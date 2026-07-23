import type {
  ChatEventEnvelope,
  MeesterStatusResponse,
  Poppetje as PoppetjeStruct,
  Project,
  Question,
  Task,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
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
  onNavigate,
}: {
  config: ConfigResponse | null;
  projects: Project[];
  meesterGezelId?: string;
  meesterName: string;
  meesterIcon: string | null;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIconOverride: boolean;
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
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const refreshQuestions = useCallback(() => {
    api
      .listQuestions({ pending: true })
      .then((r) => setQuestions(r.questions ?? []))
      .catch(() => {});
  }, []);

  // Pending questions contribute to the greeting's "waiting on you" chip.
  useEffect(() => {
    refreshQuestions();
  }, [refreshQuestions]);

  // The meester's status report: load once, then follow the global SSE
  // stream — `meester_status` events flip the "writing…" state and
  // trigger a refetch when a run lands, so no polling is needed.
  const refreshStatus = useCallback(() => {
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
  }, [refreshStatus]);

  // Staleness decay: an old report falls back to the plain time-of-day
  // greeting rather than greeting the user with last week's news.
  const statusReport = useMemo(() => freshStatusReport(status?.report), [status]);

  const runStatusReport = useCallback(() => {
    setStatusRunning(true);
    api.runMeesterStatus().catch(() => setStatusRunning(false));
  }, []);

  // Jobs for the active project — reloads when the active project changes.
  useEffect(() => {
    let cancelled = false;
    if (!activeProjectId) {
      setTasks([]);
      return;
    }
    api
      .listProjectTasks(activeProjectId)
      .then((r) => {
        if (!cancelled) setTasks(r.tasks ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const visibleTasks = useMemo(() => tasks.filter((t) => t.status !== 'canceled'), [tasks]);

  const pendingQuestions = useMemo(() => questions.filter((q) => !q.answer), [questions]);

  const waitingOnYou =
    pendingQuestions.length +
    visibleTasks.filter((t) => t.assignee.kind === 'user' && t.status !== 'complete').length;

  const chips: HomeChip[] = [{ dot: 'var(--live)', label: 'Ready to work' }];
  if (activeProject && activeProject.id !== 'default') {
    chips.push({ dot: 'var(--terra)', label: `${activeProject.name} on the bench` });
  }
  chips.push({
    dot: 'var(--sage)',
    label: `${projects.length} project${projects.length === 1 ? '' : 's'} open`,
  });
  if (waitingOnYou > 0) {
    chips.push({
      dot: 'var(--ochre)',
      label: `${waitingOnYou} waiting on you`,
    });
  }

  return (
    <div className="home-workshop" data-testid="home-workshop">
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
        onRunStatusReport={runStatusReport}
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
