import type { Diffpack } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';

/**
 * Owns the change-proposal list for one project: fetch + poll (fast while
 * something is still being drafted, slow otherwise), apply, and dismiss.
 *
 * Mirrors `useCodeReviews` — same cadence, same "keep the last good list on a
 * failed refresh" stance — because both are watching background work that a
 * gezel finishes on its own schedule.
 */

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/** Raised after an apply so any other surface showing this project refetches. */
export const DIFFPACKS_CHANGED_EVENT = 'gezel:diffpacks-changed';

export interface ApplyOutcome {
  ok: boolean;
  /** Paths that changed under the proposal; empty unless this was a drift refusal. */
  drifted: string[];
  message: string;
}

function driftedPaths(err: unknown): string[] | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('drifted')) return null;
  // The route answers `{ code: 'drifted', paths }`; the client surfaces it as
  // the response text, so recover the list rather than making the user guess
  // which file moved.
  const match = message.match(/"paths"\s*:\s*(\[[^\]]*\])/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

export function useDiffpacks(projectId: string) {
  const [diffpacks, setDiffpacks] = useState<Diffpack[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await api.listDiffpacks(projectId);
      setDiffpacks(res.diffpacks);
    } catch {
      // Best-effort: the list keeps its last good state.
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  const anyDrafting = diffpacks.some((p) => p.status === 'drafting');
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      anyDrafting ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === projectId) void refresh();
    };
    window.addEventListener(DIFFPACKS_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(DIFFPACKS_CHANGED_EVENT, onChanged);
    };
  }, [refresh, projectId, anyDrafting]);

  /**
   * Apply a proposal, or the `paths` subset of it.
   *
   * A drift refusal comes back as an outcome rather than an exception: the
   * caller has to be able to name the files that moved and offer to go ahead
   * anyway, which is a conversation, not an error.
   */
  const apply = useCallback(
    async (
      packId: string,
      opts: { paths?: string[]; allowDrifted?: boolean } = {},
    ): Promise<ApplyOutcome> => {
      setBusy(packId);
      try {
        const res = await api.applyDiffpack(projectId, packId, opts);
        await refresh();
        window.dispatchEvent(new CustomEvent(DIFFPACKS_CHANGED_EVENT, { detail: { projectId } }));
        const failed = res.results.filter((r) => !r.ok);
        return {
          ok: res.ok,
          drifted: [],
          message: res.ok
            ? `Applied ${res.results.length} file${res.results.length === 1 ? '' : 's'}.`
            : `Couldn’t apply: ${failed[0]?.error ?? 'the change didn’t fit the current file.'}`,
        };
      } catch (err) {
        const drifted = driftedPaths(err);
        if (drifted) {
          return {
            ok: false,
            drifted,
            message:
              drifted.length > 0
                ? `${drifted.join(', ')} changed since this was drafted.`
                : 'Some files changed since this was drafted.',
          };
        }
        return {
          ok: false,
          drifted: [],
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        setBusy('');
      }
    },
    [projectId, refresh],
  );

  const dismiss = useCallback(
    async (packId: string): Promise<string | null> => {
      setBusy(packId);
      try {
        await api.dismissDiffpack(projectId, packId);
        await refresh();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        setBusy('');
      }
    },
    [projectId, refresh],
  );

  return { diffpacks, loaded, busy, refresh, apply, dismiss };
}

/**
 * Just "does this project have any proposals?", for the tab strip.
 *
 * Separate from {@link useDiffpacks} so mounting the project shell does not
 * start the review pane's 5-second poll on every project the user opens. One
 * fetch, plus a refetch when something applies or a new proposal lands.
 */
export function useDiffpackCount(projectId: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = () => {
      void api
        .listDiffpacks(projectId)
        .then((res) => {
          if (!cancelled) setCount(res.diffpacks.length);
        })
        .catch(() => {});
    };
    load();
    const onChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.projectId === projectId) load();
    };
    window.addEventListener(DIFFPACKS_CHANGED_EVENT, onChanged);
    // Slow heartbeat: a proposal appearing overnight should show up without
    // a reload, but this is a tab badge, not a live view.
    const interval = window.setInterval(load, IDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(DIFFPACKS_CHANGED_EVENT, onChanged);
    };
  }, [projectId]);

  return count;
}
