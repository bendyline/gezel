/**
 * ClaudeCliPoolPill
 *
 * Always-visible status indicator for the Claude CLI worker pool. Sits in
 * the app header alongside `EngineStatusPill` (on-device engines) and
 * `QueueMeter` (provider request queues) — but distinct from both because
 * the Claude CLI surface has its own resource model: a session-affinitized
 * pool of long-lived `claude` subprocesses.
 *
 * Visible whenever the pool has at least one warm worker (i.e. at least
 * one Claude CLI session has been used since service start). When idle
 * with no warm workers, the pill hides — same hiding rule as
 * `EngineStatusPill` to avoid carpet-bombing the header with disabled
 * indicators.
 *
 * Visual states:
 *   1. **Idle** — muted "Claude CLI · 2/4 warm" with a static dot.
 *   2. **Active** — at least one worker mid-turn → pulsing green dot
 *      and the "active" worker count up front ("1 active · 2/4 warm").
 *
 * Click opens a dropdown listing each warm worker pinned to its (gezel,
 * project) pair, with a per-row idle/active light and a relative
 * "last used Ns ago" timestamp. Eviction is invisible by design — the
 * pool keeps the LRU N warmest sessions; the pill just shows what's
 * currently around.
 *
 * Polls `/api/queues` every 3s (sharing cadence with `QueueMeter` /
 * `EngineStatusPill`). The endpoint is in-memory — basically free.
 */

import type { ClaudeCliPoolView } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatRelativeTime } from '../relative-time.js';

/** Polling cadence; matches QueueMeter / EngineStatusPill. */
const POLL_MS = 3_000;

export function ClaudeCliPoolPill() {
  const [pool, setPool] = useState<ClaudeCliPoolView | null>(null);
  // Bumps every 1s while the popover is open so per-row "5s ago"
  // timestamps tick. Outside the popover the 3s `pool` poll handles
  // freshness.
  const [, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await api.getQueueStatus();
      if (!mountedRef.current) return;
      setPool(status.anthropicCliPool ?? null);
    } catch {
      /* non-fatal — pill will retry on next tick */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Per-row "Ns ago" needs a ticker while the dropdown is open.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [open]);

  // Click-outside dismissal — same pattern as EngineStatusPill.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Cooperative dismiss when other header popovers open.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('gezel:close-header-popovers', close);
    return () => window.removeEventListener('gezel:close-header-popovers', close);
  }, []);

  if (!pool || pool.workers.length === 0) return null;

  const activeCount = pool.workers.filter((w) => !w.idle && w.alive).length;
  const isActive = activeCount > 0;
  const label = isActive
    ? `${activeCount} active · ${pool.size}/${pool.poolSize} warm`
    : `${pool.size}/${pool.poolSize} warm`;
  const tooltip = isActive
    ? `Claude CLI: ${activeCount} subprocess${activeCount === 1 ? '' : 'es'} mid-turn (${pool.size} of ${pool.poolSize} warm)`
    : `Claude CLI: ${pool.size} of ${pool.poolSize} warm subprocesses idle`;

  return (
    <div className="engine-pill-root" ref={rootRef}>
      <button
        type="button"
        className={`engine-pill${isActive ? ' engine-pill-busy' : ''}`}
        onClick={() => {
          window.dispatchEvent(new CustomEvent('gezel:close-header-popovers'));
          setOpen((v) => !v);
        }}
        title={tooltip}
        aria-expanded={open}
      >
        <span
          className={`engine-pill-dot${isActive ? ' engine-pill-dot-busy' : ''}`}
          aria-hidden="true"
        />
        <span className="engine-pill-label">Claude CLI · {label}</span>
      </button>
      {open && (
        <div className="engine-pill-popover">
          <div className="engine-pill-popover-header">Claude CLI workers</div>
          <ul className="claude-cli-pool-list">
            {pool.workers.map((w) => {
              const ago = formatRelativeTime(w.lastUsedAt, { seconds: true });
              const busy = !w.idle && w.alive;
              return (
                <li key={w.sessionId} className="claude-cli-pool-row">
                  <span
                    className={`engine-pill-dot${busy ? ' engine-pill-dot-busy' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="claude-cli-pool-name">
                    <strong>{w.gezelName}</strong>
                    <span className="muted"> · {w.projectName}</span>
                  </span>
                  <span className="muted claude-cli-pool-ago">{busy ? 'active' : ago}</span>
                </li>
              );
            })}
          </ul>
          <div className="engine-pill-popover-footnote muted">
            Pool size: {pool.poolSize}. The least-recently-used non-busy worker is evicted when a
            new session needs a slot.
          </div>
        </div>
      )}
    </div>
  );
}
