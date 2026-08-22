/**
 * EngineStatusPill
 *
 * Status indicators for every relevant on-device engine (llama.cpp,
 * MLX, or DwarfStar). The configured default stays visible at rest;
 * busy secondary engines appear alongside it when a gezel has a
 * provider override. Sits in the app header beside QueueMeter /
 * EngagementBadge / QuotaMeter.
 *
 * Two visual states:
 *   1. **Idle** — muted "On-device · model-name" badge.
 *   2. **Busy** — animated dot + the current `engine_phase` label
 *      (e.g. "Processing prompt (47% · 6,144 tokens)", "Generating",
 *      "Loading model") surfaced live from the SSE stream.
 *
 * Click opens a dropdown with richer telemetry — per-turn tokens
 * in/out, generation tokens/sec, a rolling average over the last
 * minute, a per-model speed table for the life of the page, and the
 * static RAM footprint llama-cpp reported after loading the model.
 *
 * Drives off the same global `streamAllChatEvents` feed the rest of
 * the app uses, plus the cheap queue / in-flight snapshots that keep
 * cold model loads visible before phase events begin.
 */

import type {
  ChatEventEnvelope,
  GezelSummary,
  ProviderName,
  SessionGpuTask,
} from '@bendyline/gezel';
import {
  CANONICAL_PROFILES,
  DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS,
  displayName,
  isKnownProfileId,
} from '@bendyline/gezel';
import type {
  ConfigResponse,
  ModelSpeed,
  ProviderQueueState,
  QueueStatusResponse,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { MachineMemoryStrip } from './MachineMemoryStrip.js';
import { summarizeCacheEntries } from './cacheDisplay.js';
import { formatElapsedClock } from './elapsed-time.js';
import { type DeviceHealth, presentDeviceHealth } from './engine-pill-device-health.js';
import {
  type TurnStatsEntry,
  composeQueueStatus,
  computeLiveTokensPerSec,
  computeRollingTokensPerSec,
  estimateLiveOutputTokens,
  formatBytes,
  formatTokensPerSec,
} from './engine-pill-stats.js';
import { useHeaderDensity } from './header-density.js';
import { deviceLabel, providerLabel } from './provider-label.js';
import {
  type LiveTurnState,
  phaseBaseLabel,
  useOnDeviceLiveTurns,
} from './useOnDeviceLiveTurns.js';
import { useStableHeaderPopoverPosition } from './useStableHeaderPopoverPosition.js';

type LiveTurn = LiveTurnState;
type TurnStats = TurnStatsEntry;
type OnDeviceProvider = 'llama-cpp' | 'mlx' | 'ds4';
type UserDeviceSafetyMode = 'observe' | 'guard';
type EngineRetentionMs = 60_000 | 300_000 | 1_800_000;
type InflightTurn = {
  sessionId: string;
  gezelId: string;
  projectId: string;
  providerName: ProviderName;
  model?: string;
  userText: string;
  startedAt: number;
  elapsedMs: number;
  lastProgressAgoMs?: number;
};

const ON_DEVICE_PROVIDER_ORDER: readonly OnDeviceProvider[] = ['llama-cpp', 'mlx', 'ds4'];

/** Retention for per-turn stats in the rolling-average computation. */
const STATS_WINDOW_MS = 60_000;
/** Absolute cap so a very chatty session doesn't grow state unbounded. */
const STATS_MAX_ENTRIES = 40;
const ENGINE_RETENTION_PRESETS: ReadonlyArray<{
  value: EngineRetentionMs;
  label: string;
}> = [
  { value: 60_000, label: 'Fast' },
  { value: 300_000, label: 'Balanced' },
  { value: 1_800_000, label: 'Keep warm' },
];

export function EngineStatusPill() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [gezels, setGezels] = useState<Map<string, GezelSummary>>(new Map());
  const [queueStatus, setQueueStatus] = useState<QueueStatusResponse | null>(null);
  const [inflightTurns, setInflightTurns] = useState<InflightTurn[]>([]);
  const [deviceSafetySaving, setDeviceSafetySaving] = useState(false);
  const [deviceSafetyError, setDeviceSafetyError] = useState<string | null>(null);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [emergencyStopOpen, setEmergencyStopOpen] = useState(false);
  const [emergencyStopping, setEmergencyStopping] = useState(false);
  const [emergencyStopError, setEmergencyStopError] = useState<string | null>(null);
  const [emergencyStopNotice, setEmergencyStopNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshConfig = useCallback(() => {
    void api
      .getConfig()
      .then(async (next) => {
        const retention = await api.getEngineRetention().catch(() => ({
          idleTimeoutMs: next.localEngineIdleTimeoutMs ?? DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS,
        }));
        if (mountedRef.current) {
          setConfig({ ...next, localEngineIdleTimeoutMs: retention.idleTimeoutMs });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshConfig();
    const timer = setInterval(refreshConfig, 10_000);
    return () => clearInterval(timer);
  }, [refreshConfig]);

  const refreshGezels = useCallback(() => {
    void api
      .listGezels()
      .then(({ gezels: nextGezels }) => {
        if (!mountedRef.current) return;
        setGezels(new Map(nextGezels.map((gezel) => [gezel.id, gezel])));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshGezels();
    const timer = setInterval(refreshGezels, 10_000);
    return () => clearInterval(timer);
  }, [refreshGezels]);

  const refreshActivity = useCallback(() => {
    void Promise.all([api.getQueueStatus(), api.listInflightTurns()])
      .then(([status, inflight]) => {
        if (!mountedRef.current) return;
        setQueueStatus(status);
        setInflightTurns((inflight.inflight ?? []) as InflightTurn[]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshActivity();
    const timer = setInterval(refreshActivity, 3_000);
    return () => clearInterval(timer);
  }, [refreshActivity]);

  const updateDeviceSafetyMode = useCallback(
    async (mode: UserDeviceSafetyMode) => {
      if (deviceSafetySaving || config?.deviceSafety?.mode === mode) return;
      setDeviceSafetySaving(true);
      setDeviceSafetyError(null);
      try {
        const next = await api.updateConfig({
          deviceSafety: {
            ...(config?.deviceSafety ?? {}),
            mode,
          },
        });
        if (!mountedRef.current) return;
        setConfig(next);
        refreshActivity();
      } catch (error) {
        if (!mountedRef.current) return;
        setDeviceSafetyError(error instanceof Error ? error.message : String(error));
        refreshConfig();
      } finally {
        if (mountedRef.current) setDeviceSafetySaving(false);
      }
    },
    [config?.deviceSafety, deviceSafetySaving, refreshActivity, refreshConfig],
  );

  const updateRetention = useCallback(
    async (localEngineIdleTimeoutMs: EngineRetentionMs) => {
      if (
        retentionSaving ||
        (config?.localEngineIdleTimeoutMs ?? DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS) ===
          localEngineIdleTimeoutMs
      ) {
        return;
      }
      setRetentionSaving(true);
      setRetentionError(null);
      try {
        const next = await api.updateEngineRetention(localEngineIdleTimeoutMs);
        if (!mountedRef.current) return;
        setConfig((current) =>
          current ? { ...current, localEngineIdleTimeoutMs: next.idleTimeoutMs } : current,
        );
        refreshActivity();
      } catch (error) {
        if (!mountedRef.current) return;
        setRetentionError(error instanceof Error ? error.message : String(error));
        refreshConfig();
      } finally {
        if (mountedRef.current) setRetentionSaving(false);
      }
    },
    [config?.localEngineIdleTimeoutMs, refreshActivity, refreshConfig, retentionSaving],
  );

  const emergencyStop = useCallback(async () => {
    if (emergencyStopping) return;
    setEmergencyStopping(true);
    setEmergencyStopError(null);
    setEmergencyStopNotice(null);
    try {
      const result = await api.emergencyStopChats();
      if (!mountedRef.current) return;
      setConfig((current) => (current ? { ...current, aiEngagementMode: 'reactive' } : current));
      setInflightTurns([]);
      setEmergencyStopNotice(
        `Stopped ${result.cancelledTurns} ${result.cancelledTurns === 1 ? 'chat' : 'chats'}${
          result.clearedQueuedMessages > 0
            ? ` and discarded ${result.clearedQueuedMessages} queued ${result.clearedQueuedMessages === 1 ? 'message' : 'messages'}`
            : ''
        }. Local engines unloaded. Gezel is Reactive.`,
      );
      setEmergencyStopOpen(false);
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', {
          detail: { aiEngagementMode: 'reactive' },
        }),
      );
      refreshActivity();
    } catch (error) {
      if (!mountedRef.current) return;
      setEmergencyStopError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setEmergencyStopping(false);
    }
  }, [emergencyStopping, refreshActivity]);

  // Provider overrides can invoke a different local engine than the
  // install-wide default. Keep one shared subscription open so a cold
  // secondary engine is visible before its provider queue registers.
  const liveTurns = useOnDeviceLiveTurns(true, true);
  const defaultProvider = toOnDeviceProvider(config?.provider);
  const visibleProviders = visibleOnDeviceProviders({
    defaultProvider,
    queueStatus,
    inflightTurns,
    liveTurns,
  });

  return (
    <>
      {/* The primary instance also owns GPU/media activity, preserving the
          existing Image/Video pill even when the chat default is cloud. */}
      <EngineStatusPillForProvider
        provider={defaultProvider}
        defaultProvider={defaultProvider}
        config={config}
        gezels={gezels}
        queueStatus={queueStatus}
        inflightTurns={inflightTurns}
        liveTurns={liveTurns}
        includeMedia
        deviceSafetySaving={deviceSafetySaving}
        deviceSafetyError={deviceSafetyError}
        onDeviceSafetyModeChange={updateDeviceSafetyMode}
        retentionSaving={retentionSaving}
        retentionError={retentionError}
        onRetentionChange={updateRetention}
        emergencyStopping={emergencyStopping}
        emergencyStopNotice={emergencyStopNotice}
        onEmergencyStopRequest={() => {
          setEmergencyStopError(null);
          setEmergencyStopOpen(true);
        }}
      />
      {visibleProviders
        .filter((provider) => provider !== defaultProvider)
        .map((provider) => (
          <EngineStatusPillForProvider
            key={provider}
            provider={provider}
            defaultProvider={defaultProvider}
            config={config}
            gezels={gezels}
            queueStatus={queueStatus}
            inflightTurns={inflightTurns}
            liveTurns={liveTurns}
            includeMedia={false}
            deviceSafetySaving={deviceSafetySaving}
            deviceSafetyError={deviceSafetyError}
            onDeviceSafetyModeChange={updateDeviceSafetyMode}
            retentionSaving={retentionSaving}
            retentionError={retentionError}
            onRetentionChange={updateRetention}
            emergencyStopping={emergencyStopping}
            emergencyStopNotice={emergencyStopNotice}
            onEmergencyStopRequest={() => {
              setEmergencyStopError(null);
              setEmergencyStopOpen(true);
            }}
          />
        ))}
      <ConfirmDialog
        open={emergencyStopOpen}
        title="Hard stop all chats?"
        message={
          <>
            Every chat in progress will stop, queued chat messages will be discarded, local engines
            will be unloaded, and Gezel will switch to Reactive. It will only respond when you
            initiate a chat.
            {emergencyStopError && (
              <span className="engine-pill-emergency-error" role="alert">
                {emergencyStopError}
              </span>
            )}
          </>
        }
        confirmLabel="Hard stop"
        danger
        onConfirm={emergencyStop}
        onCancel={() => {
          if (!emergencyStopping) setEmergencyStopOpen(false);
        }}
      />
    </>
  );
}

function EngineStatusPillForProvider({
  provider: onDeviceProvider,
  defaultProvider,
  config,
  gezels,
  queueStatus,
  inflightTurns,
  liveTurns: allLiveTurns,
  includeMedia,
  deviceSafetySaving,
  deviceSafetyError,
  onDeviceSafetyModeChange,
  retentionSaving,
  retentionError,
  onRetentionChange,
  emergencyStopping,
  emergencyStopNotice,
  onEmergencyStopRequest,
}: {
  provider: OnDeviceProvider | null;
  defaultProvider: OnDeviceProvider | null;
  config: ConfigResponse | null;
  gezels: ReadonlyMap<string, GezelSummary>;
  queueStatus: QueueStatusResponse | null;
  inflightTurns: InflightTurn[];
  liveTurns: Map<string, LiveTurn>;
  includeMedia: boolean;
  deviceSafetySaving: boolean;
  deviceSafetyError: string | null;
  onDeviceSafetyModeChange: (mode: UserDeviceSafetyMode) => Promise<void>;
  retentionSaving: boolean;
  retentionError: string | null;
  onRetentionChange: (retention: EngineRetentionMs) => Promise<void>;
  emergencyStopping: boolean;
  emergencyStopNotice: string | null;
  onEmergencyStopRequest: () => void;
}) {
  // Read context before any provider-dependent early return. The first render
  // commonly has no provider until getConfig resolves; calling this hook only
  // after that transition changes the component's hook order.
  const density = useHeaderDensity();
  // Models actually present on disk for the active on-device provider.
  // Polled on the same 10s cadence as config so the pill reflects an
  // install finishing (or being deleted) without needing a page reload.
  const [installedModels, setInstalledModels] = useState<
    Array<{ id: string; name: string; plannedSlots?: number }>
  >([]);
  // Rolling window of recent turn_stats events, newest-last.
  const [recentTurns, setRecentTurns] = useState<TurnStats[]>([]);
  // Most recently completed turn is daemon-backed rather than derived from
  // the one-minute rolling window, so it survives both quiet periods and a
  // page reload.
  const [lastTurn, setLastTurn] = useState<TurnStats | undefined>(undefined);
  // Per-model generation speed, median over every turn the DAEMON has served.
  // Deliberately not accumulated in the page: the 60s rolling window empties
  // the moment the machine goes quiet — precisely when a user opens the
  // popover to ask how fast their model is — and a page-scoped tally starts
  // empty again after every reload. The daemon's own record outlives both.
  const [modelSpeeds, setModelSpeeds] = useState<ModelSpeed[]>([]);
  // Static RAM footprint (bytes) once llama-cpp finishes loading the model.
  const [ramAllocBytes, setRamAllocBytes] = useState<number | undefined>(undefined);
  // Active local media-engine work (image / video generation), keyed by
  // session so concurrent jobs and out-of-order `ended` events don't
  // clobber each other. Sourced from the global `gpu_swap` feed —
  // separate from the chat-turn state because these engines run even
  // when the chat provider is a cloud model, and they should still show
  // in the pill (the user's "why does it say Qwen-idle while a video
  // renders?" case).
  const [mediaActivity, setMediaActivity] = useState<Map<string, MediaActivity>>(new Map());
  // Bump on ticks so the idle→busy duration reads live.
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverStyle = useStableHeaderPopoverPosition(rootRef, open, 6);
  const popoverId = onDeviceProvider ?? 'media';
  // Guards state writes from fetches that resolve after unmount. Same role
  // as the outer component's ref; the effect-local `cancelled` flags below
  // can't cover a callback shared between an effect and an event handler.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Click-outside closes the dropdown. Same pattern as QueueMeter.
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

  // The header hamburger menu dispatches this event when it opens —
  // cooperative dismissal so two popovers aren't stacked on top of
  // each other. (The general click-outside handler above usually
  // catches this, but Radix's DropdownMenu trigger can swallow the
  // mousedown before it bubbles to window, which is why we need an
  // explicit signal.)
  useEffect(() => {
    const close = (event: Event) => {
      if ((event as CustomEvent<{ source?: string }>).detail?.source === popoverId) return;
      setOpen(false);
    };
    window.addEventListener('gezel:close-header-popovers', close);
    return () => window.removeEventListener('gezel:close-header-popovers', close);
  }, [popoverId]);

  const queueState: ProviderQueueState | null = onDeviceProvider
    ? (queueStatus?.providers[onDeviceProvider] ?? null)
    : null;
  const deviceHealth: DeviceHealth | null = queueStatus?.deviceHealth ?? null;
  const deviceSafetyMode = config?.deviceSafety?.mode ?? deviceHealth?.mode ?? 'observe';
  const retentionMs = config?.localEngineIdleTimeoutMs ?? DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS;
  const providerInflightTurns = useMemo(
    () =>
      onDeviceProvider
        ? inflightTurns.filter((turn) => turn.providerName === onDeviceProvider)
        : [],
    [inflightTurns, onDeviceProvider],
  );
  const inflight = useMemo(
    () => ({
      count: providerInflightTurns.length,
      earliestStartedAt: providerInflightTurns.length
        ? Math.min(...providerInflightTurns.map((turn) => turn.startedAt))
        : null,
    }),
    [providerInflightTurns],
  );
  const sessionBacklog = useMemo(
    () =>
      onDeviceProvider
        ? (queueStatus?.sessions ?? []).reduce((total, session) => {
            // `providerName` is additive on the queue response; tolerate
            // an older daemon/client bundle during rolling upgrades.
            const providerName = (session as typeof session & { providerName?: ProviderName })
              .providerName;
            return providerName === onDeviceProvider ||
              (providerName === undefined && onDeviceProvider === defaultProvider)
              ? total + session.depth
              : total;
          }, 0)
        : 0,
    [defaultProvider, onDeviceProvider, queueStatus?.sessions],
  );
  const cacheEntry = onDeviceProvider
    ? queueStatus?.cache?.find((entry) => entry.providerName === onDeviceProvider)
    : undefined;
  const cacheState =
    cacheEntry && cacheEntry.warmSessionCount > 0
      ? {
          entrySummary: summarizeCacheEntries(cacheEntry.sessions, cacheEntry.warmSessionCount),
          totalBytes: cacheEntry.totalBytes,
          budgetBytes: cacheEntry.budgetBytes,
          recentHitRate: cacheEntry.recentHitRate,
        }
      : null;
  const liveTurns = useMemo(() => {
    if (!onDeviceProvider) return new Map<string, LiveTurn>();
    const providerBySession = new Map(
      inflightTurns.map((turn) => [turn.sessionId, turn.providerName] as const),
    );
    return new Map(
      Array.from(allLiveTurns.entries()).filter(
        ([sessionId, turn]) =>
          turn.provider === onDeviceProvider ||
          (turn.provider === undefined && providerBySession.get(sessionId) === onDeviceProvider),
      ),
    );
  }, [allLiveTurns, inflightTurns, onDeviceProvider]);

  const activeInflightModel = providerInflightTurns.reduce<InflightTurn | undefined>(
    (newest, turn) =>
      turn.model && (!newest || turn.startedAt > newest.startedAt) ? turn : newest,
    undefined,
  )?.model;
  const configuredDefault =
    activeInflightModel ??
    (onDeviceProvider ? config?.defaultModel?.[onDeviceProvider] : undefined);

  // Fetch the installed-models list and refresh on the same 10s tick
  // as config. Two reasons we can't trust `configuredDefault` alone:
  //   1. First-run bootstrap pins `defaultModel[provider]` to the
  //      recommended tier *before* the user clicks Download, so the
  //      pinned id has no weights on disk yet — labeling the pill
  //      with that name would lie about what's loaded.
  //   2. When no default is set, we still want to surface the first
  //      installed model (the supervisor's fallthrough target).
  useEffect(() => {
    if (!onDeviceProvider) {
      setInstalledModels([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const res =
          onDeviceProvider === 'mlx'
            ? await api.listMlxModels()
            : onDeviceProvider === 'ds4'
              ? await api.listDs4Models()
              : await api.listLlamaCppModels();
        if (cancelled) return;
        setInstalledModels(
          res.models.map((m) => ({
            id: m.id,
            name: m.name,
            ...(m.plannedSlots !== undefined ? { plannedSlots: m.plannedSlots } : {}),
          })),
        );
      } catch {
        /* non-fatal — pill just omits the model name */
      }
    };
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [onDeviceProvider]);

  // An in-flight session's runtime-selected model wins over the install default.
  // This is what lets a secondary llama.cpp pill say "Talkie" while the
  // default DwarfStar pill continues to show its own model. For an idle
  // provider, only honour the configured default when its weights are on
  // disk; otherwise mirror the supervisor's first-installed fallback.
  const installedDefault = configuredDefault
    ? installedModels.find((m) => m.id === configuredDefault)
    : undefined;
  const activeInstalledModel = activeInflightModel
    ? installedModels.find((model) => model.id === activeInflightModel)
    : undefined;
  const modelName = activeInflightModel
    ? (activeInstalledModel?.name ?? activeInflightModel)
    : (installedDefault?.name ?? installedModels[0]?.name);
  const modelId = activeInflightModel ?? installedDefault?.id ?? installedModels[0]?.id;
  // The memory strip lists every resident model by id; lend it the catalog
  // names we already fetched so the popover doesn't mix "Gemma 4 (E4B, Q4)"
  // with a raw `qwen3.6-27b-q4` two lines below.
  const installedModelNames = useMemo(
    () => new Map(installedModels.map((model) => [model.id, model.name])),
    [installedModels],
  );
  const installedModelConcurrentSlots = useMemo(
    () =>
      new Map(
        installedModels.flatMap((model) =>
          onDeviceProvider && model.plannedSlots !== undefined
            ? [[`${onDeviceProvider}:${model.id}`, model.plannedSlots] as const]
            : [],
        ),
      ),
    [installedModels, onDeviceProvider],
  );

  // Daemon-side per-model speed record. Only a finished turn can change it,
  // so the slow timer is a backstop for turns this page didn't witness
  // (another window, a scheduled job) rather than the primary trigger.
  const refreshModelSpeeds = useCallback(() => {
    if (!onDeviceProvider) {
      setModelSpeeds([]);
      setLastTurn(undefined);
      return;
    }
    void api
      .getUsage()
      .then((usage) => {
        if (!mountedRef.current) return;
        const providerUsage = usage.providers[onDeviceProvider];
        setModelSpeeds(providerUsage?.modelSpeeds ?? []);
        const latest = providerUsage?.lastTurn;
        if (!latest) return;
        const at = Date.parse(latest.at);
        const entry: TurnStats = {
          at: Number.isFinite(at) ? at : Date.now(),
          ...(latest.model ? { model: latest.model } : {}),
          promptTokens: latest.inputTokens,
          completionTokens: latest.outputTokens,
          durationMs: latest.durationMs,
          ...(typeof latest.outputTokensPerSec === 'number'
            ? { tokensPerSec: latest.outputTokensPerSec }
            : {}),
        };
        setLastTurn((current) => (!current || entry.at >= current.at ? entry : current));
      })
      .catch(() => {});
  }, [onDeviceProvider]);

  useEffect(() => {
    refreshModelSpeeds();
    const timer = setInterval(refreshModelSpeeds, 30_000);
    return () => clearInterval(timer);
  }, [refreshModelSpeeds]);

  // Pill-specific telemetry (per-turn stats + static RAM footprint).
  // Kept on its own subscription so QueueMeter — which doesn't need
  // any of this — stays lean.
  useEffect(() => {
    if (!onDeviceProvider) {
      setRecentTurns([]);
      setLastTurn(undefined);
      setRamAllocBytes(undefined);
      return;
    }
    setRecentTurns([]);
    setLastTurn(undefined);
    setRamAllocBytes(undefined);
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const { event } = env as ChatEventEnvelope;
          if (event.type === 'turn_stats') {
            if (event.provider !== onDeviceProvider) continue;
            const entry: TurnStats = {
              at: Date.now(),
              ...(event.model ? { model: event.model } : {}),
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              durationMs: event.durationMs,
              ...(typeof event.tokensPerSec === 'number'
                ? { tokensPerSec: event.tokensPerSec }
                : {}),
            };
            setRecentTurns((prev) => {
              const cutoff = Date.now() - STATS_WINDOW_MS;
              const filtered = prev.filter((t) => t.at >= cutoff);
              const next = [...filtered, entry];
              return next.length > STATS_MAX_ENTRIES
                ? next.slice(next.length - STATS_MAX_ENTRIES)
                : next;
            });
            setLastTurn(entry);
            refreshModelSpeeds();
          } else if (event.type === 'engine_stats') {
            if (event.provider !== onDeviceProvider) continue;
            setRamAllocBytes(event.ramAllocBytes);
          }
        }
      } catch {
        /* aborted / stream closed */
      }
    })();
    return () => ctrl.abort();
  }, [onDeviceProvider, refreshModelSpeeds]);

  // Media-engine activity belongs to the primary instance only. It remains
  // independent of the chat provider, but secondary local-engine pills must
  // not each duplicate the same Image/Video job.
  useEffect(() => {
    if (!includeMedia) {
      setMediaActivity(new Map());
      return;
    }
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const { event, sessionId, gezelId } = env as ChatEventEnvelope;
          if (event.type !== 'gpu_swap') continue;
          setMediaActivity((prev) => {
            const next = new Map(prev);
            if (event.state === 'ended') {
              next.delete(sessionId);
            } else {
              const existing = next.get(sessionId);
              next.set(sessionId, {
                kind: event.task === 'video_generation' ? 'video' : 'image',
                label: mediaLabel(event),
                gezelId,
                ...(typeof event.progress === 'number' ? { progress: event.progress } : {}),
                startedAt: existing?.startedAt ?? Date.now(),
              });
            }
            return next;
          });
        }
      } catch {
        /* aborted / stream closed */
      }
    })();
    return () => ctrl.abort();
  }, [includeMedia]);

  // Tick every second while anything is in-flight so the elapsed counter
  // advances. Also keeps the rolling-window prune in sync with the
  // clock so recentTurns entries older than 60s actually fall off.
  useEffect(() => {
    if (
      liveTurns.size === 0 &&
      recentTurns.length === 0 &&
      mediaActivity.size === 0 &&
      inflight.count === 0
    )
      return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      setRecentTurns((prev) => {
        const cutoff = Date.now() - STATS_WINDOW_MS;
        const filtered = prev.filter((e) => e.at >= cutoff);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [liveTurns.size, recentTurns.length, mediaActivity.size, inflight.count]);

  const rollingAvgTokensPerSec = useMemo(
    () => computeRollingTokensPerSec(recentTurns),
    [recentTurns],
  );
  const modelSpeedRows = useMemo(() => modelSpeeds.slice(0, 4), [modelSpeeds]);

  // Most-recent active media-engine job, if any. Takes visual precedence
  // over the chat engine: while an image/video renders, the chat model is
  // paused (that's what the gpu_swap event means), so the honest thing to
  // show is the engine actually doing work.
  const activeMedia = pickCurrentMedia(mediaActivity);

  // Hide the pill only when there's NOTHING on-device to show — neither
  // an on-device chat provider nor a running media engine.
  if (!onDeviceProvider && !activeMedia) return null;

  // Pick the most-recently-started turn to surface. Multi-session
  // cases are rare (local engine serializes to one at a time), but
  // if they happen we pick the newest so the pill shows what's
  // *right now*, not what's waiting.
  const current = pickCurrent(liveTurns);
  const currentInflight = pickCurrentInflight(providerInflightTurns);
  // A turn is in flight per the server's inflight snapshot. This is the
  // backstop for the case the user hit: a slow cold model load emits no
  // engine_phase events, the 90s sweeper drops `current`, but the turn
  // is still running (chat still shows dots). `current` keeps priority
  // because it carries the live phase label/progress; inflight only
  // supplies a generic "Working" + an elapsed clock when there's no
  // phase to show.
  const inflightActive = inflight.count > 0;
  const busy = activeMedia !== null || current !== null || inflightActive;
  // Unified "what's running" view — media engine wins over the chat turn,
  // which in turn wins over the label-less inflight backstop.
  const busyLabel = activeMedia
    ? activeMedia.label
    : (current?.label ?? (inflightActive ? 'Working' : ''));
  const busyProgress = activeMedia ? activeMedia.progress : current?.progress;
  const busyStartedAt = activeMedia
    ? activeMedia.startedAt
    : (current?.startedAt ?? inflight.earliestStartedAt ?? undefined);
  const activeGezelId = activeMedia?.gezelId ?? current?.gezelId ?? currentInflight?.gezelId;
  const activeGezel = activeGezelId ? gezels.get(activeGezelId) : undefined;
  const activeGezelName = activeGezel
    ? displayName(activeGezel, config?.roleBasedNameOnlyMode === true)
    : undefined;
  // Live decode counters. llama-server (`timings_per_token`) and MLX both
  // publish an exact running token count and decode rate on the phase
  // event; that is the truth and is printed bare. Only when an engine
  // publishes nothing until the turn ends do we fall back to deriving a
  // count from streamed characters — and then every number downstream of
  // it wears the "≈" so the readout never claims precision it lacks.
  const generating = current?.phase === 'generating';
  const exactOutputTokens = generating ? current.outputTokens : undefined;
  const exactTokensPerSec = generating ? current.tokensPerSec : undefined;
  const estimatedOutputTokens =
    exactOutputTokens === undefined && generating && !phaseLabelIncludesTokenCount(busyLabel)
      ? estimateLiveOutputTokens(current.outputChars ?? 0)
      : 0;
  const liveOutputTokens =
    exactOutputTokens ?? (estimatedOutputTokens > 0 ? estimatedOutputTokens : null);
  const tokensAreExact = exactOutputTokens !== undefined;
  const liveTokenLabel =
    liveOutputTokens !== null
      ? `${tokensAreExact ? '' : '≈'}${liveOutputTokens.toLocaleString('en-US')} tok`
      : '';
  // Estimated rate only when the engine reports none and its own phase
  // label doesn't already carry one — printing a weaker second estimate
  // beside an engine-side figure would read as a contradiction.
  const liveTokensPerSec =
    exactTokensPerSec ??
    (generating && current.generatingSince !== undefined && !phaseLabelIncludesTokenRate(busyLabel)
      ? computeLiveTokensPerSec(estimatedOutputTokens, current.generatingSince, Date.now())
      : null);
  const rateIsExact = exactTokensPerSec !== undefined;
  const liveRateLabel =
    liveTokensPerSec !== null && liveTokensPerSec !== undefined
      ? `${rateIsExact ? '' : '≈'}${formatTokensPerSec(liveTokensPerSec)}`
      : '';
  // Performance belongs in the detail dropdown, not in the compact header.
  // Our own engines now emit decode counters as fields and leave `detail`
  // alone, so this is a backstop: a phase detail that still carries prose
  // telemetry (an engine whose stdout wording drifts into it, a daemon
  // older than this UI) gets it stripped rather than shown. If stripping
  // empties the label, the phase names itself — same fallback the live-turn
  // hook applies to a detail-less event.
  const pillBusyLabel =
    stripTurnTelemetry(busyLabel) || (busyLabel && current ? phaseBaseLabel(current.phase) : '');
  // Strip catalog qualifiers like " (MLX, 4-bit)" from the displayed
  // model name. The engine pill already conveys "this Mac / on-device"
  // context — repeating the runtime + quantization in the pill is
  // redundant and just eats horizontal space. The popover and the
  // tooltips keep the cleaned name too; the catalog manifest itself
  // is unchanged.
  // Suppress the chat model name while a media engine is active — the
  // pill is showing "Video / Image", not the (paused) chat model.
  const displayModelName = activeMedia
    ? undefined
    : modelName
      ? modelName.replace(/\s*\([^)]*\)\s*$/, '').trim()
      : modelName;
  const modelSuffix = displayModelName ? ` · ${displayModelName}` : '';
  // Active tuning for the loaded model. Two independent layers can be in
  // play (see InstallModelTuningEditor): an install-wide preset
  // (`modelTuningProfile[id]`) and custom per-leaf overrides
  // (`modelTuning[id]`). Surface whichever is set so the popover makes
  // clear the model isn't necessarily running at catalog defaults. The
  // pill stays quiet — tuning is detail, not at-a-glance status.
  const tuningProfileId = modelId ? config?.modelTuningProfile?.[modelId] : undefined;
  const customTuning = modelId ? config?.modelTuning?.[modelId] : undefined;
  const hasCustomTuning = !!customTuning && Object.keys(customTuning).length > 0;
  const tuningProfileLabel = tuningProfileId
    ? isKnownProfileId(tuningProfileId)
      ? CANONICAL_PROFILES[tuningProfileId].label
      : tuningProfileId
    : undefined;
  const tuningText =
    tuningProfileLabel && hasCustomTuning
      ? `${tuningProfileLabel} · custom overrides`
      : tuningProfileLabel
        ? tuningProfileLabel
        : hasCustomTuning
          ? 'Custom tuning'
          : undefined;
  // Tooltip surfaces the technical id (e.g. "gemma4-e4b") instead of
  // the friendly catalog name shown on the pill itself — the pill
  // already shows the friendly name, so the hover is the place to
  // reveal the underlying model id for users who care.
  const tooltipModelSuffix = activeMedia ? '' : modelId ? ` · ${modelId}` : modelSuffix;
  const showProgress = busy && typeof busyProgress === 'number';
  const progressPct = showProgress
    ? Math.max(0, Math.min(100, Math.round((busyProgress as number) * 100)))
    : 0;
  const elapsed = busyStartedAt ? Math.max(0, Math.floor((Date.now() - busyStartedAt) / 1000)) : 0;
  const elapsedLabel = formatElapsedClock(elapsed);
  // Queue-depth numbers for the provider's request queue.
  //   queuedInteractive + queuedBackground = everything *waiting*,
  //   running = everything in-flight. Memory-extraction, auto-
  //   recall, and mention fan-out all land in queuedBackground, so
  //   they account for most of the "phantom" queue entries that
  //   appeared after a visible turn completed.
  const queuedRunning = queueState ? queueState.running : 0;
  // `running` counts slots, not conversations. Take the interactive
  // lane for anything the copy calls a chat, and leave the rest to be
  // named as background work.
  const queuedRunningInteractive = queueState?.runningInteractive;
  // Fold both queue layers into the numbers/strings the pill renders:
  // the provider request queue (running / interactive / background)
  // and the per-session backlog. See composeQueueStatus for why the
  // backlog matters — leaving it out is what made the pill read "Idle"
  // while chats sat enqueued.
  const queue = composeQueueStatus({
    running: queuedRunning,
    ...(queuedRunningInteractive !== undefined
      ? { runningInteractive: queuedRunningInteractive }
      : {}),
    interactive: queueState?.queuedInteractive ?? 0,
    background: queueState?.queuedBackground ?? 0,
    backlog: sessionBacklog,
  });
  // Chats only — the badge's own tooltip has always called these
  // "chats waiting to be answered", so counting one-shots here made the
  // pill promise conversations that did not exist.
  const queuedWaiting = queue.waiting;
  // Inline suffix shows "+N queued" when there's anything waiting.
  const queueSuffix = queuedWaiting > 0 ? ` · +${queuedWaiting} queued` : '';
  // The engine is "active" — animated dot, busy styling — whenever a
  // turn is in flight OR the provider is running OR work is waiting.
  const engineActive = busy || queue.active;
  // Popover Status line — who and what, not how many. The decode counters
  // have their own "This turn" row below; repeating them here made one long
  // string the eye has to parse for the part it wanted.
  const statusText = busy
    ? `${activeGezelName ? `${activeGezelName} · ` : ''}${busyLabel}${elapsed > 0 ? ` · ${elapsedLabel}` : ''}`
    : queue.idleStatus;
  const healthPresentation = deviceHealth ? presentDeviceHealth(deviceHealth) : null;
  const dotClassName = [
    'engine-pill-dot',
    engineActive ? 'engine-pill-dot-busy' : '',
    healthPresentation?.tone === 'warning' ? 'engine-pill-dot-warning' : '',
    healthPresentation?.tone === 'danger' ? 'engine-pill-dot-danger' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Shared provider naming keeps a secondary DwarfStar pill distinct from
  // the machine-named engines ("DwarfStar" vs. "This Mac"). With no chat
  // provider resolved the pill is here for media work only, so it names
  // the machine rather than an engine.
  const chatPillLabel = onDeviceProvider
    ? providerLabel(onDeviceProvider, window.__GEZEL__?.platform)
    : deviceLabel(window.__GEZEL__?.platform);
  // While a media engine runs, the pill's headline is the engine, not the
  // (paused) chat host — "Video" / "Image" instead of "This Mac".
  const platformPillLabel = activeMedia
    ? activeMedia.kind === 'video'
      ? 'Video'
      : 'Image'
    : chatPillLabel;
  // Crowded titlebar: shed words rather than run off the bar. The machine
  // name is the first to go — every local engine wears the same one, so it
  // stops distinguishing anything the moment a second pill appears, and the
  // model name below already tells the two apart. A named engine
  // ("DwarfStar", "Video", "Image") is not a machine name and stays.
  const kindNamesTheMachine =
    !activeMedia &&
    (!onDeviceProvider || onDeviceProvider === 'llama-cpp' || onDeviceProvider === 'mlx');
  const showKind = density === 'full' || !kindNamesTheMachine;
  // Tighter still: the gezel's name goes, leaving engine + phase + model.
  // Both stay in the pill's tooltip and in the popover's Status row.
  const showActor = density === 'full' || density === 'compact';
  // Last of all the model name goes, leaving the phase and the clock. Held
  // back until the label has something else to say: on an idle pill whose
  // machine name already went, the model is the only word there is, and
  // dropping it would leave a bare dot naming nothing.
  const showModel = density !== 'minimal' || !(busy || showKind);

  return (
    <div className="engine-pill-root" ref={rootRef}>
      <button
        type="button"
        className={engineActive ? 'engine-pill engine-pill-busy' : 'engine-pill'}
        onClick={() => {
          if (!open) {
            window.dispatchEvent(
              new CustomEvent('gezel:close-header-popovers', {
                detail: { source: popoverId },
              }),
            );
          }
          setOpen((currentOpen) => !currentOpen);
        }}
        aria-expanded={open}
        title={
          busy
            ? `${platformPillLabel}${tooltipModelSuffix} — ${activeGezelName ? `${activeGezelName} · ` : ''}${pillBusyLabel}${liveOutputTokens !== null ? ` · ${tokensAreExact ? '' : 'about '}${liveOutputTokens.toLocaleString('en-US')} output tokens` : ''}${elapsed > 0 ? ` · ${elapsedLabel}` : ''}${queueSuffix}${healthPresentation ? ` · ${healthPresentation.detail}` : ''}`
            : `${platformPillLabel}${tooltipModelSuffix}${queueSuffix}${healthPresentation ? ` · ${healthPresentation.detail}` : ''} — click for details`
        }
      >
        <span className={dotClassName} aria-hidden />
        <span className="engine-pill-label">
          {busy ? (
            <>
              {/* Keep the concrete engine visible beside live progress.
                  This is essential when a gezel override runs llama.cpp
                  alongside an idle default DwarfStar engine: two anonymous
                  progress bars would recreate the same ambiguity. On a
                  crowded bar the machine name drops out (see `showKind`)
                  and the model name below takes over that duty — which it
                  can, because two pills wearing "This Mac" were never told
                  apart by the name in the first place. */}
              {showKind && <span className="engine-pill-kind">{platformPillLabel}</span>}
              {showActor && activeGezelName && (
                <span className="engine-pill-actor">
                  {activeGezelName}
                  {showProgress || pillBusyLabel ? ' · ' : ''}
                </span>
              )}
              {showProgress ? (
                <span
                  className="engine-pill-progress"
                  title={pillBusyLabel}
                  aria-label={pillBusyLabel}
                  role="progressbar"
                  aria-valuenow={progressPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  tabIndex={-1}
                >
                  <span
                    className="engine-pill-progress-fill"
                    style={{ width: `${progressPct}%` }}
                  />
                </span>
              ) : (
                pillBusyLabel
              )}
            </>
          ) : (
            showKind && platformPillLabel
          )}
          {displayModelName && showModel && (
            // The separator belongs to whatever precedes the model name, so
            // a compacted idle pill reads "Qwen 3.8", not "· Qwen 3.8".
            <span className="engine-pill-model">{`${busy || showKind ? ' · ' : ''}${displayModelName}`}</span>
          )}
          {healthPresentation?.inline && (
            <>
              {' · '}
              <span className={`engine-pill-health engine-pill-health-${healthPresentation.tone}`}>
                {healthPresentation.inline}
              </span>
            </>
          )}
          {busy && elapsed > 0 && (
            <span className="engine-pill-elapsed">{` · ${elapsedLabel}`}</span>
          )}
          {queuedWaiting > 0 && (
            <span
              className="engine-pill-queue-badge"
              title={`${queuedWaiting} ${queuedWaiting === 1 ? 'chat' : 'chats'} waiting to be answered`}
            >
              +{queuedWaiting}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="engine-pill-popover" style={popoverStyle}>
          <div className="engine-pill-popover-header">
            {activeMedia ? `${platformPillLabel} engine` : `${chatPillLabel} AI engine`}
          </div>
          <dl className="engine-pill-stats">
            {modelName && !activeMedia && (
              <>
                <dt>Model</dt>
                {/* The pill trims to the base name to save header width;
                    the popover is the place for the specific build, so
                    it keeps the full catalog name — e.g. "Gemma 4 (E4B)"
                    rather than the trimmed "Gemma 4". */}
                <dd>{modelName}</dd>
              </>
            )}
            {tuningText && !activeMedia && (
              <>
                <dt>Tuning</dt>
                <dd>{tuningText}</dd>
              </>
            )}
            {ramAllocBytes !== undefined && !activeMedia && (
              <>
                <dt>Model allocation</dt>
                <dd>{formatBytes(ramAllocBytes)}</dd>
              </>
            )}
            <dt>Memory</dt>
            <dd className="engine-pill-memory">
              <MachineMemoryStrip
                modelNames={installedModelNames}
                modelConcurrentSlots={installedModelConcurrentSlots}
              />
            </dd>
            <dt>Status</dt>
            <dd>{statusText}</dd>
            {!activeMedia && (
              <>
                <dt>Idle models</dt>
                <dd className="engine-pill-retention-policy">
                  <fieldset className="gz-tray engine-pill-retention-mode">
                    <legend className="sr-only">Idle model retention</legend>
                    {ENGINE_RETENTION_PRESETS.map((preset) => (
                      <label
                        key={preset.value}
                        className={`gz-key${retentionMs === preset.value ? ' gz-key-active' : ''}`}
                      >
                        <input
                          type="radio"
                          className="engine-pill-retention-radio"
                          name="engine-idle-retention"
                          value={preset.value}
                          checked={retentionMs === preset.value}
                          disabled={retentionSaving}
                          onChange={() => void onRetentionChange(preset.value)}
                        />
                        {preset.label}
                      </label>
                    ))}
                  </fieldset>
                  <span className="engine-pill-retention-note">
                    {retentionSaving
                      ? 'Saving\u2026'
                      : retentionMs === 60_000
                        ? 'Unload one minute after the last engine request.'
                        : retentionMs === 1_800_000
                          ? 'Keep models warm for 30 minutes.'
                          : retentionMs === 300_000
                            ? 'Unload five minutes after the last engine request.'
                            : `Custom retention: ${Math.round(retentionMs / 60_000)} minutes.`}
                  </span>
                  {retentionError && (
                    <span className="engine-pill-health-policy-error" role="alert">
                      {retentionError}
                    </span>
                  )}
                </dd>
              </>
            )}
            {healthPresentation && (
              <>
                <dt>Machine health</dt>
                <dd>{healthPresentation.detail}</dd>
              </>
            )}
            <dt>Health policy</dt>
            <dd className="engine-pill-health-policy">
              <fieldset className="gz-tray engine-pill-health-mode">
                <legend className="sr-only">Machine health policy</legend>
                <button
                  type="button"
                  aria-pressed={deviceSafetyMode === 'observe'}
                  className={`gz-key${deviceSafetyMode === 'observe' ? ' gz-key-active' : ''}`}
                  disabled={deviceSafetySaving}
                  onClick={() => void onDeviceSafetyModeChange('observe')}
                >
                  Observe
                </button>
                <button
                  type="button"
                  aria-pressed={deviceSafetyMode === 'guard'}
                  className={`gz-key${deviceSafetyMode === 'guard' ? ' gz-key-active' : ''}`}
                  disabled={deviceSafetySaving}
                  onClick={() => void onDeviceSafetyModeChange('guard')}
                >
                  Manage
                </button>
              </fieldset>
              <span className="engine-pill-health-policy-note">
                {deviceSafetySaving
                  ? 'Saving\u2026'
                  : deviceSafetyMode === 'guard'
                    ? 'Gezel waits for safe temperature and throttle readings.'
                    : deviceSafetyMode === 'off'
                      ? 'Machine health management is off.'
                      : 'Gezel reports machine health without pausing below the 95\u00b0C hard limit.'}
              </span>
              {deviceSafetyError && (
                <span className="engine-pill-health-policy-error" role="alert">
                  {deviceSafetyError}
                </span>
              )}
            </dd>
            {activeMedia && (
              <>
                <dt>Note</dt>
                <dd>Chat model is paused while this engine uses the GPU.</dd>
              </>
            )}
            {/* No concurrency row: the slot count is already stated once, on
                the memory strip's reservation segment, and it is the same
                number the engine can generate at. Splitting it into "reserved"
                and "can run" is what made the popover read as a contradiction.
                Who is occupying the slots lives in the queue popover. */}
            {queue.queueRow && !activeMedia && (
              <>
                <dt>Queue</dt>
                <dd>{queue.queueRow}</dd>
              </>
            )}
            {liveTokenLabel && !activeMedia && (
              <>
                <dt>This turn</dt>
                <dd>
                  {liveTokenLabel}
                  {liveRateLabel && <> · {liveRateLabel}</>}
                </dd>
              </>
            )}
            {lastTurn && !activeMedia && (
              <>
                <dt>Last turn</dt>
                <dd>
                  {lastTurn.promptTokens.toLocaleString('en-US')} in ·{' '}
                  {lastTurn.completionTokens.toLocaleString('en-US')} out
                  {lastTurn.tokensPerSec !== undefined && (
                    <> · {formatTokensPerSec(lastTurn.tokensPerSec)}</>
                  )}
                </dd>
              </>
            )}
            {rollingAvgTokensPerSec !== null && !activeMedia && (
              <>
                <dt>Avg speed (1 min)</dt>
                <dd>{formatTokensPerSec(rollingAvgTokensPerSec)}</dd>
              </>
            )}
            {modelSpeedRows.length > 0 && !activeMedia && (
              <>
                <dt>Speed by model</dt>
                {/* Median across every turn this daemon has run — the
                    long-run answer to "how fast is this model here",
                    unlike the two rows above it. */}
                <dd>
                  <ul className="engine-pill-model-speeds">
                    {modelSpeedRows.map((row) => (
                      <li key={row.model}>
                        <span className="engine-pill-model-speed-name">
                          {installedModelNames.get(row.model) ?? row.model}
                        </span>
                        <span className="engine-pill-model-speed-rate">
                          {formatTokensPerSec(row.medianOutputTokensPerSec)}
                        </span>
                        <span className="engine-pill-model-speed-turns">
                          {row.turns === 1 ? '1 turn' : `${row.turns} turns`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {cacheState !== null && !activeMedia && (
              <>
                <dt>Cache</dt>
                <dd>
                  {cacheState.entrySummary.label} · {formatBytes(cacheState.totalBytes)} of{' '}
                  {formatBytes(cacheState.budgetBytes)}
                  {cacheState.recentHitRate > 0 && (
                    <> · {Math.round(cacheState.recentHitRate * 100)}% hit rate</>
                  )}
                </dd>
              </>
            )}
          </dl>
          {includeMedia && (
            <div className="engine-pill-emergency-stop">
              <div className="engine-pill-emergency-copy">
                <strong>Need everything to pause?</strong>
                <span>Stop every chat, unload local engines, and switch Gezel to Reactive.</span>
              </div>
              <button
                type="button"
                className="danger engine-pill-emergency-button"
                disabled={emergencyStopping}
                onClick={onEmergencyStopRequest}
              >
                {emergencyStopping ? 'Stopping…' : 'Hard Stop'}
              </button>
              {emergencyStopNotice && (
                <output className="engine-pill-emergency-notice">{emergencyStopNotice}</output>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function toOnDeviceProvider(provider: ProviderName | undefined): OnDeviceProvider | null {
  return provider === 'llama-cpp' || provider === 'mlx' || provider === 'ds4' ? provider : null;
}

function visibleOnDeviceProviders({
  defaultProvider,
  queueStatus,
  inflightTurns,
  liveTurns,
}: {
  defaultProvider: OnDeviceProvider | null;
  queueStatus: QueueStatusResponse | null;
  inflightTurns: readonly InflightTurn[];
  liveTurns: ReadonlyMap<string, LiveTurn>;
}): OnDeviceProvider[] {
  const visible = new Set<OnDeviceProvider>();
  if (defaultProvider) visible.add(defaultProvider);

  for (const provider of ON_DEVICE_PROVIDER_ORDER) {
    const queue = queueStatus?.providers[provider];
    if (queue && queue.running + queue.queuedInteractive + queue.queuedBackground > 0) {
      visible.add(provider);
    }
  }
  for (const turn of inflightTurns) {
    const provider = toOnDeviceProvider(turn.providerName);
    if (provider) visible.add(provider);
  }
  for (const turn of liveTurns.values()) {
    if (turn.provider) visible.add(turn.provider);
  }

  return [
    ...(defaultProvider && visible.has(defaultProvider) ? [defaultProvider] : []),
    ...ON_DEVICE_PROVIDER_ORDER.filter(
      (provider) => provider !== defaultProvider && visible.has(provider),
    ),
  ];
}

function pickCurrent(turns: Map<string, LiveTurn>): LiveTurn | null {
  if (turns.size === 0) return null;
  let newest: LiveTurn | null = null;
  for (const t of turns.values()) {
    if (!newest || t.startedAt > newest.startedAt) newest = t;
  }
  return newest;
}

function pickCurrentInflight(turns: readonly InflightTurn[]): InflightTurn | null {
  let newest: InflightTurn | null = null;
  for (const turn of turns) {
    if (!newest || turn.startedAt > newest.startedAt) newest = turn;
  }
  return newest;
}

function phaseLabelIncludesTokenCount(label: string): boolean {
  return /\b\d[\d,]*\s+tokens?\b/i.test(label);
}

function phaseLabelIncludesTokenRate(label: string): boolean {
  return /\btok\/s\b/i.test(label);
}

/** A phase-detail fragment that carries only a token count or decode rate. */
const TURN_TELEMETRY =
  /(?:about\s+|~|≈)?\d[\d,]*(?:\.\d+)?\s*(?:\/\s*\d[\d,]*\s*)?(?:tokens?|tok\/s)\b/i;

function dropTelemetrySegments(text: string): string {
  return text
    .split(/\s*·\s*/)
    .filter((segment) => segment.trim() !== '' && !TURN_TELEMETRY.test(segment))
    .join(' · ');
}

/**
 * Strip per-turn telemetry from a phase detail. Engines bury it at
 * different depths — llama.cpp nests it inside parentheses
 * ("Processing prompt (47% · 6,144 / 12,000 tokens)"), MLX makes it the
 * whole label — so whole separator-delimited segments go, inside
 * parentheses first, and a dash-attached tail is handled on its own
 * because an em dash also separates non-telemetry detail
 * ("Generating video — step 12/40").
 */
function stripTurnTelemetry(label: string): string {
  const withoutDashTail = label.replace(
    /\s*[—–-]\s*(?:about\s+|~|≈)?\d[\d,]*(?:\.\d+)?\s*(?:\/\s*\d[\d,]*\s*)?(?:tokens?|tok\/s)\b/gi,
    '',
  );
  const withoutParens = withoutDashTail.replace(/\(([^()]*)\)/g, (_whole, inner: string) => {
    const kept = dropTelemetrySegments(inner);
    return kept ? `(${kept})` : '';
  });
  return dropTelemetrySegments(withoutParens)
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[·—–-]\s*|\s*[·—–-]\s*$/g, '')
    .trim();
}

/** One in-flight local media-engine job (image / video / recognition). */
interface MediaActivity {
  kind: 'image' | 'video' | 'recognition';
  /** Gezel whose turn owns this GPU task. */
  gezelId?: string;
  /** Live phase/progress label, e.g. "Loading model weights…" or
   *  "Generating video — step 12/40". */
  label: string;
  /** 0–1 sampling progress, when the engine reports per-step counters. */
  progress?: number;
  startedAt: number;
}

/** Compose the pill label from a `gpu_swap` event. */
function mediaLabel(event: {
  task: SessionGpuTask;
  detail?: string;
  step?: number;
  totalSteps?: number;
}): string {
  if (event.task === 'image_recognition') {
    return event.detail?.trim() ? event.detail.trim() : 'Reading image';
  }
  const noun = event.task === 'video_generation' ? 'video' : 'image';
  if (
    typeof event.step === 'number' &&
    typeof event.totalSteps === 'number' &&
    event.totalSteps > 0
  ) {
    return `Generating ${noun} — step ${event.step}/${event.totalSteps}`;
  }
  if (event.detail && event.detail.trim().length > 0) return event.detail.trim();
  return `Generating ${noun}`;
}

function pickCurrentMedia(media: Map<string, MediaActivity>): MediaActivity | null {
  if (media.size === 0) return null;
  let newest: MediaActivity | null = null;
  for (const m of media.values()) {
    if (!newest || m.startedAt > newest.startedAt) newest = m;
  }
  return newest;
}
