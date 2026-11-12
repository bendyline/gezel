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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';
import { setVisibleInterval } from '../visible-interval.js';
import {
  INDEX_ACTIVITY_LINGER_MS,
  type IndexProgress,
  type IndexingJob,
  foldIndexingJob,
  indexingActivityId,
  indexingActivityItem,
  indexingJobLive,
  withoutIndexingBackground,
} from './indexing-activity.js';

export interface ActivityState {
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

/**
 * Activity changes every few seconds (each poll hands out a new snapshot with
 * new timestamps), so it is a store, not a context value: a context value
 * re-renders every consumer and, read by the shell, the whole tree. A
 * component reads the slice it shows with `useActivitySelector`.
 */
class ActivityStore {
  private listeners = new Set<() => void>();
  constructor(public state: ActivityState) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(state: ActivityState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

const ActivityContext = createContext<ActivityStore | null>(null);
const noStore = () => () => {};

/**
 * Read one slice of activity. The component re-renders only when the slice
 * changes by `isEqual` (identity by default; pass a structural comparison for
 * a derived object or array). Outside the provider the selector gets `null`.
 */
export function useActivitySelector<T>(
  select: (state: ActivityState | null) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(ActivityContext);
  const memo = useRef<{ state: ActivityState | null; select: unknown; value: T } | null>(null);
  const read = () => {
    const state = store?.state ?? null;
    const last = memo.current;
    if (last && last.state === state && last.select === select) return last.value;
    const next = select(state);
    const value = last && isEqual(last.value, next) ? last.value : next;
    memo.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(store?.subscribe ?? noStore, read, read);
}

const whole = (state: ActivityState | null) => state;

/**
 * All of activity. Re-renders on every poll, so only the Activity panel and
 * leaves that show most of it use this; everything else selects.
 */
export function useActivity(): ActivityState | null {
  return useActivitySelector(whole);
}

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
  const [queues, questions, tasks, inflight, requests] = await Promise.all([
    api.getQueueStatus(),
    runtimeCapabilities().structuredQuestions
      ? api.listQuestions({ pending: true })
      : { questions: [] },
    runtimeCapabilities().tasks ? api.listTasks() : { tasks: [], waiting: [] },
    api.listInflightTurns(),
    // A host without requests still lists its work, one row per task.
    api
      .listRequests()
      .catch(() => ({ requests: [] })),
  ]);
  return resolveActivity({
    queues,
    questions: questions.questions,
    tasks: tasks.tasks,
    waiting: tasks.waiting ?? [],
    inflight: inflight.inflight,
    requests: requests.requests,
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
  const [indexProgress, setIndexProgress] = useState(new Map<string, IndexProgress>());
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
    const timer = setVisibleInterval(() => {
      if (Date.now() - lastSuccess.current > 15_000) setStale(true);
      void refresh();
    }, 5_000);
    const controller = new AbortController();
    const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const indexJobs = new Map<string, IndexingJob>();
    const indexingChanged = (event: IndexProgress) => {
      const id = indexingActivityId(event);
      clearTimeout(indexTimers.get(id));
      indexTimers.delete(id);
      const job = foldIndexingJob(indexJobs.get(id), event);
      indexJobs.set(id, job);
      setIndexProgress((current) => new Map(current).set(id, job.shown));
      // A start is a live operation until its end, even during a long scan.
      // Batch-only pulses and completion receipts fade after a quiet spell.
      if (!indexingJobLive(job)) {
        indexTimers.set(
          id,
          setTimeout(() => {
            indexTimers.delete(id);
            indexJobs.delete(id);
            setIndexProgress((current) => {
              const next = new Map(current);
              next.delete(id);
              return next;
            });
          }, INDEX_ACTIVITY_LINGER_MS),
        );
      }
    };
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
    // A request's line changes when an engine starts or stops holding a
    // turn. A generating engine reports every few tokens, so only a change
    // of phase or hold refreshes.
    const lastPhase = new Map<string, string>();
    void (async () => {
      try {
        for await (const { event, sessionId } of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: controller.signal,
          fetch: api.getFetch(),
        })) {
          if (event.type === 'index_progress') indexingChanged(event);
          else if (
            event.type === 'question_asked' ||
            event.type === 'question_answered' ||
            event.type === 'task_event' ||
            event.type === 'done' ||
            event.type === 'error' ||
            event.type === 'user_message' ||
            event.type === 'cancelled' ||
            event.type === 'queue_enqueued' ||
            event.type === 'queue_removed' ||
            event.type === 'task_settled'
          )
            changed();
          else if (event.type === 'engine_phase') {
            const phase = `${event.phase}:${event.hold ?? ''}`;
            if (lastPhase.get(sessionId) !== phase) {
              lastPhase.set(sessionId, phase);
              changed();
            }
          }
        }
      } catch {
        /* Polling reconciles a disconnected event stream. */
      } finally {
        if (!controller.signal.aborted) {
          for (const timer of indexTimers.values()) clearTimeout(timer);
          indexTimers.clear();
          indexJobs.clear();
          setIndexProgress(new Map());
        }
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      timer();
      clearTimeout(eventTimer);
      for (const timer of indexTimers.values()) clearTimeout(timer);
      window.removeEventListener('gezel:config-changed', changed);
      window.removeEventListener('gezel:projects-changed', roster);
      window.removeEventListener('gezel:gezels-changed', roster);
    };
  }, [refresh]);
  const clearReceipts = useCallback(() => setReceipts([]), []);
  const combinedSnapshot = useMemo(() => {
    if (!snapshot) return null;
    const indexing = [...indexProgress.values()].map((event) =>
      indexingActivityItem(event, projects),
    );
    return {
      ...snapshot,
      items: [...withoutIndexingBackground(snapshot.items, snapshot.queues, indexing), ...indexing],
    };
  }, [snapshot, indexProgress, projects]);
  const value = useMemo(
    () => ({
      snapshot: combinedSnapshot,
      stale,
      refreshing,
      refresh,
      answered,
      receipts,
      clearReceipts,
      gezels,
      projects,
    }),
    [
      combinedSnapshot,
      stale,
      refreshing,
      refresh,
      answered,
      receipts,
      clearReceipts,
      gezels,
      projects,
    ],
  );
  const [store] = useState(() => new ActivityStore(value));
  // Published in the layout phase, so subscribers redraw in the same frame.
  useLayoutEffect(() => store.publish(value), [store, value]);
  return <ActivityContext.Provider value={store}>{children}</ActivityContext.Provider>;
}
