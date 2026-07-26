/**
 * EngineStatusPill
 *
 * Always-visible status indicator for the active on-device engine
 * (llama.cpp, MLX, or DwarfStar). Sits in the app header alongside QueueMeter /
 * EngagementBadge / QuotaMeter. Hidden entirely when the active
 * provider isn't on-device — no point showing "On-device: idle"
 * when the user is on Copilot.
 *
 * Two visual states:
 *   1. **Idle** — muted "On-device · model-name" badge.
 *   2. **Busy** — animated dot + the current `engine_phase` label
 *      (e.g. "Processing prompt (47% · 6,144 tokens)", "Generating",
 *      "Loading model") surfaced live from the SSE stream.
 *
 * Click opens a dropdown with richer telemetry — per-turn tokens
 * in/out, generation tokens/sec, a rolling average over the last
 * minute, and the static RAM footprint llama-cpp reported after
 * loading the model.
 *
 * Drives off the same global `streamAllChatEvents` feed the rest of
 * the app uses. No new endpoint, no polling beyond the cheap 10s
 * config refresh.
 */

import type { ChatEventEnvelope, ProviderName, SessionGpuTask } from '@bendyline/gezel';
import { CANONICAL_PROFILES, isKnownProfileId } from '@bendyline/gezel';
import type { ConfigResponse, ProviderQueueState } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';
import {
  type DeviceHealth,
  deviceSafetyModeLabel,
  presentDeviceHealth,
} from './engine-pill-device-health.js';
import {
  type TurnStatsEntry,
  composeQueueStatus,
  computeRollingTokensPerSec,
  formatBytes,
  formatTokensPerSec,
} from './engine-pill-stats.js';
import { type LiveTurnState, useOnDeviceLiveTurns } from './useOnDeviceLiveTurns.js';

type LiveTurn = LiveTurnState;
type TurnStats = TurnStatsEntry;

/** Retention for per-turn stats in the rolling-average computation. */
const STATS_WINDOW_MS = 60_000;
/** Absolute cap so a very chatty session doesn't grow state unbounded. */
const STATS_MAX_ENTRIES = 40;

export function EngineStatusPill() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  // Models actually present on disk for the active on-device provider.
  // Polled on the same 10s cadence as config so the pill reflects an
  // install finishing (or being deleted) without needing a page reload.
  const [installedModels, setInstalledModels] = useState<Array<{ id: string; name: string }>>([]);
  // Rolling window of recent turn_stats events, newest-last.
  const [recentTurns, setRecentTurns] = useState<TurnStats[]>([]);
  // Static RAM footprint (bytes) once llama-cpp finishes loading the model.
  const [ramAllocBytes, setRamAllocBytes] = useState<number | undefined>(undefined);
  // Live queue state for the llama-cpp provider. Polled from
  // /api/queues every 3s while the provider is active. Drives both
  // the inline "+N queued" tail on the pill and the Queue row in
  // the dropdown. Polling matches QueueMeter's cadence — the
  // endpoint is just in-memory counts, basically free.
  const [queueState, setQueueState] = useState<ProviderQueueState | null>(null);
  const [deviceHealth, setDeviceHealth] = useState<DeviceHealth | null>(null);
  // Per-session backlog depth (summed across sessions) from the
  // SessionQueue layer — messages queued behind an in-flight turn.
  // This is a DIFFERENT queue from `queueState` above: those are
  // provider-level request slots, these are conversation-level sends
  // waiting their turn. The pill used to ignore this entirely, which
  // is why it could read "Idle" while chats sat enqueued and why the
  // backlog had no badge of its own. Polled from the same /api/queues
  // tick. Lives independently of `queueState` because the backlog can
  // be non-empty even when the provider queue is null (provider not
  // yet initialized, or the in-flight turn already drained).
  const [sessionBacklog, setSessionBacklog] = useState(0);
  // In-flight turns from /api/sessions/inflight — the SAME authoritative
  // signal the chat timeline's typing-dots ride on. This is the busy
  // source of truth: `engine_phase` events (which drive `liveTurns`
  // below) go silent during a slow cold model load, and the 90s idle
  // sweeper then drops the turn — but it's still running, so the pill
  // would flip to "Idle" mid-turn while the chat clearly shows dots.
  // The server holds an inflight entry until the turn's `done`/`error`
  // (its own 5-min watchdog clears a truly-wedged one), so polling it
  // keeps the pill and the timeline from ever disagreeing. `count` is
  // the number of live turns; `earliestStartedAt` seeds the elapsed
  // clock when we have no phase label to borrow `startedAt` from.
  const [inflight, setInflight] = useState<{ count: number; earliestStartedAt: number | null }>({
    count: 0,
    earliestStartedAt: null,
  });
  // Phase 1+ cache controller stats — populated alongside queueState
  // from the same /api/queues poll. Null when no controller is wired
  // or the active provider has no warm sessions; the popover hides
  // the cache rows in either case.
  const [cacheState, setCacheState] = useState<{
    warmSessionCount: number;
    totalBytes: number;
    budgetBytes: number;
    recentHitRate: number;
  } | null>(null);
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
    const close = () => setOpen(false);
    window.addEventListener('gezel:close-header-popovers', close);
    return () => window.removeEventListener('gezel:close-header-popovers', close);
  }, []);

  // Initial config + auto-model resolution. Refresh on provider change
  // events? Today we don't have a broadcast for that — the pill will
  // re-evaluate on the next full app refresh. Cheap polling every 10s
  // catches config changes from Settings without needing a bus.
  const refreshConfig = useCallback(() => {
    api
      .getConfig()
      .then((c) => {
        if (!mountedRef.current) return;
        setConfig(c);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshConfig();
    const t = setInterval(refreshConfig, 10_000);
    return () => clearInterval(t);
  }, [refreshConfig]);

  const provider: ProviderName = config?.provider ?? 'copilot';
  // Which on-device provider the pill is tracking right now. `null`
  // when the active provider isn't on-device at all — the pill hides
  // itself in that case.
  const onDeviceProvider: 'llama-cpp' | 'mlx' | 'ds4' | null =
    provider === 'llama-cpp'
      ? 'llama-cpp'
      : provider === 'mlx'
        ? 'mlx'
        : provider === 'ds4'
          ? 'ds4'
          : null;

  // Poll queue status every 3s while an on-device provider is active.
  // When the provider hasn't been initialized yet, `/api/queues`
  // omits it and the state stays null (inline queue suffix hides).
  useEffect(() => {
    if (!onDeviceProvider && mediaActivity.size === 0) {
      setQueueState(null);
      setCacheState(null);
      setDeviceHealth(null);
      setSessionBacklog(0);
      setInflight({ count: 0, earliestStartedAt: null });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        // Both polls on the same 3s tick. /api/sessions/inflight is
        // global (not provider-scoped), but the pill only renders for an
        // active on-device provider, so a live turn is overwhelmingly on
        // that engine; the rare cross-provider background turn isn't worth
        // a provider filter the endpoint doesn't offer.
        const [status, inf] = await Promise.all([api.getQueueStatus(), api.listInflightTurns()]);
        if (cancelled) return;
        const turns = inf.inflight ?? [];
        setInflight({
          count: turns.length,
          earliestStartedAt: turns.length ? Math.min(...turns.map((t) => t.startedAt)) : null,
        });
        setQueueState(onDeviceProvider ? (status.providers[onDeviceProvider] ?? null) : null);
        setDeviceHealth(status.deviceHealth ?? null);
        // Sum the per-session backlog. `status.sessions` is global (not
        // keyed by provider), but the on-device engine pill is only shown
        // when an on-device provider is the active default, so these are
        // the chats it's working through. This is the "chat queue
        // backlog" surfaced as a badge + status below.
        setSessionBacklog((status.sessions ?? []).reduce((n, s) => n + s.depth, 0));
        // Cache stats keyed by providerName. Skip the entry entirely
        // when warmSessionCount is 0 — the rows are noise without
        // anything cached.
        const entry = onDeviceProvider
          ? status.cache?.find((c) => c.providerName === onDeviceProvider)
          : undefined;
        if (entry && entry.warmSessionCount > 0) {
          setCacheState({
            warmSessionCount: entry.warmSessionCount,
            totalBytes: entry.totalBytes,
            budgetBytes: entry.budgetBytes,
            recentHitRate: entry.recentHitRate,
          });
        } else {
          setCacheState(null);
        }
      } catch {
        /* non-fatal */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 3_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [onDeviceProvider, mediaActivity.size]);

  const configuredDefault = onDeviceProvider ? config?.defaultModel?.[onDeviceProvider] : undefined;

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
        setInstalledModels(res.models.map((m) => ({ id: m.id, name: m.name })));
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

  // Only honour the configured default when its weights are on disk.
  // Otherwise fall through to the first installed model, mirroring the
  // supervisor's dispatch behavior.
  const installedDefault = configuredDefault
    ? installedModels.find((m) => m.id === configuredDefault)
    : undefined;
  const modelName = installedDefault?.name ?? installedModels[0]?.name;
  const modelId = installedDefault?.id ?? installedModels[0]?.id;

  // Live phase state via shared hook — QueueMeter reads the same
  // state from its own mount of the hook, so the two surfaces never
  // drift on which turn is running or what phase it's in.
  const liveTurns = useOnDeviceLiveTurns(onDeviceProvider !== null);

  // Pill-specific telemetry (per-turn stats + static RAM footprint).
  // Kept on its own subscription so QueueMeter — which doesn't need
  // any of this — stays lean.
  useEffect(() => {
    if (!onDeviceProvider) {
      setRecentTurns([]);
      setRamAllocBytes(undefined);
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
          const { event } = env as ChatEventEnvelope;
          if (event.type === 'turn_stats') {
            if (event.provider !== onDeviceProvider) continue;
            const entry: TurnStats = {
              at: Date.now(),
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
  }, [onDeviceProvider]);

  // Media-engine activity (image / video) from the global gpu_swap feed.
  // ALWAYS subscribed — unlike the chat telemetry above this isn't gated
  // on an on-device chat provider, because the image/video engines run
  // independently of whichever model is answering chat.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const { event, sessionId } = env as ChatEventEnvelope;
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
  }, []);

  // Tick every second while anything is in-flight so "N s" counter
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
  const lastTurn = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1] : undefined;

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
  // Queue-depth numbers for the provider's request queue.
  //   queuedInteractive + queuedBackground = everything *waiting*,
  //   running = everything in-flight. Memory-extraction, auto-
  //   recall, and mention fan-out all land in queuedBackground, so
  //   they account for most of the "phantom" queue entries that
  //   appeared after a visible turn completed.
  const queuedRunning = queueState ? queueState.running : 0;
  // Fold both queue layers into the numbers/strings the pill renders:
  // the provider request queue (running / interactive / background)
  // and the per-session backlog. See composeQueueStatus for why the
  // backlog matters — leaving it out is what made the pill read "Idle"
  // while chats sat enqueued.
  const queue = composeQueueStatus({
    running: queuedRunning,
    interactive: queueState?.queuedInteractive ?? 0,
    background: queueState?.queuedBackground ?? 0,
    backlog: sessionBacklog,
  });
  const queuedWaiting = queue.waiting;
  // Inline suffix shows "+N queued" when there's anything waiting.
  const queueSuffix = queuedWaiting > 0 ? ` · +${queuedWaiting} queued` : '';
  // The engine is "active" — animated dot, busy styling — whenever a
  // turn is in flight OR the provider is running OR work is waiting.
  const engineActive = busy || queue.active;
  // Popover Status line. While a turn is actively generating we show
  // the live phase label (queue counts aren't known to composeQueueStatus);
  // otherwise the queue-aware idle/queued string.
  const statusText = busy ? `${busyLabel}${elapsed > 0 ? ` · ${elapsed}s` : ''}` : queue.idleStatus;
  const healthPresentation = deviceHealth ? presentDeviceHealth(deviceHealth) : null;
  const dotClassName = [
    'engine-pill-dot',
    engineActive ? 'engine-pill-dot-busy' : '',
    healthPresentation?.tone === 'warning' ? 'engine-pill-dot-warning' : '',
    healthPresentation?.tone === 'danger' ? 'engine-pill-dot-danger' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Label reflects which on-device engine is actually routing chat.
  // MLX is exclusive to Apple Silicon — read "This Mac" on darwin;
  // llama.cpp is the default on Windows/Linux and the advanced
  // fallback on Mac.
  const platform = window.__GEZEL__?.platform;
  const chatPillLabel =
    onDeviceProvider === 'ds4'
      ? 'DwarfStar'
      : onDeviceProvider === 'mlx'
        ? 'This Mac'
        : platform === 'win32'
          ? 'This Windows PC'
          : platform === 'linux'
            ? 'This Linux device'
            : 'On-device';
  // While a media engine runs, the pill's headline is the engine, not the
  // (paused) chat host — "Video" / "Image" instead of "This Mac".
  const platformPillLabel = activeMedia
    ? activeMedia.kind === 'video'
      ? 'Video'
      : 'Image'
    : chatPillLabel;

  return (
    <div className="engine-pill-root" ref={rootRef}>
      <button
        type="button"
        className={engineActive ? 'engine-pill engine-pill-busy' : 'engine-pill'}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={
          busy
            ? `${platformPillLabel}${tooltipModelSuffix} — ${busyLabel}${elapsed > 0 ? ` · ${elapsed}s` : ''}${queueSuffix}${healthPresentation ? ` · ${healthPresentation.detail}` : ''}`
            : `${platformPillLabel}${tooltipModelSuffix}${queueSuffix}${healthPresentation ? ` · ${healthPresentation.detail}` : ''} — click for details`
        }
      >
        <span className={dotClassName} aria-hidden />
        <span className="engine-pill-label">
          {busy ? (
            showProgress ? (
              <>
                {/* A bare progress bar reads identically to the chat
                    model's prompt-prefill bar — so during local image /
                    video generation we keep the "Image" / "Video" word
                    in front of it, otherwise the user can't tell media
                    generation apart from normal chat processing. */}
                {activeMedia && <span className="engine-pill-media-kind">{platformPillLabel}</span>}
                <span
                  className="engine-pill-progress"
                  title={busyLabel}
                  aria-label={busyLabel}
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
              </>
            ) : (
              busyLabel
            )
          ) : (
            platformPillLabel
          )}
          {displayModelName && (
            <span className="engine-pill-model">{` · ${displayModelName}`}</span>
          )}
          {healthPresentation?.inline && (
            <span className={`engine-pill-health engine-pill-health-${healthPresentation.tone}`}>
              {` · ${healthPresentation.inline}`}
            </span>
          )}
          {busy && elapsed > 0 && <span className="engine-pill-elapsed">{` · ${elapsed}s`}</span>}
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
        <div className="engine-pill-popover">
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
                <dt>Memory</dt>
                <dd>{formatBytes(ramAllocBytes)}</dd>
              </>
            )}
            <dt>Status</dt>
            <dd>{statusText}</dd>
            {healthPresentation && (
              <>
                <dt>Machine health</dt>
                <dd>{healthPresentation.detail}</dd>
                <dt>Safety</dt>
                <dd>{deviceSafetyModeLabel(deviceHealth?.mode)}</dd>
              </>
            )}
            {activeMedia && (
              <>
                <dt>Note</dt>
                <dd>Chat model is paused while this engine uses the GPU.</dd>
              </>
            )}
            {/* How many chat turns this engine can generate at once. MLX is
                serial today (1); llama-cpp with batched inference on shows
                its `--parallel` slot count. A future batched-MLX phase lifts
                MLX to N here with no change to this surface. */}
            {typeof queueState?.maxConcurrency === 'number' && !activeMedia && (
              <>
                <dt>Concurrency</dt>
                <dd>
                  {queueState.maxConcurrency <= 1
                    ? '1 session at a time'
                    : `up to ${queueState.maxConcurrency} concurrent sessions`}
                </dd>
              </>
            )}
            {queue.queueRow && !activeMedia && (
              <>
                <dt>Queue</dt>
                <dd>{queue.queueRow}</dd>
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
            {cacheState !== null && !activeMedia && (
              <>
                <dt>Cache</dt>
                <dd>
                  {cacheState.warmSessionCount}{' '}
                  {cacheState.warmSessionCount === 1 ? 'session' : 'sessions'} ·{' '}
                  {formatBytes(cacheState.totalBytes)} of {formatBytes(cacheState.budgetBytes)}
                  {cacheState.recentHitRate > 0 && (
                    <> · {Math.round(cacheState.recentHitRate * 100)}% hit rate</>
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function pickCurrent(turns: Map<string, LiveTurn>): LiveTurn | null {
  if (turns.size === 0) return null;
  let newest: LiveTurn | null = null;
  for (const t of turns.values()) {
    if (!newest || t.startedAt > newest.startedAt) newest = t;
  }
  return newest;
}

/** One in-flight local media-engine job (image / video / recognition). */
interface MediaActivity {
  kind: 'image' | 'video' | 'recognition';
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
