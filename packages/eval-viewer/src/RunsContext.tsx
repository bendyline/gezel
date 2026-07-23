import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { staticRuns } from './data.js';
import type { RunsIndex } from './types.js';

const POLL_MS = 60_000;

interface RunsState {
  runs: RunsIndex;
  /** Epoch ms of the last successful /api/index fetch, or null if still on the static seed. */
  lastUpdated: number | null;
}

const RunsContext = createContext<RunsState>({ runs: staticRuns, lastUpdated: null });

/**
 * Polls /api/index every few seconds and hands the freshest RunsIndex to
 * the tree. Seeds from the build-time snapshot for instant first paint;
 * if the endpoint is unavailable (production `vite preview`, no dev
 * server), it silently keeps showing the seed — the dashboard degrades to
 * the old static behavior rather than erroring.
 */
export function RunsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RunsState>({ runs: staticRuns, lastUpdated: null });
  // Guard against overlapping/stale fetches updating state out of order.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch('/api/index', { cache: 'no-store' });
        if (res.ok) {
          const next = (await res.json()) as RunsIndex;
          if (alive.current) setState({ runs: next, lastUpdated: Date.now() });
        }
      } catch {
        // Endpoint unreachable — keep the last good snapshot.
      } finally {
        if (alive.current) timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);

  return <RunsContext.Provider value={state}>{children}</RunsContext.Provider>;
}

/** The current RunsIndex — refreshes automatically as polls land. */
export function useRuns(): RunsIndex {
  return useContext(RunsContext).runs;
}

/** Polling metadata for the live indicator in the header. */
export function useRunsMeta(): { lastUpdated: number | null } {
  const { lastUpdated } = useContext(RunsContext);
  return { lastUpdated };
}

/**
 * A coarse clock that re-renders the caller on an interval — used for live
 * elapsed timers and the "updated Ns ago" label. Kept local to the few
 * components that need it so it never re-renders the whole trial table.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
