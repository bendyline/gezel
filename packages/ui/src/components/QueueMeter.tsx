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

import { type GezelSummary, type Project, displayName } from '@bendyline/gezel';
import type {
  ConfigResponse,
  ProviderQueueState,
  QueueStatusResponse,
  TaskHandoffBucket,
  TaskRunnerState,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { GezelIcon } from './GezelIcon.js';
import { NightShiftMoonGlyph } from './night-shift-glyph.js';
import { queueOpenSession } from './pending-open-session.js';
import { providerLabel } from './provider-label.js';
import { type LiveTurnState, useOnDeviceLiveTurns } from './useOnDeviceLiveTurns.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

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

const NO_HANDOFFS: TaskHandoffBucket = { count: 0, byGezel: {} };

/**
 * Split the task runner's queue into work that is actually waiting on the
 * engine and work parked until the next Night Shift window.
 *
 * Only the first is a backlog. Night-shift handoffs sit on the queue all
 * day by design — counting them in the header reads as a stuck queue and
 * asks the user to worry about something that will take care of itself,
 * so they stay out of the chip entirely and are explained in the popover.
 *
 * A daemon older than this UI sends only the totals; treat those as
 * dispatchable so the meter keeps its previous behavior rather than
 * silently hiding work it can't classify.
 */
function taskHandoffSplit(state: TaskRunnerState | undefined): {
  dispatchable: TaskHandoffBucket;
  scheduled: TaskHandoffBucket;
} {
  if (!state) return { dispatchable: NO_HANDOFFS, scheduled: NO_HANDOFFS };
  return {
    dispatchable: state.dispatchable ?? {
      count: state.pendingCount,
      byGezel: state.pendingByGezel,
    },
    scheduled: state.scheduled ?? NO_HANDOFFS,
  };
}

/** Why nothing in the dispatchable bucket is moving, in the user's terms. */
function handoffHoldNote(state: TaskRunnerState): string | undefined {
  if (state.holdReason === 'engagement-off') {
    return 'AI engagement is off — turn it back on in Settings to start these.';
  }
  if (state.holdReason === 'engagement-paused') {
    return 'Activity is set to reactive — gezels answer you, but nothing starts on its own.';
  }
  if (state.holdReason === 'provider-busy') return 'Waiting for a free slot.';
  return undefined;
}

function formatClock(iso: string): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * When the scheduled bucket picks up. Deliberately says what will happen
 * on its own versus what the user would have to do — a shift that is
 * simply not open yet needs no action, a Night Shift switched off does.
 */
function scheduledHandoffNote(nightShift: TaskRunnerState['nightShift']): string {
  if (!nightShift) return 'Held for the next Night Shift.';
  if (!nightShift.opensAt) return 'Night Shift is off — turn it on to run these.';
  if (nightShift.active) return 'Held for the next window.';
  const opensAt = formatClock(nightShift.opensAt);
  return opensAt ? `Starts ${opensAt}. Nothing to do.` : 'Starts tonight. Nothing to do.';
}

interface QueueActorIdentity {
  gezel?: GezelSummary;
  label: string;
}

function systemFallbackColors(actor: QueueActorIdentity): {
  fallbackBackground?: string;
  fallbackForeground?: string;
} {
  if (actor.gezel || actor.label !== 'System') return {};
  return {
    fallbackBackground: 'var(--accent)',
    fallbackForeground: 'var(--accent-selection-ink)',
  };
}

interface QueueActorContext {
  actor: QueueActorIdentity;
  projectId?: string;
}

function resolveQueueActor(
  gezelId: string | undefined,
  actorLabel: string | undefined,
  gezels: Map<string, GezelSummary>,
): QueueActorIdentity {
  if (gezelId) {
    const remote = /^dev:([^:]+):/.exec(gezelId);
    if (remote) return { label: `Remote · ${remote[1]!.slice(0, 8)}` };
    const gezel = gezels.get(gezelId);
    if (gezel) return { gezel, label: gezel.name };
    return { label: gezelId };
  }
  return { label: actorLabel?.trim() || 'System' };
}

function providerRepresentative(
  state: ProviderQueueState,
  gezels: Map<string, GezelSummary>,
): QueueActorContext {
  const turn = state.active[0] ?? state.pending[0];
  return {
    actor: resolveQueueActor(turn?.gezelId, turn?.actorLabel, gezels),
    ...(turn?.projectId ? { projectId: turn.projectId } : {}),
  };
}

function queueActorRole(actor: QueueActorIdentity): string | undefined {
  return actor.gezel?.role?.trim() || actor.gezel?.roleBasedName?.trim() || undefined;
}

function queueProjectLabel(
  projectId: string | undefined,
  projects: Map<string, Project>,
): string | undefined {
  if (!projectId) return undefined;
  const remote = /^dev:[^:]+:(.+)$/.exec(projectId);
  const localId = remote?.[1] ?? projectId;
  return projects.get(localId)?.name ?? localId;
}

function queueActorTooltip(
  actor: QueueActorIdentity,
  projectId: string | undefined,
  projects: Map<string, Project>,
  provider?: ProviderName,
): string {
  const lines = [actor.label];
  const role = queueActorRole(actor);
  const project = queueProjectLabel(projectId, projects);
  if (role) lines.push(`Role: ${role}`);
  if (project) lines.push(`Project: ${project}`);
  if (provider) lines.push(`Provider: ${getPlatformPillLabel(provider)}`);
  return lines.join('\n');
}

function queueJobContext(
  job: string | undefined,
  projectId: string | undefined,
  project: string | undefined,
): string | undefined {
  const label = job?.trim();
  if (!label) return undefined;
  for (const prefix of [projectId, project]) {
    if (!prefix) continue;
    if (label === prefix) return undefined;
    if (label.startsWith(`${prefix} · `)) return label.slice(prefix.length + 3);
  }
  return label;
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

function QueueChipIdentity({
  provider,
  actor,
  projectId,
  projects,
  boringMode,
}: {
  provider: ProviderName;
  actor: QueueActorIdentity;
  projectId: string | undefined;
  projects: Map<string, Project>;
  boringMode: boolean;
}) {
  if (!boringMode) {
    const { gezel } = actor;
    const tooltip = queueActorTooltip(actor, projectId, projects, provider);
    return (
      <>
        <span className="queue-meter-chip-avatar" aria-hidden="true">
          <GezelIcon
            svg={gezel?.icon}
            poppetje={gezel?.poppetje}
            iconOverride={gezel?.iconOverride}
            name={actor.label}
            size={20}
            variant="icon"
            title={tooltip}
            {...systemFallbackColors(actor)}
          />
        </span>
        <span
          className={`queue-meter-chip-gezel-name${gezel ? '' : ' queue-meter-chip-gezel-name-service'}`}
          title={tooltip}
        >
          {actor.label}
        </span>
      </>
    );
  }

  return (
    <span className="queue-meter-chip-label">
      {/* Full + short labels rendered together; the chip's container
          query in styles.css shows whichever fits. The full provider
          label remains available on hover in compact mode. */}
      <span className="queue-meter-chip-label-full" title={getPlatformPillLabel(provider)}>
        {getPlatformPillLabel(provider)}
      </span>
      <span className="queue-meter-chip-label-short" title={getPlatformPillLabel(provider)}>
        {getCompactPillLabel(provider)}
      </span>
    </span>
  );
}

type QueueMarkerKind = 'active' | 'preparing' | 'interactive' | 'background' | 'task';

function QueueItemMarker({
  gezelId,
  actorLabel,
  gezels,
  boringMode,
  kind,
}: {
  gezelId: string | undefined;
  actorLabel: string | undefined;
  gezels: Map<string, GezelSummary>;
  boringMode: boolean;
  kind: QueueMarkerKind;
}) {
  const actor = resolveQueueActor(gezelId, actorLabel, gezels);
  if (!boringMode) {
    const { gezel } = actor;
    return (
      <span className="queue-meter-panel-item-marker" aria-hidden="true">
        <GezelIcon
          svg={gezel?.icon}
          poppetje={gezel?.poppetje}
          iconOverride={gezel?.iconOverride}
          name={actor.label}
          size={24}
          variant="icon"
          pulsing={kind === 'active' || kind === 'preparing'}
          title={actor.label}
          {...systemFallbackColors(actor)}
        />
      </span>
    );
  }

  if (kind === 'active') {
    return <span className="queue-meter-panel-status-dot" aria-hidden="true" />;
  }

  const interactive = kind === 'interactive' || kind === 'preparing';
  const title =
    kind === 'preparing' ? 'preparing' : kind === 'task' ? 'task handoff' : `${kind} lane`;
  return (
    <span className="queue-meter-panel-lane" title={title}>
      {interactive ? '•' : '·'}
    </span>
  );
}

function QueueItemIdentity({
  gezelId,
  actorLabel,
  projectId,
  gezels,
  projects,
  boringMode,
  job,
  phase,
  extra,
}: {
  gezelId: string | undefined;
  actorLabel: string | undefined;
  projectId: string | undefined;
  gezels: Map<string, GezelSummary>;
  projects: Map<string, Project>;
  boringMode: boolean;
  job?: string | undefined;
  phase?: string | undefined;
  extra?: string | undefined;
}) {
  const actor = resolveQueueActor(gezelId, actorLabel, gezels);
  const role = queueActorRole(actor);
  const project = queueProjectLabel(projectId, projects);
  const visibleJob = queueJobContext(job, projectId, project);
  const context = [role, project, visibleJob, phase, extra].filter((value): value is string =>
    Boolean(value),
  );
  return (
    <span className="queue-meter-panel-gezel" title={queueActorTooltip(actor, projectId, projects)}>
      <span className="queue-meter-panel-gezel-name">
        {actor.gezel ? displayName(actor.gezel, boringMode) : actor.label}
      </span>
      {context.length > 0 && (
        <span className="queue-meter-panel-context muted">{context.join(' · ')}</span>
      )}
    </span>
  );
}

export function QueueMeter() {
  const [status, setStatus] = useState<QueueStatusResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [gezels, setGezels] = useState<Map<string, GezelSummary>>(new Map());
  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  // Configured active provider — derived from /api/config rather than
  // `status.providers`, which only lists providers that have *finished*
  // initializing. During an on-device model load (the "Preparing"
  // window) the provider is absent from `/api/queues` for many seconds,
  // so keying anything off it goes dark exactly when turns are stacking
  // up. Config tells us which on-device engine is active throughout.
  // Mirrors EngineStatusPill, which stays visible across the same gap.
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gezelRefreshSeqRef = useRef(0);
  const boringMode = useRoleBasedNameOnlyMode();

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

  const refreshGezels = useCallback(() => {
    const seq = ++gezelRefreshSeqRef.current;
    api
      .listGezels()
      .then((r) => {
        if (seq !== gezelRefreshSeqRef.current) return;
        setGezels(new Map(r.gezels.map((g) => [g.id, g])));
      })
      .catch(() => {});
  }, []);

  // Keep queue attribution in sync with gezels recruited or edited after
  // this header mounted. The global SSE bridge emits the same event for
  // service-created gezels, including task/craftbook crew recruitment.
  useEffect(() => {
    refreshGezels();
    const onGezelChanged = () => refreshGezels();
    window.addEventListener('gezel:gezel-updated', onGezelChanged);
    window.addEventListener('gezel:gezel-deleted', onGezelChanged);
    return () => {
      window.removeEventListener('gezel:gezel-updated', onGezelChanged);
      window.removeEventListener('gezel:gezel-deleted', onGezelChanged);
    };
  }, [refreshGezels]);

  useEffect(() => {
    api
      .listProjects()
      .then((r) => setProjects(new Map(r.projects.map((p) => [p.id, p]))))
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

  // Only work waiting on the engine counts here. Night-shift handoffs are
  // excluded on purpose — see `taskHandoffSplit`.
  const taskRunnerPending = taskHandoffSplit(status?.taskRunner).dispatchable.count;

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

  let queueButtonTitle = 'AI chat queue — click for details';
  if (!boringMode) {
    const firstBusy = busyProviders[0];
    if (firstBusy) {
      const representative = providerRepresentative(firstBusy.state, gezels);
      queueButtonTitle = `${queueActorTooltip(
        representative.actor,
        representative.projectId,
        projects,
        firstBusy.name,
      )}\nClick for queue details`;
    } else {
      const preparing = preparingTurns[0]?.[1];
      if (preparing && onDeviceProvider) {
        queueButtonTitle = `${queueActorTooltip(
          resolveQueueActor(preparing.gezelId, undefined, gezels),
          preparing.projectId,
          projects,
          onDeviceProvider,
        )}\nClick for queue details`;
      }
    }
  }

  return (
    <div className="queue-meter" ref={rootRef}>
      <button
        type="button"
        className={`queue-meter-button${open ? ' queue-meter-button-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="AI chat queue — click for details"
        title={queueButtonTitle}
      >
        {busyProviders.map(({ name, state }) => {
          const queued = totalQueued(state);
          const representative = providerRepresentative(state, gezels);
          return (
            <span
              key={name}
              className="queue-meter-chip"
              title={
                boringMode
                  ? getPlatformPillLabel(name)
                  : queueActorTooltip(
                      representative.actor,
                      representative.projectId,
                      projects,
                      name,
                    )
              }
            >
              <QueueChipIdentity
                provider={name}
                actor={representative.actor}
                projectId={representative.projectId}
                projects={projects}
                boringMode={boringMode}
              />
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
          <span
            className="queue-meter-chip queue-meter-chip-preparing"
            title={
              boringMode
                ? getPlatformPillLabel(onDeviceProvider)
                : queueActorTooltip(
                    resolveQueueActor(preparingTurns[0]?.[1].gezelId, undefined, gezels),
                    preparingTurns[0]?.[1].projectId,
                    projects,
                    onDeviceProvider,
                  )
            }
          >
            <QueueChipIdentity
              provider={onDeviceProvider}
              actor={resolveQueueActor(preparingTurns[0]?.[1].gezelId, undefined, gezels)}
              projectId={preparingTurns[0]?.[1].projectId}
              projects={projects}
              boringMode={boringMode}
            />
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
          projects={projects}
          liveTurns={liveTurns}
          preparingTurns={preparingTurns}
          onDeviceProvider={onDeviceProvider}
          boringMode={boringMode}
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
  projects,
  liveTurns,
  preparingTurns,
  onDeviceProvider,
  boringMode,
  onClose,
  onItemChanged,
}: {
  status: QueueStatusResponse;
  gezels: Map<string, GezelSummary>;
  projects: Map<string, Project>;
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
  /** Boring mode keeps the provider/status treatment and suppresses character art. */
  boringMode: boolean;
  onClose: () => void;
  /** Fired after the user cancels or reorders a queued item so the
   *  parent can refresh the snapshot without waiting for the 3s poll. */
  onItemChanged: () => void;
}) {
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(() => new Set());
  const providers = PROVIDER_ORDER.map((name) => ({
    name,
    state: status.providers[name],
  })).filter((p) => p.state);
  // The preparing section stands in for a provider section while the
  // engine loads, so the "No providers initialized yet" empty state
  // should defer to it.
  const showPreparing = onDeviceProvider !== null && preparingTurns.length > 0;
  const handoffs = taskHandoffSplit(status.taskRunner);
  const holdNote = handoffHoldNote(status.taskRunner);

  const stopActiveChat = useCallback(
    async (sessionId: string) => {
      setStoppingSessionIds((current) => new Set(current).add(sessionId));
      try {
        const result = await api.cancelChatSessionTurn(sessionId);
        if (!result.cancelled) {
          setStoppingSessionIds((current) => {
            const next = new Set(current);
            next.delete(sessionId);
            return next;
          });
        }
        onItemChanged();
      } catch {
        // Keep the control retryable if the service could not be reached.
        setStoppingSessionIds((current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
      }
    },
    [onItemChanged],
  );

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
                  actor={describeActor(turn.gezelId, undefined, gezels, boringMode)}
                  onClose={onClose}
                />
                <QueueItemMarker
                  gezelId={turn.gezelId}
                  actorLabel={undefined}
                  gezels={gezels}
                  boringMode={boringMode}
                  kind="preparing"
                />
                <QueueItemIdentity
                  gezelId={turn.gezelId}
                  actorLabel={undefined}
                  projectId={turn.projectId}
                  gezels={gezels}
                  projects={projects}
                  boringMode={boringMode}
                  phase={turn.label}
                />
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
                  const actor = describeActor(a.gezelId, a.actorLabel, gezels, boringMode);
                  const activeSessionId =
                    a.sessionId && !a.sessionId.startsWith('dev:') ? a.sessionId : undefined;
                  const stopping = activeSessionId
                    ? stoppingSessionIds.has(activeSessionId)
                    : false;
                  return (
                    <li
                      key={`active-${a.sessionId ?? i}`}
                      className="queue-meter-panel-item queue-meter-panel-item-active"
                    >
                      <QueueItemOpenButton
                        sessionId={a.sessionId}
                        actor={actor}
                        onClose={onClose}
                      />
                      <QueueItemMarker
                        gezelId={a.gezelId}
                        actorLabel={a.actorLabel}
                        gezels={gezels}
                        boringMode={boringMode}
                        kind="active"
                      />
                      <QueueItemIdentity
                        gezelId={a.gezelId}
                        actorLabel={a.actorLabel}
                        projectId={a.projectId}
                        gezels={gezels}
                        projects={projects}
                        boringMode={boringMode}
                        job={a.job}
                        phase={phase?.label}
                        extra={cacheEntry ? 'cached' : undefined}
                      />
                      <span className="queue-meter-panel-time muted">
                        {formatMs(a.runningForMs)}
                      </span>
                      {activeSessionId && (
                        <span className="queue-meter-panel-actions queue-meter-panel-actions-active">
                          <button
                            type="button"
                            className="queue-meter-panel-action queue-meter-panel-action-stop"
                            aria-label={`Stop active chat with ${actor}`}
                            title="Stop this active chat"
                            disabled={stopping}
                            onClick={() => void stopActiveChat(activeSessionId)}
                          >
                            {stopping ? 'Stopping…' : '■ Stop'}
                          </button>
                        </span>
                      )}
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
                        actor={describeActor(p.gezelId, p.actorLabel, gezels, boringMode)}
                        onClose={onClose}
                      />
                      <QueueItemMarker
                        gezelId={p.gezelId}
                        actorLabel={p.actorLabel}
                        gezels={gezels}
                        boringMode={boringMode}
                        kind={p.lane}
                      />
                      <QueueItemIdentity
                        gezelId={p.gezelId}
                        actorLabel={p.actorLabel}
                        projectId={p.projectId}
                        gezels={gezels}
                        projects={projects}
                        boringMode={boringMode}
                        job={p.job}
                        extra={p.ambient && deferred > 0 ? 'deferred until idle' : undefined}
                      />
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

      {handoffs.dispatchable.count > 0 && (
        <section className="queue-meter-panel-section">
          <header className="queue-meter-panel-provider">
            <span className="queue-meter-panel-provider-name">Task handoffs</span>
            <span className="muted small">{handoffs.dispatchable.count} pending dispatch</span>
          </header>
          {holdNote && <p className="queue-meter-panel-note muted small">{holdNote}</p>}
          <QueueHandoffList
            byGezel={handoffs.dispatchable.byGezel}
            gezels={gezels}
            boringMode={boringMode}
          />
        </section>
      )}

      {/* Scheduled work, kept out of the header chip. The section exists to
          answer "what is my crew going to do tonight?", not to prompt an
          action — so it leads with when it runs, not with a count. */}
      {handoffs.scheduled.count > 0 && (
        <section className="queue-meter-panel-section queue-meter-panel-section-scheduled">
          <header className="queue-meter-panel-provider">
            <button
              type="button"
              className="queue-meter-panel-provider-name queue-meter-panel-jump"
              onClick={() => {
                onClose();
                window.dispatchEvent(new CustomEvent('gezel:open-night-shift'));
              }}
              title="Open the Night Shift menu"
            >
              <NightShiftMoonGlyph className="queue-meter-panel-moon" />
              Night Shift
            </button>
            <span className="muted small">{handoffs.scheduled.count} scheduled</span>
          </header>
          <p className="queue-meter-panel-note muted small">
            {scheduledHandoffNote(status.taskRunner.nightShift)}
          </p>
          <QueueHandoffList
            byGezel={handoffs.scheduled.byGezel}
            gezels={gezels}
            boringMode={boringMode}
          />
        </section>
      )}
    </div>
  );
}

function QueueHandoffList({
  byGezel,
  gezels,
  boringMode,
}: {
  byGezel: Record<string, number>;
  gezels: Map<string, GezelSummary>;
  boringMode: boolean;
}) {
  return (
    <ul className="queue-meter-panel-list">
      {Object.entries(byGezel).map(([gezelId, count]) => (
        <li key={gezelId} className="queue-meter-panel-item queue-meter-panel-item-pending">
          <QueueItemMarker
            gezelId={gezelId}
            actorLabel={undefined}
            gezels={gezels}
            boringMode={boringMode}
            kind="task"
          />
          <span className="queue-meter-panel-gezel">
            {describeActor(gezelId, undefined, gezels, boringMode)}
          </span>
          <span className="queue-meter-panel-time muted">×{count}</span>
        </li>
      ))}
    </ul>
  );
}

function describeActor(
  gezelId: string | undefined,
  actorLabel: string | undefined,
  gezels: Map<string, GezelSummary>,
  boringMode: boolean,
): string {
  const actor = resolveQueueActor(gezelId, actorLabel, gezels);
  return actor.gezel ? displayName(actor.gezel, boringMode) : actor.label;
}
