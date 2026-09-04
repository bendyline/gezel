import { GezelApiError } from '@bendyline/gezel-client';
import { useState } from 'react';
import { api } from '../api.js';
import { Popover } from '../primitives/index.js';
import { formatContextWindow } from './model-context.js';

/**
 * How full one thread's context window is, and the policy that governs it.
 * Seeded from the session record (survives reloads) and refreshed by the
 * `context_window` / `context_warning` chat events as turns run.
 */
export interface ContextMeterStatus {
  /** Effective token window the session's engine was built with. */
  numCtx: number;
  /**
   * Prompt size measured by the live provider session on the most recent
   * turn, in the daemon's chars/4 units. Includes the standing prefix
   * (system prompt, about.md, tool schemas), which is why it is preferred
   * over {@link transcriptTokens}. Absent until this thread runs a turn.
   */
  estimatedTokens?: number;
  /**
   * Size of the transcript on disk, in the same units. Always available —
   * it needs no turn to have run — but it is a floor: the standing prefix
   * lives in the live session and cannot be reconstructed from the record.
   */
  transcriptTokens?: number;
  /** Fill fraction at which the runtime compacts automatically. */
  autoCompactRatio?: number;
  /** Compactions this thread has already been through. */
  compactionCount?: number;
  model?: string;
  /** Automatic compaction ran and could not reduce the thread further. */
  compactionFailed?: boolean;
}

const RING_PATH_LENGTH = 100;

function errorMessage(err: unknown): string {
  if (err instanceof GezelApiError && err.details && typeof err.details === 'object') {
    const detail = (err.details as { error?: unknown }).error;
    if (typeof detail === 'string') return detail;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Circular fill gauge for the ACTIVE thread's context window, sat beside the
 * thread picker. Only local and remote-local engines report a window, so the
 * meter is absent for cloud providers that manage history themselves.
 *
 * The ring is the fill; the popover carries the numbers, the policy, and the
 * manual compaction escape hatch. This replaced a full-width strip above the
 * timeline that spent a whole band of the frame restating two constants.
 */
export function ContextMeter({
  status,
  sessionId,
}: {
  status: ContextMeterStatus | null | undefined;
  /** Thread the "Compact now" action targets. Omitted = read-only meter. */
  sessionId?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  if (!status || !(status.numCtx > 0)) return null;

  const { numCtx, estimatedTokens, transcriptTokens, autoCompactRatio, compactionCount, model } =
    status;
  // Prefer the measured figure; the transcript tally is the floor that keeps
  // the meter honest on a thread that has not run a turn on this daemon.
  const inUse = estimatedTokens ?? transcriptTokens;
  const measured = estimatedTokens !== undefined;
  const rawPercent = inUse === undefined ? null : Math.round((100 * inUse) / numCtx);
  const fill = rawPercent === null ? 0 : Math.max(0, Math.min(100, rawPercent));
  const compactPercent =
    autoCompactRatio === undefined ? undefined : Math.round(autoCompactRatio * 100);
  const tone = status.compactionFailed
    ? 'critical'
    : rawPercent !== null && rawPercent >= Math.min(compactPercent ?? 80, 80)
      ? 'warn'
      : '';
  const windowLabel = `${formatContextWindow(numCtx)}-token context`;
  const label = rawPercent === null ? formatContextWindow(numCtx) : `${fill}%`;
  const summary =
    rawPercent === null
      ? `${windowLabel} in this thread — nothing measured yet`
      : `This thread fills ${measured ? 'about' : 'at least'} ${fill}% of its ${windowLabel}`;

  const compactNow = async () => {
    if (!sessionId) return;
    setCompacting(true);
    setCompactError(null);
    try {
      await api.compactChatSession(sessionId);
      // The daemon publishes `context_compacted`; the meter and the timeline
      // both follow that event, so there is nothing to reconcile here.
      setOpen(false);
    } catch (err) {
      setCompactError(errorMessage(err));
    } finally {
      setCompacting(false);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCompactError(null);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`context-meter${tone ? ` context-meter-${tone}` : ''}`}
          aria-label={`Thread context: ${summary}`}
          title={summary}
        >
          <span className="context-meter-ring-wrap">
            <svg className="context-meter-ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle
                className="context-meter-ring-bg"
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                strokeWidth="5"
              />
              <circle
                className="context-meter-ring-fill"
                cx="18"
                cy="18"
                r="15.5"
                fill="none"
                strokeWidth="5"
                pathLength={RING_PATH_LENGTH}
                strokeDasharray={`${fill} ${RING_PATH_LENGTH - fill}`}
                strokeDashoffset="25"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="context-meter-label">{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Content className="context-meter-popover" side="bottom" align="end">
        <div className="context-meter-popover-header">This thread&rsquo;s context</div>
        <dl className="context-meter-stats">
          {model && (
            <>
              <dt>Model</dt>
              <dd>{model}</dd>
            </>
          )}
          <dt>Window</dt>
          <dd>{formatContextWindow(numCtx)} tokens</dd>
          <dt>In use</dt>
          <dd>
            {inUse === undefined
              ? 'Not measured yet'
              : `${measured ? '~' : 'at least '}${inUse.toLocaleString()} tokens (${fill}%)`}
          </dd>
          <dt>Auto-compaction</dt>
          <dd>{compactPercent === undefined ? 'On' : `At ${compactPercent}% full`}</dd>
          {compactionCount !== undefined && compactionCount > 0 && (
            <>
              <dt>Compactions</dt>
              <dd>{compactionCount} so far</dd>
            </>
          )}
        </dl>
        {status.compactionFailed ? (
          <p className="context-meter-note context-meter-note-warn">
            Automatic compaction could not reduce this thread. The runtime will still apply its
            deterministic fit safeguards, but a fresh thread will think more clearly.
          </p>
        ) : (
          <p className="context-meter-note">
            {measured
              ? 'Counts this thread only, measured before the last turn ran.'
              : 'Counted from the messages on disk. The system prompt and tool list add a few thousand tokens on top; the exact figure lands after the next turn.'}{' '}
            Older messages are summarized automatically when the thread fills up.
          </p>
        )}
        {sessionId && (
          <>
            <button
              type="button"
              className="context-meter-action"
              onClick={() => void compactNow()}
              disabled={compacting}
            >
              {compacting ? 'Compacting…' : 'Compact now'}
            </button>
            {compactError && (
              <p className="context-meter-note context-meter-note-warn">{compactError}</p>
            )}
          </>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}
