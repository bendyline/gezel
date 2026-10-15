import type { MediaMemoryPool, MediaModelFit, MediaModelFitResponse } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The daemon's verdict on which image or video models this machine can run
 * (docs/media-model-memory.md). Shared by the image and video download pages
 * and the first-run media picker so they hide, warn and recommend alike.
 */

export interface MediaFitState {
  /** Verdict per catalog id; null while loading or when the daemon could not answer. */
  byId: Map<string, MediaModelFit> | null;
  pool: MediaMemoryPool | null;
}

export function mediaFitState(res: MediaModelFitResponse | null): MediaFitState {
  if (!res || !Array.isArray(res.models)) return { byId: null, pool: null };
  return { byId: new Map(res.models.map((m) => [m.id, m])), pool: res.pool };
}

/**
 * Load the verdicts once. Without them nothing is hidden: hiding is only ever
 * the daemon's call, never a guess on this side.
 */
export function useMediaModelFit(kind: 'image' | 'video'): MediaFitState {
  const [state, setState] = useState<MediaFitState>({ byId: null, pool: null });
  useEffect(() => {
    let cancelled = false;
    const load = kind === 'image' ? api.getImageModelFit() : api.getVideoModelFit();
    void load
      .then((res) => {
        if (!cancelled) setState(mediaFitState(res));
      })
      .catch(() => {
        /* An older daemon or a machine broker without the endpoint: show everything. */
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return state;
}

/** Hidden by default: the daemon would refuse to start it on this machine. */
export function hiddenByFit(fit: MediaModelFit | undefined): boolean {
  return fit?.verdict === 'wont-run';
}

function gb(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} GB`;
}

const WARNING_LABEL: Partial<Record<MediaModelFit['verdict'], string>> = {
  'wont-run': 'too large for this machine',
  'may-not-run': 'may not fit this machine',
  'over-limit': 'over your memory limit',
  tight: 'may run short of graphics memory',
};

/** The memory figure and any warning for one catalog row's spec line. */
export function MediaFitNote({ fit }: { fit: MediaModelFit | undefined }) {
  if (!fit) return null;
  const warning = WARNING_LABEL[fit.verdict];
  const figure = `needs ~${gb(fit.neededBytes)} ${fit.pool === 'discrete' ? 'graphics memory' : 'memory'}`;
  return (
    <>
      <span>·</span>
      <span title={fit.exact ? undefined : 'Estimated: the exact size could not be checked.'}>
        {figure}
      </span>
      {warning && (
        <>
          <span>·</span>
          <span className="catalog-ollama-warn" title={fit.reason}>
            {warning}
          </span>
        </>
      )}
      {fit.pool === 'cpu' && (
        <>
          <span>·</span>
          <span
            className="catalog-ollama-warn"
            title="This machine has no graphics processor the engine can use, so it generates on the processor. Expect it to be very slow."
          >
            runs on the processor (slow)
          </span>
        </>
      )}
    </>
  );
}

/**
 * The confirmation a download needs before it starts, or null when none is
 * needed. A model that cannot run here is not offered at all.
 */
export function fitConfirmMessage(
  name: string,
  fit: MediaModelFit | undefined,
  sizeBytes: number,
): string | null {
  if (!fit || fit.verdict === 'fits' || fit.verdict === 'wont-run') return null;
  return `${name} may not run well on this machine. ${fit.reason} Download this ${gb(sizeBytes)} model anyway?`;
}

/** "N models are hidden" line with the Show all toggle, in the chat-model page's words. */
export function HiddenModelsToggle({
  hiddenCount,
  showAll,
  onToggle,
}: {
  hiddenCount: number;
  showAll: boolean;
  onToggle: () => void;
}) {
  if (hiddenCount === 0) return null;
  return (
    <p className="muted small">
      {showAll
        ? 'Showing models too large for this machine. '
        : `${hiddenCount} model${hiddenCount === 1 ? ' is' : 's are'} too large for this machine and hidden. `}
      <button type="button" className="gz-link-button" onClick={onToggle} style={{ padding: 0 }}>
        {showAll ? 'Hide models too large for this machine' : 'Show all models'}
      </button>
    </p>
  );
}
