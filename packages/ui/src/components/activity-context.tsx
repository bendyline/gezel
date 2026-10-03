import {
  type ActivityStatusResponse,
  type GezelSummary,
  type Project,
  type Question,
  resolveActivity,
} from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';

interface ActivityState {
  snapshot: ActivityStatusResponse | null;
  stale: boolean;
  refreshing: boolean;
  refresh: () => void;
  answered: (question: Question) => void;
  receipts: Question[];
  clearReceipts: () => void;
  gezels: Map<string, GezelSummary>;
  projects: Map<string, Project>;
}
const ActivityContext = createContext<ActivityState | null>(null);
export const useActivity = () => useContext(ActivityContext);

async function loadSnapshot(): Promise<ActivityStatusResponse> {
  if (runtimeCapabilities().daemonSettings) {
    try {
      return await api.getActivityStatus();
    } catch (error) {
      // Portable runtimes and older daemons share the same resolver using
      // existing APIs. A connection failure never becomes an empty snapshot.
      if (!(error instanceof GezelApiError) || error.status !== 404) throw error;
    }
  }
  const [queues, questions, tasks, inflight] = await Promise.all([
    api.getQueueStatus(),
    runtimeCapabilities().structuredQuestions
      ? api.listQuestions({ pending: true })
      : { questions: [] },
    runtimeCapabilities().tasks ? api.listTasks() : { tasks: [], waiting: [] },
    api.listInflightTurns(),
  ]);
  return resolveActivity({
    queues,
    questions: questions.questions,
    tasks: tasks.tasks,
    waiting: tasks.waiting ?? [],
    inflight: inflight.inflight,
  });
}

/** One subscription for the header, Home, and sidebar question counts. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ActivityStatusResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [receipts, setReceipts] = useState<Question[]>([]);
  const [gezels, setGezels] = useState(new Map<string, GezelSummary>());
  const [projects, setProjects] = useState(new Map<string, Project>());
  const acknowledged = useRef(new Set<string>());
  const mounted = useRef(false);
  const pending = useRef(false);
  const again = useRef(false);
  const lastSuccess = useRef(Date.now());
  const refresh = useCallback(async () => {
    if (pending.current) {
      again.current = true;
      return;
    }
    pending.current = true;
    setRefreshing(true);
    try {
      do {
        again.current = false;
        const next = await loadSnapshot();
        if (!mounted.current) return;
        const ids = acknowledged.current;
        const questions = next.questions.filter((q) => !ids.has(q.id));
        const items = next.items.flatMap((item) => {
          const questionIds = item.questionIds.filter((id) => !ids.has(id));
          return item.questionIds.length && !questionIds.length ? [] : [{ ...item, questionIds }];
        });
        setSnapshot({ ...next, questions, items });
        lastSuccess.current = Date.now();
        setStale(false);
      } while (again.current && mounted.current);
    } catch {
      if (mounted.current) setStale(true);
    } finally {
      pending.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);
  const answered = useCallback(
    (question: Question) => {
      acknowledged.current.add(question.id);
      setReceipts((current) => [...current.filter((q) => q.id !== question.id), question]);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              questions: current.questions.filter((q) => q.id !== question.id),
              items: current.items.flatMap((item) => {
                const questionIds = item.questionIds.filter((id) => id !== question.id);
                return item.questionIds.length && !questionIds.length
                  ? []
                  : [{ ...item, questionIds }];
              }),
            }
          : current,
      );
      void refresh();
    },
    [refresh],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (Date.now() - lastSuccess.current > 15_000) setStale(true);
      void refresh();
    }, 5_000);
    const controller = new AbortController();
    let eventTimer: number | undefined;
    const changed = () => {
      if (eventTimer !== undefined) return;
      eventTimer = window.setTimeout(() => {
        eventTimer = undefined;
        void refresh();
      }, 150);
    };
    const roster = async () => {
      const results = await Promise.allSettled([api.listGezels(), api.listProjects()]);
      if (!mounted.current) return;
      if (results[0].status === 'fulfilled')
        setGezels(new Map(results[0].value.gezels.map((g) => [g.id, g])));
      if (results[1].status === 'fulfilled')
        setProjects(new Map(results[1].value.projects.map((p) => [p.id, p])));
    };
    void roster();
    window.addEventListener('gezel:config-changed', changed);
    window.addEventListener('gezel:projects-changed', roster);
    window.addEventListener('gezel:gezels-changed', roster);
    void (async () => {
      try {
        for await (const { event } of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: controller.signal,
          fetch: api.getFetch(),
        })) {
          if (
            event.type === 'question_asked' ||
            event.type === 'question_answered' ||
            event.type === 'task_event' ||
            event.type === 'done' ||
            event.type === 'error' ||
            event.type === 'user_message' ||
            event.type === 'cancelled' ||
            event.type === 'queue_enqueued' ||
            event.type === 'queue_removed'
          )
            changed();
        }
      } catch {
        /* Polling reconciles a disconnected event stream. */
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
      clearTimeout(eventTimer);
      window.removeEventListener('gezel:config-changed', changed);
      window.removeEventListener('gezel:projects-changed', roster);
      window.removeEventListener('gezel:gezels-changed', roster);
    };
  }, [refresh]);
  const clearReceipts = useCallback(() => setReceipts([]), []);
  const value = useMemo(
    () => ({
      snapshot,
      stale,
      refreshing,
      refresh,
      answered,
      receipts,
      clearReceipts,
      gezels,
      projects,
    }),
    [snapshot, stale, refreshing, refresh, answered, receipts, clearReceipts, gezels, projects],
  );
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}
