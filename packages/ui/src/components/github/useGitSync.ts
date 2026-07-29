import type { GitSyncResponse } from '@bendyline/gezel';
import { useCallback, useRef, useState } from 'react';
import { api } from '../../api.js';
import { GIT_COPY, syncedToast } from './gitCopy.js';

/**
 * Shared Sync behavior for the git status bar and the GitHub tab — one
 * verb, identical outcomes and toasts no matter which surface fired it.
 * A module-level in-flight guard stops the two Sync buttons from
 * double-firing against the same backend lock.
 */

let inFlightProjectId: string | null = null;

/** Both surfaces re-poll on this — fired after any git mutation. */
export const GIT_CHANGED_EVENT = 'gezel:git-changed';

export function notifyGitChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent(GIT_CHANGED_EVENT, { detail: { projectId } }));
}

export interface GitSyncCallbacks {
  onToast?: (kind: 'ok' | 'err', text: string) => void;
  /** Sync stopped on overlapping edits — navigate to the conflict flow. */
  onConflicts?: (result: GitSyncResponse) => void;
  /** Dirty tree — prompt the user to save first. */
  onNeedsSave?: () => void;
  /** PAT missing/revoked — point at Settings → Toolsets. */
  onAuth?: () => void;
}

export function useGitSync(projectId: string, callbacks: GitSyncCallbacks = {}) {
  const [syncing, setSyncing] = useState(false);
  // Callbacks live in a ref so `sync` stays referentially stable across
  // parent re-renders (it feeds effect deps downstream).
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const sync = useCallback(async (): Promise<GitSyncResponse | null> => {
    if (inFlightProjectId === projectId) return null;
    inFlightProjectId = projectId;
    setSyncing(true);
    try {
      const result = await api.syncProjectGit(projectId);
      const cb = cbRef.current;
      switch (result.state) {
        case 'synced':
          cb.onToast?.('ok', syncedToast(result));
          break;
        case 'needs-save':
          cb.onNeedsSave?.();
          break;
        case 'conflicts':
          cb.onConflicts?.(result);
          break;
        case 'auth':
          cb.onToast?.('err', GIT_COPY.syncAuth);
          cb.onAuth?.();
          break;
        case 'offline':
          cb.onToast?.('err', GIT_COPY.syncOffline);
          break;
        default:
          cb.onToast?.('err', result.message || GIT_COPY.syncGenericError);
      }
      notifyGitChanged(projectId);
      return result;
    } catch (err) {
      cbRef.current.onToast?.(
        'err',
        `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      inFlightProjectId = null;
      setSyncing(false);
    }
  }, [projectId]);

  return { sync, syncing };
}
