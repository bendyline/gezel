import type { ActiveImagePull, ImageModelPullEvent } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export interface ActivePull {
  id: string;
  bytesWritten: number;
  totalBytes: number;
  error?: string;
  /**
   * Most-recent `retrying` SSE event. Present when the shared
   * downloader is waiting between attempts. Cleared on the next
   * `progress` event (resumption happened) or when the install
   * completes / errors. UI uses this to show "Connection dropped —
   * retrying in 4s (attempt 3/5)…" instead of a stuck progress bar.
   */
  retrying?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  };
}

type PullStream = (
  id: string,
  onEvent: (event: ImageModelPullEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/** One service-side pull registry, as the client reaches it. Keep it module-level: it must be stable. */
export interface ImagePullEndpoints {
  list(): Promise<{ pulls: ActiveImagePull[] }>;
  start: PullStream;
  subscribe: PullStream;
  cancel(id: string): Promise<unknown>;
}

/**
 * The downloads of one registry: their progress rows, and start, retry and
 * cancel. The service owns each download; detaching a listener (leaving the
 * page) does not cancel it, and a returning page re-attaches to what is
 * still running. `onDone` runs after a download finishes.
 */
export function useImagePulls(endpoints: ImagePullEndpoints, onDone: () => void) {
  const [pulls, setPulls] = useState<Map<string, ActivePull>>(new Map());
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;
  const subscriptions = useRef(new Map<string, AbortController>());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  /**
   * Own one listener per pull, independently of React's queued state updates.
   * The service owns the download; detaching a listener does not cancel it.
   */
  const attachSubscription = useCallback((id: string, stream: PullStream) => {
    if (subscriptions.current.has(id)) return;
    const controller = new AbortController();
    subscriptions.current.set(id, controller);
    setPulls((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      next.set(id, {
        ...(cur ?? { id, bytesWritten: 0, totalBytes: 0 }),
      });
      return next;
    });
    void stream(
      id,
      (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'progress') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (!cur) return prev;
            const { retrying: _drop, ...rest } = cur;
            next.set(id, {
              ...rest,
              bytesWritten: event.bytesWritten,
              totalBytes: event.totalBytes ?? cur.totalBytes,
            });
            return next;
          });
        } else if (event.type === 'retrying') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (!cur) return prev;
            next.set(id, {
              ...cur,
              retrying: {
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
                reason: event.reason,
              },
            });
            return next;
          });
        } else if (event.type === 'error') {
          setPulls((prev) => {
            const next = new Map(prev);
            const cur = next.get(id);
            if (cur) next.set(id, { ...cur, error: event.error, retrying: undefined });
            return next;
          });
        } else if (event.type === 'done') {
          // Brief grace window lets the bar stay at 100% before the
          // entry collapses into the Installed list above.
          setTimeout(() => {
            if (controller.signal.aborted) return;
            subscriptions.current.delete(id);
            setPulls((prev) => {
              const next = new Map(prev);
              next.delete(id);
              return next;
            });
            onDoneRef.current();
          }, 800);
        }
      },
      controller.signal,
    ).catch((err) => {
      if (controller.signal.aborted) return;
      setPulls((prev) => {
        const next = new Map(prev);
        const cur = next.get(id);
        if (cur) next.set(id, { ...cur, error: (err as Error).message });
        return next;
      });
    });
  }, []);

  useEffect(() => {
    const controllers = subscriptions.current;
    // Re-attach to any pull the registry started in a previous mount.
    // Without this, leaving Settings → Image generation mid-download and
    // coming back would silently lose the progress bar.
    let cancelled = false;
    void endpoints
      .list()
      .then(({ pulls: active }) => {
        if (cancelled) return;
        for (const snapshot of active) {
          if (snapshot.finished) continue;
          setPulls((prev) => {
            if (prev.has(snapshot.id)) return prev;
            const next = new Map(prev);
            next.set(snapshot.id, {
              id: snapshot.id,
              bytesWritten: snapshot.bytesWritten,
              totalBytes: snapshot.totalBytes,
              ...(snapshot.retrying ? { retrying: snapshot.retrying } : {}),
              ...(snapshot.error ? { error: snapshot.error } : {}),
            });
            return next;
          });
          attachSubscription(snapshot.id, endpoints.subscribe);
        }
      })
      .catch(() => {
        /* server may be down; nothing to reattach */
      });
    return () => {
      cancelled = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, [endpoints, attachSubscription]);

  const startPull = useCallback(
    (id: string) => {
      if (pullsRef.current.has(id)) return;
      attachSubscription(id, endpoints.start);
    },
    [endpoints, attachSubscription],
  );

  const retryPull = useCallback(
    (id: string) => {
      // Retry is allowed to replace the terminal row that is still in
      // `pullsRef`. Calling startPull here would see that stale row during
      // this React tick and return without starting anything, even after a
      // queued setPulls(delete). Attach directly so the fresh subscription
      // is enqueued immediately; React applies these state updates in order.
      subscriptions.current.get(id)?.abort();
      subscriptions.current.delete(id);
      setPulls((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      attachSubscription(id, endpoints.start);
    },
    [endpoints, attachSubscription],
  );

  const cancelPull = useCallback(
    (id: string) => {
      // Tell the registry to actually abort the download. We optimistically
      // remove the row; the SSE will close shortly after with an error
      // event that we ignore since the entry is already gone.
      subscriptions.current.get(id)?.abort();
      subscriptions.current.delete(id);
      setPulls((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      void endpoints.cancel(id).catch(() => {
        /* best effort — the abort above stops the local SSE either way */
      });
    },
    [endpoints],
  );

  return { pulls, startPull, retryPull, cancelPull };
}

export function ImagePullProgress({
  pull,
  label,
  onCancel,
  onRetry,
}: {
  pull: ActivePull;
  /** What to call the download; its id when absent. */
  label?: string;
  onCancel: () => void;
  /** Called when the user clicks the manual Retry link after all auto-retries
   *  have been exhausted. Starts a fresh pull for the same id — the
   *  shared downloader resumes from the existing `.partial` on disk. */
  onRetry: () => void;
}) {
  const known = pull.totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((pull.bytesWritten / pull.totalBytes) * 100)) : 0;
  // Status line precedence: hard error > active retry (no error yet) > normal progress.
  let statusLine: string;
  if (pull.error) {
    statusLine = pull.error;
  } else if (pull.retrying) {
    const delaySec = Math.max(1, Math.round(pull.retrying.delayMs / 1000));
    statusLine = `${pull.retrying.reason} — retrying in ${delaySec}s (attempt ${pull.retrying.attempt}/${pull.retrying.maxAttempts})`;
  } else if (known) {
    statusLine = `Downloading… (${formatSize(pull.bytesWritten)} of ${formatSize(pull.totalBytes)}, ${pct}%)`;
  } else if (pull.bytesWritten > 0) {
    statusLine = `Downloading… (${formatSize(pull.bytesWritten)})`;
  } else {
    statusLine = 'Preparing download…';
  }
  return (
    <div
      className={`ollama-pull${pull.error ? ' ollama-pull-error' : pull.retrying ? ' ollama-pull-warning' : ''}`}
    >
      <div className="ollama-pull-head">
        {label ? <span>{label}</span> : <code>{pull.id}</code>}
        <span className="muted small">{statusLine}</span>
        {pull.error ? (
          <button type="button" className="gz-link-button" onClick={onRetry}>
            Retry
          </button>
        ) : (
          <button type="button" className="gz-link-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {known ? (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${pct}%` }} />
          <span className="ollama-pull-bar-label">{pct}%</span>
        </div>
      ) : (
        <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
          <div className="ollama-pull-bar-fill" />
        </div>
      )}
    </div>
  );
}
