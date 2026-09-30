import type {
  ChatEventEnvelope,
  ReferencedFile,
  Task,
  TaskDeliverable,
  TaskOutputsResponse,
} from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';

/** A step advance writes several history events in a burst; read once after it. */
const TASK_EVENT_DEBOUNCE_MS = 750;

/**
 * Call `onEvent` (debounced) whenever the task identified by `taskRef`
 * records a durable event — a step advance, a status change, a note. Rides
 * the shared project event stream, so a surface showing one task adds no
 * connection of its own.
 */
export function useTaskEvents(
  projectId: string | undefined,
  taskRef: string | undefined,
  onEvent: () => void,
): void {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => {
    if (!projectId || !taskRef || !runtimeCapabilities().tasks) return;
    const ctrl = new AbortController();
    let timer: number | null = null;
    void (async () => {
      try {
        for await (const env of streamSharedProjectChatEvents({
          url: api.projectEventsUrl(projectId),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const event = (env as ChatEventEnvelope).event;
          if (event.type !== 'task_event' || event.taskRef !== taskRef) continue;
          if (timer !== null) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            timer = null;
            latest.current();
          }, TASK_EVENT_DEBOUNCE_MS);
        }
      } catch {
        /* stream ended or aborted */
      }
    })();
    return () => {
      ctrl.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [projectId, taskRef]);
}

/**
 * What a task has made: its deliverable (null until one exists) and every
 * output. `version` is any value that changes when the task may have made
 * something new — the task's `updatedAt` is the usual choice — so a surface
 * that already re-reads its task on events gets the result for free.
 */
export function useTaskResult(
  task: Pick<Task, 'projectId' | 'num'> | null,
  version?: unknown,
): TaskOutputsResponse | null {
  const [result, setResult] = useState<TaskOutputsResponse | null>(null);
  const projectId = task?.projectId;
  const num = task?.num;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the re-read trigger
  useEffect(() => {
    if (!projectId || num === undefined || runtimeCapabilities().taskOutputs === false) {
      setResult(null);
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => api.getTaskOutputs(projectId, num))
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch(() => {
        // An older daemon has no outputs route; the surface simply shows
        // no deliverable rather than an error about a missing feature.
        if (!cancelled) setResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, num, version]);
  return result;
}

/** The deliverable's plain file reference, for the open handlers. */
export function deliverableFile(deliverable: TaskDeliverable): ReferencedFile {
  return { kind: deliverable.kind, path: deliverable.path };
}
