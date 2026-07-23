/**
 * Growth-tab state hook. Owns the character-sheet payload plus the
 * accept/decline/skip/retire mutations — every mutation swaps in the
 * full payload the server returns, so the UI never stitches partial
 * state. After an accept, the gezel itself changed (frontmatter traits,
 * tuning, poppetje accessories), so we re-fetch it and broadcast
 * `gezel:gezel-updated` for the roster/sidebar/prompt surfaces.
 */

import type { GezelGrowthResponse } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

function errorMessage(err: unknown): string {
  if (err instanceof GezelApiError) {
    const details = err.details as { error?: string } | string | undefined;
    if (typeof details === 'object' && details?.error) return details.error;
    if (typeof details === 'string' && details) return details;
  }
  return err instanceof Error ? err.message : String(err);
}

/** A 409 on accept/decline means another window already resolved it. */
function isResolvedElsewhere(err: unknown): boolean {
  return (
    err instanceof GezelApiError &&
    err.status === 409 &&
    errorMessage(err).includes('no pending level-up')
  );
}

export interface UseGezelGrowth {
  growth: GezelGrowthResponse | null;
  error: string | null;
  /** Transient operation feedback (race notices, slot-cap refusals). */
  notice: string | null;
  clearNotice: () => void;
  /** Proposal id with an accept/decline in flight — disables siblings. */
  busyId: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  accept: (proposalId: string) => Promise<void>;
  decline: (proposalId: string) => Promise<void>;
  skipLevel: () => Promise<void>;
  retireTrait: (traitId: string) => Promise<void>;
}

export function useGezelGrowth(gezelId: string, onUpdated?: () => void): UseGezelGrowth {
  const [growth, setGrowth] = useState<GezelGrowthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setGrowth(await api.getGezelGrowth(gezelId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [gezelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // SSE level-up events arrive as window events (App.tsx fan-out).
  useEffect(() => {
    const onGrowthUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { gezelId?: string } | undefined;
      if (!detail?.gezelId || detail.gezelId === gezelId) void load();
    };
    window.addEventListener('gezel:growth-updated', onGrowthUpdated);
    return () => window.removeEventListener('gezel:growth-updated', onGrowthUpdated);
  }, [gezelId, load]);

  /** Frontmatter changed server-side — let every other surface know. */
  const broadcastGezelUpdated = useCallback(async () => {
    try {
      const detail = await api.getGezel(gezelId);
      window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail }));
    } catch {
      /* roster just refreshes on its own next cycle */
    }
    onUpdated?.();
  }, [gezelId, onUpdated]);

  const run = useCallback(
    async (
      proposalId: string | null,
      op: () => Promise<GezelGrowthResponse>,
      mutatesGezel: boolean,
    ) => {
      setBusyId(proposalId ?? '*');
      setNotice(null);
      try {
        setGrowth(await op());
        if (mutatesGezel) await broadcastGezelUpdated();
      } catch (err) {
        if (isResolvedElsewhere(err)) {
          setNotice('This level-up was already resolved in another window.');
        } else {
          setNotice(errorMessage(err));
        }
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [broadcastGezelUpdated, load],
  );

  const accept = useCallback(
    (proposalId: string) =>
      run(proposalId, () => api.acceptGrowthProposal(gezelId, proposalId), true),
    [gezelId, run],
  );

  const decline = useCallback(
    (proposalId: string) =>
      run(proposalId, () => api.declineGrowthLevelUp(gezelId, proposalId), false),
    [gezelId, run],
  );

  const skipLevel = useCallback(
    () => run(null, () => api.declineGrowthLevelUp(gezelId), false),
    [gezelId, run],
  );

  const retireTrait = useCallback(
    (traitId: string) => run(null, () => api.retireGrowthTrait(gezelId, traitId), true),
    [gezelId, run],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      setGrowth(await api.refreshGezelGrowth(gezelId));
      setError(null);
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }, [gezelId]);

  return {
    growth,
    error,
    notice,
    clearNotice: useCallback(() => setNotice(null), []),
    busyId,
    refreshing,
    refresh,
    accept,
    decline,
    skipLevel,
    retireTrait,
  };
}
