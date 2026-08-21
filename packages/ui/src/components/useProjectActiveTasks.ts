import type { ChatEventEnvelope, Task, TaskWaitState } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';

/** Debounce for task re-reads triggered by a burst of `task_event`s. */
const TASK_REFRESH_DEBOUNCE_MS = 750;

/**
 * Re-read cadence while the runner is holding work. `waiting` is runtime
 * state that moves without emitting a `task_event` — a provider slot
 * frees, a night window opens — so a queue card would otherwise keep
 * claiming a task is "about to start" long after it did. Only armed
 * while something is actually waiting, so an idle project still polls
 * nothing.
 */
const WAITING_REFRESH_MS = 15_000;

/**
 * The project's `status: 'active'` tasks — the ones the scheduler ticks,
 * and the only ones worth a pill.
 *
 * Kept apart from {@link useChatThreadPills} because tasks and threads
 * invalidate on unrelated signals, and a surface may want one without the
 * other. Rides the same shared project SSE stream, which fans durable
 * `task_event`s onto the project channel, so a task completing elsewhere
 * drops its pill without polling.
 */
export function useProjectActiveTasks({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey?: number | undefined;
}): { tasks: Task[]; waiting: TaskWaitState[]; loading: boolean } {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [waiting, setWaiting] = useState<TaskWaitState[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.listProjectTasks(projectId, { status: 'active' });
      setTasks(res.tasks);
      setWaiting(res.waiting ?? []);
    } catch {
      // Keep the last good list rather than blanking the row.
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a bump counter — incrementing it is the re-fetch trigger.
  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, refreshKey]);

  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const schedule = () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void load();
      }, TASK_REFRESH_DEBOUNCE_MS);
    };

    void (async () => {
      try {
        for await (const env of streamSharedProjectChatEvents({
          url: api.projectEventsUrl(projectId),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          if ((env as ChatEventEnvelope).event.type === 'task_event') schedule();
        }
      } catch {
        /* stream ended or aborted */
      }
    })();

    return () => {
      ctrl.abort();
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [projectId, load]);

  const anyWaiting = waiting.length > 0;
  useEffect(() => {
    if (!anyWaiting) return;
    const timer = window.setInterval(() => void load(), WAITING_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [anyWaiting, load]);

  return { tasks, waiting, loading };
}
