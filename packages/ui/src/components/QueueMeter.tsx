/**
 * QueueMeter
 *
 * Live indicator of pending LLM provider work. Sits next to the
 * QuotaMeter in the app header. Stays invisible on the happy path
 * (no queued or running turns); as soon as the provider queue has
 * anything in it, a small chip per active provider shows the depth.
 * Clicking opens a popover with the full breakdown.
 *
 * Polls `/api/queues` every 3 seconds — provider queues change fast
 * (a 2-turn backlog drains in seconds), so the 10s interval the
 * QuotaMeter uses would feel sluggish. Still cheap: the endpoint
 * just reads in-memory counts.
 */

import type { GezelSummary } from '@bendyline/gezel';
import type {
  ConfigResponse,
  ProviderQueueState,
  QueueStatusResponse,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { queueOpenSession } from './pending-open-session.js';
import { providerLabel } from './provider-label.js';
import { type LiveTurnState, useOnDeviceLiveTurns } from './useOnDeviceLiveTurns.js';

type ProviderName = 'copilot' | 'openai' | 'ollama' | 'llama-cpp' | 'mlx' | 'ds4';

const PROVIDER_ORDER: ProviderName[] = ['copilot', 'openai', 'ollama', 'llama-cpp', 'mlx', 'ds4'];

// Platform read once per render — `providerLabel` uses it to pick
// "This Windows PC" / "This Linux device" / "On-device" for the
// llama-cpp chip. Bridge value is process.platform; undefined in the
// plain-web build (the helper falls back to "On-device").
function getPlatformPillLabel(name: ProviderName): string {
  return providerLabel(name, window.__GEZEL__?.platform);
}
// Short form ("Windows" / "Linux" / "Mac") used by the chip's
// container-query fallback when the titlebar slot is too narrow for
// the full label. CSS in styles.css picks which of the two spans is
// visible — see `.queue-meter-chip-label-full` / `-short` rules.
function getCompactPillLabel(name: ProviderName): string {
  return providerLabel(name, window.__GEZEL__?.platform, { compact: true });
}

/**
 * A provider counts as "busy" when it has at least one item either
 * running or queued. Fully-idle providers stay hidden so the header
 * doesn't accumulate dim chips nobody's looking at.
 */
function isBusy(state: ProviderQueueState): boolean {
  return state.running + state.queuedInteractive + state.queuedBackground > 0;
}

function totalQueued(state: ProviderQueueState): number {
  return state.queuedInteractive + state.queuedBackground;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

/**
 * Navigate through the same queued-intent + live-event path as titlebar
 * search. Looking up the session at click time gives us its authoritative
 * project, which the provider queue does not carry.
 */
async function openQueuedChat(sessionId: string, onClose: () => void): Promise<void> {
  try {
    const session = await api.getChatSession(sessionId);
    const intent = {
      gezelId: session.gezelId,
      sessionId: session.id,
      projectId: session.projectId,
    };
    queueOpenSession(intent);
    onClose();
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', {
        detail: { kind: 'gezel', id: session.gezelId },
      }),
    );
    window.dispatchEvent(new CustomEvent('gezel:open-session', { detail: intent }));
  } catch {
    // Queue snapshots are inherently racy: a session can disappear between
    // the poll and the click. Leave the panel open when there is nowhere to go.
  }
}

function QueueItemOpenButton({
  sessionId,
  actor,
  onClose,
}: {
  sessionId: string | undefined;
  actor: string;
  onClose: () => void;
}) {
  // Paired-device queue ids are namespaced for isolation and do not identify
  // a session in this app's local store.
  if (!sessionId || sessionId.startsWith('dev:')) return null;
  return (
    <button
      type="button"
      className="queue-meter-panel-item-open"
      aria-label={`Open chat with ${actor}`}
      title="Open this chat"
      onClick={() => void openQueuedChat(sessionId, onClose)}
    />
  );
}

export function QueueMeter() {
  const [status, setStatus] = useState<QueueStatusResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [gezels, setGezels] = useState<Map<string, GezelSummary>>(new Map());
  // Configured active provider — derived from /api/config rather than
  // `status.providers`, which only lists providers that have *finished*
  // initializing. During an on-device model load (the "Preparing"
  // window) the provider is absent from `/api/queues` for many seconds,
  // so keying anything off it goes dark exactly when turns are stacking
  // up. Config tells us which on-device engine is active throughout.
  // Mirrors EngineStatusPill, which stays visible across the same gap.
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    api
      .getQueueStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Gezel names are looked up for the detail panel. One fetch on
  // mount is enough — if a new gezel appears mid-session, its id will
  // render without a name, not hard-fail.
  useEffect(() => {
    api
      .listGezels()
      .then((r) => setGezels(new Map(r.gezels.map((g) => [g.id, g]))))
      .catch(() => {});
  }, []);

  // Track the configured provider on the same 10s cadence the pill
  // uses, so a Settings switch (or the active engine changing) is
  // reflected without a reload.
  useEffect(() => {
    const refreshConfig = () => {
      api
        .getConfig()
        .then((c: ConfigResponse) => setActiveProvider(c.provider ?? null))
        .catch(() => {});
    };
    refreshConfig();
    const t = setInterval(refreshConfig, 10_000);
    return () => clearInterval(t);
  }, []);

  // Close the popover on outside-click. The click *inside* the root
  // is filtered in the handler so the toggle button's click isn't
  // preempted.
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (ev: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (ev.target instanceof Node && root.contains(ev.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Cooperative dismissal when the header hamburger menu opens —
  // otherwise Radix's DropdownMenu trigger can swallow the mousedown
  // and leave this popover stacked behind the menu.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('gezel:close-header-popovers', close);
    return () => window.removeEventListener('gezel:close-header-popovers', close);
  }, []);

  const busyProviders = useMemo(() => {
    if (!status) return [];
    return PROVIDER_ORDER.filter((name) => {
      const state = status.providers[name];
      return state && isBusy(state);
    }).map((name) => ({ name, state: status.providers[name]! }));
  }, [status]);

  // Which on-device engine, if any, is the active provider. Drives the
  // live-turn subscription so it stays open across the "Preparing"
  // window (when the provider is missing from `status.providers`). A
  // cloud-only user resolves to null and never holds a connection.
  const onDeviceProvider: ProviderName | null =
    activeProvider === 'llama-cpp'
      ? 'llama-cpp'
      : activeProvider === 'mlx'
        ? 'mlx'
        : activeProvider === 'ds4'
          ? 'ds4'
          : null;
  const liveTurns = useOnDeviceLiveTurns(onDeviceProvider !== null);

  const taskRunnerPending = status?.taskRunner.pendingCount ?? 0;

  // Preparing-window turns: in-flight on-device turns that aren't yet
  // represented in the provider queue because the engine is still
  // loading (so `status.providers[onDeviceProvider]` is undefined).
  // Once the provider registers, its `active`/`pending` rows take over
  // and this list goes empty — no double-render with the busy chips.
  const onDeviceState = onDeviceProvider ? status?.providers[onDeviceProvider] : undefined;
  const preparingTurns: Array<[string, LiveTurnState]> =
    onDeviceProvider && !onDeviceState ? Array.from(liveTurns.entries()) : [];

  // Nothing busy and nothing preparing → render nothing. Keeps the
  // header clean on the common idle case.
  if (busyProviders.length === 0 && taskRunnerPending === 0 && preparingTurns.length === 0)
    return null;

  return (
    <div className="queue-meter" ref={rootRef}>
      <button
        type="button"
        className={`queue-meter-button${open ? ' queue-meter-button-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="AI chat queue — click for details"
      >
        {busyProviders.map(({ name, state }) => {
          const queued = totalQueued(state);
          return (
            <span key={name} className="queue-meter-chip">
              <span className="queue-meter-chip-label">
                {/* Full + short labels rendered together; the chip's
                    container query in styles.css shows whichever fits.
                    Title attribute always shows the full form so a
                    user hovering the compact "Windows" still sees the
                    canonical "This Windows PC". */}
                <span className="queue-meter-chip-label-full" title={getPlatformPillLabel(name)}>
                  {getPlatformPillLabel(name)}
                </span>
                <span className="queue-meter-chip-label-short" title={getPlatformPillLabel(name)}>
                  {getCompactPillLabel(name)}
                </span>
              </span>
              <span className="queue-meter-chip-counts">
                {state.running}
                {queued > 0 ? `+${queued}` : ''}
              </span>
            </span>
          );
        })}
        {/* Preparing-window chip: the on-device engine is still loading,
            so there's no provider chip above, but turns are already
            stacked up waiting for it. Reuses the same label treatment as
            a busy chip; the count is the number of waiting turns. */}
        {preparingTurns.length > 0 && onDeviceProvider && (
          <span className="queue-meter-chip queue-meter-chip-preparing">
            <span className="queue-meter-chip-label">
              <span
                className="queue-meter-chip-label-full"
                title={getPlatformPillLabel(onDeviceProvider)}
              >
                {getPlatformPillLabel(onDeviceProvider)}
              </span>
              <span
                className="queue-meter-chip-label-short"
                title={getPlatformPillLabel(onDeviceProvider)}
              >
                {getCompactPillLabel(onDeviceProvider)}
              </span>
            </span>
            <span className="queue-meter-chip-counts">{preparingTurns.length}</span>
          </span>
        )}
        {taskRunnerPending > 0 && (
          <span className="queue-meter-chip queue-meter-chip-tasks">
            <span className="queue-meter-chip-label">Tasks</span>
            <span className="queue-meter-chip-counts">{taskRunnerPending}</span>
          </span>
        )}
      </button>
      {open && status && (
        <QueueMeterPanel
          status={status}
          gezels={gezels}
          liveTurns={liveTurns}
          preparingTurns={preparingTurns}
          onDeviceProvider={onDeviceProvider}
          onClose={() => setOpen(false)}
          onItemChanged={refresh}
        />
      )}
    </div>
  );
}

function QueueMeterPanel({
  status,
  gezels,
  liveTurns,
  preparingTurns,
  onDeviceProvider,
  onClose,
  onItemChanged,
}: {
  status: QueueStatusResponse;
  gezels: Map<string, GezelSummary>;
  /** Per-session phase state for on-device (llama-cpp) turns. Empty
   *  map on non-on-device installs. */
  liveTurns: Map<string, LiveTurnState>;
  /** In-flight on-device turns to show while the engine is still
   *  loading (provider not yet in `status.providers`), as
   *  `[sessionId, state]` pairs — the sessionId targets the cancel
   *  route. Empty once the provider registers and its own rows take
   *  over. */
  preparingTurns: Array<[string, LiveTurnState]>;
  /** Active on-device provider, or null when the active provider is a
   *  cloud one. Labels the preparing section. */
  onDeviceProvider: ProviderName | null;
  onClose: () => void;
  /** Fired after the user cancels or reorders a queued item so the
   *  parent can refresh the snapshot without waiting for the 3s poll. */
  onItemChanged: () => void;
}) {
  const providers = PROVIDER_ORDER.map((name) => ({
    name,
    state: status.providers[name],
  })).filter((p) => p.state);
  // The preparing section stands in for a provider section while the
  // engine loads, so the "No providers initialized yet" empty state
  // should defer to it.
  const showPreparing = onDeviceProvider !== null && preparingTurns.length > 0;

  return (
    <div className="queue-meter-panel" aria-label="AI chat queue">
      <div className="queue-meter-panel-header">
        <strong>AI chat queue</strong>
        <button
          type="button"
          className="queue-meter-panel-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {providers.length === 0 && !showPreparing && (
        <p className="muted small">No providers initialized yet.</p>
      )}

      {/* Preparing section: the on-device engine is still loading, so
          the provider queue isn't surfaced yet. List the turns waiting
          on it with their current phase and a cancel control — reorder
          isn't meaningful until the engine starts dispatching. */}
      {showPreparing && onDeviceProvider && (
        <section className="queue-meter-panel-section">
          <header className="queue-meter-panel-provider">
            <span className="queue-meter-panel-provider-name">
              {getPlatformPillLabel(onDeviceProvider)}
            </span>
            <span className="muted small">starting engine · {preparingTurns.length} waiting</span>
          </header>
          <ul className="queue-meter-panel-list">
            {preparingTurns.map(([sessionId, turn]) => (
              <li
                key={`preparing-${sessionId}`}
                className="queue-meter-panel-item queue-meter-panel-item-pending queue-meter-panel-item-interactive"
              >
                <QueueItemOpenButton
                  sessionId={sessionId}
                  actor={describeActor(turn.gezelId, gezels)}
                  onClose={onClose}
                />
                <span className="queue-meter-panel-lane" title="preparing">
                  •
                </span>
                <span className="queue-meter-panel-gezel">
                  {describeActor(turn.gezelId, gezels)}
                  <span className="queue-meter-panel-phase muted"> · {turn.label}</span>
                </span>
                <span className="queue-meter-panel-time muted">
                  {formatMs(Math.max(0, Date.now() - turn.startedAt))}
                </span>
                <span className="queue-meter-panel-actions">
                  {/* No reorder while preparing — the engine hasn't
                      started dispatching, so there's no queue order to
                      nudge. Cancel is safe to call even before the turn
                      runs (see api.cancelChatSessionTurn). */}
                  <button
                    type="button"
                    className="queue-meter-panel-action queue-meter-panel-action-cancel"
                    aria-label="Cancel queued turn"
                    title="Cancel this queued turn"
                    onClick={() => {
                      void api
                        .cancelChatSessionTurn(sessionId)
                        .then(onItemChanged)
                        .catch(() => {});
                    }}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {providers.map(({ name, state }) => {
        if (!state) return null;
        const running = state.running;
        const queued = state.queuedInteractive + state.queuedBackground;
        const deferred = Math.min(queued, state.ambientHeld ?? 0);
        const readyQueued = queued - deferred;
        return (
          <section key={name} className="queue-meter-panel-section">
            <header className="queue-meter-panel-provider">
              <span className="queue-meter-panel-provider-name">{getPlatformPillLabel(name)}</span>
              <span className="muted small">
                {running} / {state.concurrency} in flight
                {readyQueued > 0 ? ` · ${readyQueued} queued` : ''}
                {deferred > 0 ? ` · ${deferred} deferred until idle` : ''}
              </span>
            </header>
            {state.active.length === 0 && queued === 0 ? (
              <p className="muted small queue-meter-panel-empty">Idle.</p>
            ) : (
              <ul className="queue-meter-panel-list">
                {state.active.map((a, i) => {
                  // For on-device turns, look up the current phase
                  // label so the user can see what the engine is
                  // actually doing instead of just "gezel + 58s".
                  const phase =
                    name === 'llama-cpp' && a.sessionId ? liveTurns.get(a.sessionId) : undefined;
                  // Phase 3: surface the cache-warm signal next to
                  // active turns. The session's cache entry is keyed by
                  // sessionId on whichever engine adapter the
                  // controller uses; we look it up via the per-provider
                  // cache stats in the same /api/queues poll.
                  const cacheEntry =
                    a.sessionId && status?.cache
                      ? status.cache
                          .find((c) => c.providerName === name)
                          ?.sessions.find((s) => s.sessionId === a.sessionId)
                      : undefined;
                  return (
                    <li
                      key={`active-${a.sessionId ?? i}`}
                      className="queue-meter-panel-item queue-meter-panel-item-active"
                    >
                      <QueueItemOpenButton
                        sessionId={a.sessionId}
                        actor={describeActor(a.gezelId, gezels)}
                        onClose={onClose}
                      />
                      <span className="queue-meter-panel-status-dot" aria-hidden />
                      <span className="queue-meter-panel-gezel">
                        {describeActor(a.gezelId, gezels)}
                        {a.job && <span className="queue-meter-panel-job muted"> · {a.job}</span>}
                        {phase && (
                          <span className="queue-meter-panel-phase muted"> · {phase.label}</span>
                        )}
                        {cacheEntry && (
                          <span
                            className="queue-meter-panel-cache muted"
                            title={`Cache hot: ${cacheEntry.tokenCount.toLocaleString('en-US')} tokens`}
                          >
                            {' '}
                            · cached
                          </span>
                        )}
                      </span>
                      <span className="queue-meter-panel-time muted">
                        {formatMs(a.runningForMs)}
                      </span>
                    </li>
                  );
                })}
                {state.pending.map((p) => {
                  // Reorder is constrained to same-lane neighbours
                  // (the dispatcher's lane invariant trumps any
                  // user nudge), so disable ↑/↓ when the item is at
                  // the lane edge. Compute the lane-local index from
                  // the same `pending` array the server returns.
                  const lanePeers = state.pending.filter((q) => q.lane === p.lane);
                  const laneIdx = lanePeers.indexOf(p);
                  const isFirstInLane = laneIdx === 0;
                  const isLastInLane = laneIdx === lanePeers.length - 1;
                  return (
                    <li
                      key={`pending-${p.id}`}
                      className={`queue-meter-panel-item queue-meter-panel-item-pending queue-meter-panel-item-${p.lane}`}
                    >
                      <QueueItemOpenButton
                        sessionId={p.sessionId}
                        actor={describeActor(p.gezelId, gezels)}
                        onClose={onClose}
                      />
                      <span className="queue-meter-panel-lane" title={`${p.lane} lane`}>
                        {p.lane === 'interactive' ? '•' : '·'}
                      </span>
                      <span className="queue-meter-panel-gezel">
                        {describeActor(p.gezelId, gezels)}
                        {p.job && <span className="queue-meter-panel-job muted"> · {p.job}</span>}
                        {p.ambient && deferred > 0 && (
                          <span className="queue-meter-panel-job muted">
                            {' '}
                            · deferred until idle
                          </span>
                        )}
                      </span>
                      <span className="queue-meter-panel-time muted">{formatMs(p.waitedMs)}</span>
                      <span className="queue-meter-panel-actions">
                        <button
                          type="button"
                          className="queue-meter-panel-action"
                          aria-label="Move up"
                          title="Move higher in queue"
                          disabled={isFirstInLane}
                          onClick={() => {
                            void api
                              .moveProviderQueueItem(name, p.id, 'up')
                              .then(onItemChanged)
                              .catch(() => {});
                          }}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="queue-meter-panel-action"
                          aria-label="Move down"
                          title="Move lower in queue"
                          disabled={isLastInLane}
                          onClick={() => {
                            void api
                              .moveProviderQueueItem(name, p.id, 'down')
                              .then(onItemChanged)
                              .catch(() => {});
                          }}
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          className="queue-meter-panel-action queue-meter-panel-action-cancel"
                          aria-label="Cancel queued turn"
                          title="Cancel this queued turn"
                          onClick={() => {
                            void api
                              .cancelProviderQueueItem(name, p.id)
                              .then(onItemChanged)
                              .catch(() => {});
                          }}
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {status.taskRunner.pendingCount > 0 && (
        <section className="queue-meter-panel-section">
          <header className="queue-meter-panel-provider">
            <span className="queue-meter-panel-provider-name">Task handoffs</span>
            <span className="muted small">{status.taskRunner.pendingCount} pending dispatch</span>
          </header>
          <ul className="queue-meter-panel-list">
            {Object.entries(status.taskRunner.pendingByGezel).map(([gezelId, count]) => (
              <li key={gezelId} className="queue-meter-panel-item queue-meter-panel-item-pending">
                <span className="queue-meter-panel-lane">·</span>
                <span className="queue-meter-panel-gezel">{describeActor(gezelId, gezels)}</span>
                <span className="queue-meter-panel-time muted">×{count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function describeActor(gezelId: string | undefined, gezels: Map<string, GezelSummary>): string {
  if (!gezelId) return 'unknown';
  // Remote model execution: a paired client's turn arrives with its ids
  // origin-namespaced as `dev:<deviceId>:<realId>` (so affinity stays per
  // tenant). Surface it as a remote row rather than a raw, unresolvable id.
  const remote = /^dev:([^:]+):/.exec(gezelId);
  if (remote) return `Remote · ${remote[1]!.slice(0, 8)}`;
  const gezel = gezels.get(gezelId);
  return gezel?.name ?? gezelId;
}
