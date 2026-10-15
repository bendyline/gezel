/**
 * The first-run model download, as state and actions.
 *
 * The service pins `config.provider` to `llama-cpp` or `mlx` and a
 * recommended model at first boot, but downloads nothing: the person starts
 * it with one tap (see `bootstrapOnDeviceFirstRun` service-side). This hook
 * owns what happens around that tap — checking what is already on disk,
 * tracking an install in flight, the failure paths and their escape hatches —
 * so the welcome only decides how each state reads.
 *
 * Generic over the two on-device providers: the only per-provider wiring is
 * which install and list endpoints to call.
 */

import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { announceModelInventoryChanged } from '../model-inventory.js';
import { llamaEngineNeed } from './first-run-engine.js';
import { type InstallProgress, readSizeFromCatalog } from './first-run-model-text.js';
import { type InstallRate, emptyInstallRate, recordInstallSample } from './install-rate.js';
import { useCopilotAvailability } from './useCopilotAvailability.js';

export type OnDeviceProvider = 'llama-cpp' | 'mlx';

export interface ChecksumMismatch {
  file: string;
  expected: string;
  actual: string;
}

export type FirstRunModelState =
  /** Not in first run, or the provider is not an on-device one. */
  | { kind: 'off' }
  /**
   * Waiting on the first inventory answer. On a machine with borrowed or
   * shared models that answer can take minutes (each model is hashed once).
   */
  | { kind: 'checking' }
  | {
      kind: 'needs-download';
      provider: OnDeviceProvider;
      modelId: string;
      sizeBytes: number | null;
      /** The engine that comes down beside the model, when it is still needed. */
      engineBytes?: number;
      /** Chat models already on disk that could be used right away. */
      alternatives: Array<{ id: string; name: string }>;
    }
  | {
      kind: 'installing';
      provider: OnDeviceProvider;
      modelId: string;
      sizeBytes: number | null;
      progress: InstallProgress | null;
    }
  | {
      kind: 'failed';
      provider: OnDeviceProvider;
      modelId: string;
      error: string;
      /**
       * Set when the failure was a sha256 mismatch against the catalog, so
       * the welcome can offer "Download anyway" — Hugging Face republished
       * the file and the catalog has not caught up.
       */
      mismatch?: ChecksumMismatch;
    }
  /**
   * The model is on disk and the engine that runs it is still arriving (or
   * could not be fetched). See `llamaEngineNeed`.
   */
  | {
      kind: 'engine';
      provider: OnDeviceProvider;
      modelId: string;
      progress: { bytesWritten: number; totalBytes: number } | null;
      error?: string;
    }
  /** The recommended model (or a chosen alternative) is on disk, and its engine. */
  | { kind: 'ready' };

export interface FirstRunModel {
  state: FirstRunModelState;
  rate: InstallRate;
  /** Ticks every second while installing, for the quiet/stalled notices. */
  now: number;
  /** An action the person started is still running. */
  busy: boolean;
  /** Copilot's runtime is on disk; null while unknown. */
  copilotAvailable: boolean | null;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  /** Fetch the engine again after it failed. */
  retryEngine: () => void;
  downloadAnyway: () => Promise<void>;
  pickInstalled: (modelId: string) => Promise<void>;
  switchToLlamaCpp: () => Promise<void>;
  switchToCopilot: () => Promise<void>;
}

function failedFromCaught(
  err: unknown,
  provider: OnDeviceProvider,
  modelId: string,
): FirstRunModelState {
  const error = err instanceof Error ? err.message : String(err);
  const mismatch =
    err instanceof Error && 'mismatch' in err
      ? (err as Error & { mismatch?: ChecksumMismatch }).mismatch
      : undefined;
  return mismatch
    ? { kind: 'failed', provider, modelId, error, mismatch }
    : { kind: 'failed', provider, modelId, error };
}

function isOnDevice(provider: string | undefined): provider is OnDeviceProvider {
  return provider === 'llama-cpp' || provider === 'mlx';
}

export function useFirstRunModel({
  enabled,
  config,
  onConfigChanged,
  onModelInstalled,
}: {
  /** Only a first run polls; everything else stays `off`. */
  enabled: boolean;
  config: ConfigResponse | null;
  onConfigChanged: (next: ConfigResponse) => void;
  /** Fired once when the model is first seen on disk, so Home can re-probe. */
  onModelInstalled?: () => void;
}): FirstRunModel {
  const active = enabled && isOnDevice(config?.provider);
  const [state, setState] = useState<FirstRunModelState>(
    active ? { kind: 'checking' } : { kind: 'off' },
  );
  const [rate, setRate] = useState<InstallRate>(emptyInstallRate);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const installedNotifiedRef = useRef(false);
  const checkInFlightRef = useRef(false);
  // Our own install request is still open. The daemon registers the install
  // a moment after the request starts, and a progress poll that lands in
  // that gap must not read "nothing in flight" as "the install ended".
  const installRequestOpenRef = useRef(false);
  const copilotAvailability = useCopilotAvailability();
  // One engine fetch at a time. The daemon's job is idempotent and outlives
  // this request, so a second ensure would only attach to the same download.
  const engineFetchRef = useRef<Promise<boolean> | null>(null);
  const [engineProgress, setEngineProgress] = useState<{
    bytesWritten: number;
    totalBytes: number;
  } | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  useEffect(() => {
    setState((prev) => {
      if (!active) return prev.kind === 'off' ? prev : { kind: 'off' };
      return prev.kind === 'off' ? { kind: 'checking' } : prev;
    });
  }, [active]);

  const provider = config?.provider;
  const defaultModel = config?.defaultModel;
  const firstRunInstallError = config?.firstRunInstallError;

  const backendOverride = config?.llamaCppBackendOverride;
  /**
   * Start (or attach to) the engine download. Resolves `true` when it landed:
   * a failure arrives as an `error` event on a stream that still ends
   * normally, and treating that as done re-checked, re-fetched and cleared
   * the error before its card could show — a request loop with no way out.
   */
  const fetchEngine = useCallback((variant: string | undefined): Promise<boolean> => {
    if (engineFetchRef.current) return engineFetchRef.current;
    setEngineError(null);
    let failed = false;
    const run = api
      .ensureNativeEngine(
        'llama-server',
        (ev) => {
          if (ev.type === 'progress') {
            setEngineProgress({ bytesWritten: ev.bytesWritten, totalBytes: ev.totalBytes });
          } else if (ev.type === 'error') {
            failed = true;
            setEngineError(ev.error);
          }
        },
        variant,
      )
      .then(() => !failed)
      .catch((err: unknown) => {
        setEngineError(err instanceof Error ? err.message : String(err));
        return false;
      })
      .finally(() => {
        engineFetchRef.current = null;
      });
    engineFetchRef.current = run;
    return run;
  }, []);

  /**
   * The model is on disk; fetch the engine that runs it if that is still
   * missing. A picked installed model must end here too: it once jumped
   * straight to `ready`, Home held first run for the missing engine, and
   * nothing ever fetched it, so the welcome said "Getting ready…" forever.
   */
  const settleOnDisk = useCallback(
    async (target: OnDeviceProvider, modelId: string) => {
      const need = await llamaEngineNeed({
        provider: target,
        ...(backendOverride ? { llamaCppBackendOverride: backendOverride } : {}),
      });
      if (need) {
        setState({ kind: 'engine', provider: target, modelId, progress: null });
        // On failure stay here: the error card's Try again re-checks.
        void fetchEngine(need.variant).then((landed) => {
          if (landed) setState({ kind: 'checking' });
        });
        return;
      }
      setState({ kind: 'ready' });
      if (!installedNotifiedRef.current) {
        installedNotifiedRef.current = true;
        announceModelInventoryChanged(target);
        onModelInstalled?.();
      }
    },
    [backendOverride, fetchEngine, onModelInstalled],
  );

  const check = useCallback(async () => {
    if (!isOnDevice(provider)) return;
    // An inventory answer can take minutes on first adoption of shared
    // models; stacking a fresh request every poll only slowed it further.
    if (checkInFlightRef.current) return;
    checkInFlightRef.current = true;
    try {
      const targetModel = defaultModel?.[provider];
      if (!targetModel) {
        // The first-run pin is written in the background at daemon start, so a
        // config read before it landed has no target yet. Re-read rather than
        // give up: an empty welcome is a dead end.
        try {
          const fresh = await api.getConfig();
          if (fresh.defaultModel?.[provider]) onConfigChanged(fresh);
        } catch {
          // Keep checking on the next poll.
        }
        return;
      }
      if (firstRunInstallError) {
        setState({ kind: 'failed', provider, modelId: targetModel, error: firstRunInstallError });
        return;
      }
      try {
        const [modelsRes, activeRes, catalog] = await Promise.all([
          provider === 'mlx' ? api.listMlxModels() : api.listLlamaCppModels(),
          provider === 'mlx' ? api.listMlxActiveInstalls() : api.listLlamaCppActiveInstalls(),
          api.getCatalogItem('chat-model', targetModel).catch(() => null),
        ]);
        if (modelsRes.models.some((m) => m.id === targetModel)) {
          await settleOnDisk(provider, targetModel);
          return;
        }
        const sizeBytes = readSizeFromCatalog(catalog, provider);
        // Prefer the pinned model's install, but fall back to any other
        // in-flight install for this provider (e.g. one started from
        // Settings). Offering the pinned download while another multi-GB
        // install streams would run two at once and track neither.
        const inFlight =
          activeRes.installs.find((i) => i.catalogId === targetModel) ?? activeRes.installs[0];
        if (inFlight) {
          setState({
            kind: 'installing',
            provider,
            modelId: inFlight.catalogId,
            sizeBytes: inFlight.catalogId === targetModel ? sizeBytes : null,
            progress: {
              bytesWritten: inFlight.bytesWritten,
              totalBytes: inFlight.totalBytes,
              phase: inFlight.phase,
            },
          });
          return;
        }
        // Nothing installed and nothing in flight: a fresh first run or an
        // abandoned download. Either way we wait for the person's tap. The
        // engine comes down with the model, so the key counts it too.
        const engine = await llamaEngineNeed({
          provider,
          ...(backendOverride ? { llamaCppBackendOverride: backendOverride } : {}),
        }).catch(() => null);
        setState({
          kind: 'needs-download',
          provider,
          modelId: targetModel,
          sizeBytes,
          ...(engine?.downloadBytes ? { engineBytes: engine.downloadBytes } : {}),
          alternatives: modelsRes.models
            .filter((m) => m.id !== targetModel)
            .slice(0, 3)
            .map((m) => ({ id: m.id, name: m.name })),
        });
      } catch {
        // Service not reachable — stay in whatever we had.
      }
    } finally {
      checkInFlightRef.current = false;
    }
  }, [
    provider,
    defaultModel,
    firstRunInstallError,
    backendOverride,
    settleOnDisk,
    onConfigChanged,
  ]);

  useEffect(() => {
    // Poll only while checking. 'needs-download' and 'failed' are set by the
    // person's actions; re-checking on entry to them could overwrite a
    // fresh failure with a stale 'needs-download' before it is read.
    if (state.kind !== 'checking') return;
    void check();
    const t = setInterval(() => void check(), 3_000);
    return () => clearInterval(t);
  }, [check, state.kind]);

  // While a model downloads, poll only the cheap progress snapshot. When the
  // install leaves the map, one full check decides what comes next.
  const installingProvider = state.kind === 'installing' ? state.provider : null;
  const installingModel = state.kind === 'installing' ? state.modelId : null;
  useEffect(() => {
    if (!installingProvider || !installingModel) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res =
          installingProvider === 'mlx'
            ? await api.listMlxActiveInstalls()
            : await api.listLlamaCppActiveInstalls();
        if (cancelled) return;
        const inFlight =
          res.installs.find((i) => i.catalogId === installingModel) ?? res.installs[0];
        if (!inFlight) {
          if (!installRequestOpenRef.current) setState({ kind: 'checking' });
          return;
        }
        setRate((prev) => recordInstallSample(prev, Date.now(), inFlight.bytesWritten));
        setState((prev) =>
          prev.kind === 'installing'
            ? {
                ...prev,
                progress: {
                  bytesWritten: inFlight.bytesWritten,
                  totalBytes: inFlight.totalBytes,
                  phase: inFlight.phase,
                },
              }
            : prev,
        );
      } catch {
        // Keep the last progress; the next poll tries again.
      }
    };
    void poll();
    const pollTimer = setInterval(() => void poll(), 2_000);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(clock);
    };
  }, [installingProvider, installingModel]);

  /**
   * Drive an install to completion and surface server-side failures as
   * thrown errors. The SSE client returns silently on both `done` and
   * `error`; without this an immediate failure (no venv, no MLX source)
   * would read as success, and the next poll would quietly fall back to
   * 'needs-download' with no word of what went wrong.
   */
  const runInstall = useCallback(
    async (target: OnDeviceProvider, modelId: string, skipSha = false) => {
      let installError: string | null = null;
      let installMismatch: ChecksumMismatch | null = null;
      // The image reader waits until after the first project; pulled here it
      // shared the connection with the model the person tapped for.
      const opts = { skipCompanion: true, ...(skipSha ? { skipSha: true } : {}) };
      const onEvent = (ev: { type: string; error?: string; mismatch?: ChecksumMismatch }) => {
        if (ev.type !== 'error') return;
        installError = ev.error ?? 'The download failed.';
        if (ev.mismatch) installMismatch = ev.mismatch;
      };
      if (target === 'mlx') await api.installMlxModel(modelId, onEvent as never, undefined, opts);
      else await api.installLlamaCppModel(modelId, onEvent as never, undefined, opts);
      if (installError) {
        const err = new Error(installError) as Error & { mismatch?: ChecksumMismatch };
        if (installMismatch) err.mismatch = installMismatch;
        throw err;
      }
    },
    [],
  );

  const clearInstallError = useCallback(async () => {
    const cleared = await api.updateConfig({
      // biome-ignore lint/suspicious/noExplicitAny: client types null-as-delete but the accessor types don't expose it
      firstRunInstallError: null as any,
    });
    onConfigChanged(cleared);
  }, [onConfigChanged]);

  const install = useCallback(
    async (
      target: OnDeviceProvider,
      modelId: string,
      sizeBytes: number | null,
      skipSha = false,
    ) => {
      setRate(emptyInstallRate());
      setState({ kind: 'installing', provider: target, modelId, sizeBytes, progress: null });
      installRequestOpenRef.current = true;
      try {
        await runInstall(target, modelId, skipSha);
      } finally {
        installRequestOpenRef.current = false;
      }
      await check();
    },
    [runInstall, check],
  );

  const start = useCallback(async () => {
    if (state.kind !== 'needs-download') return;
    setBusy(true);
    // The tap is for "my tools": the engine that runs the model comes down
    // beside it, so the first message after "I'm ready" has both.
    void llamaEngineNeed({
      provider: state.provider,
      ...(backendOverride ? { llamaCppBackendOverride: backendOverride } : {}),
    }).then((need) => {
      if (need) void fetchEngine(need.variant);
    });
    try {
      await install(state.provider, state.modelId, state.sizeBytes);
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setBusy(false);
    }
  }, [state, install, backendOverride, fetchEngine]);

  const retry = useCallback(async () => {
    if (state.kind !== 'failed') return;
    setBusy(true);
    try {
      await clearInstallError();
      await install(state.provider, state.modelId, null);
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setBusy(false);
    }
  }, [state, clearInstallError, install]);

  /**
   * Retry bypassing sha256 verification. Only offered after a checksum
   * mismatch: the catalog's pinned hash is out of date against Hugging Face,
   * and the person chooses to take the file as served.
   */
  const downloadAnyway = useCallback(async () => {
    if (state.kind !== 'failed' || !state.mismatch) return;
    setBusy(true);
    try {
      await clearInstallError();
      await install(state.provider, state.modelId, null, true);
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setBusy(false);
    }
  }, [state, clearInstallError, install]);

  /** Use a chat model already on disk instead of downloading one. */
  const pickInstalled = useCallback(
    async (modelId: string) => {
      if (!isOnDevice(provider)) return;
      setBusy(true);
      try {
        const next = await api.updateConfig({
          defaultModel: { ...defaultModel, [provider]: modelId },
        });
        onConfigChanged(next);
        installedNotifiedRef.current = false;
        await settleOnDisk(provider, modelId);
      } catch (err) {
        setState(failedFromCaught(err, provider, modelId));
      } finally {
        setBusy(false);
      }
    },
    [provider, defaultModel, onConfigChanged, settleOnDisk],
  );

  /**
   * MLX's escape hatch: when the Python venv, mlx-lm, or the MLX download
   * fails, switch to llama.cpp and fetch the equivalent GGUF — a working path
   * on every bundled platform, Apple Silicon included (Metal).
   */
  const switchToLlamaCpp = useCallback(async () => {
    if (state.kind !== 'failed') return;
    setBusy(true);
    try {
      const llamaTier = state.modelId.replace(/-mlx$/, '');
      const next = await api.updateConfig({
        provider: 'llama-cpp',
        defaultModel: { ...defaultModel, 'llama-cpp': llamaTier },
        // biome-ignore lint/suspicious/noExplicitAny: null-as-delete
        firstRunInstallError: null as any,
      });
      onConfigChanged(next);
      await install('llama-cpp', llamaTier, null);
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setBusy(false);
    }
  }, [state, defaultModel, onConfigChanged, install]);

  /**
   * The cloud way out of a broken on-device install. Copilot's runtime is an
   * opt-in download, so switching to it is only honest once it is installed;
   * otherwise send the person to the page that installs it.
   */
  const switchToCopilot = useCallback(async () => {
    if (copilotAvailability?.available === false) {
      window.dispatchEvent(
        new CustomEvent('gezel:navigate', { detail: { view: 'settings', section: 'copilot' } }),
      );
      return;
    }
    const next = await api.updateConfig({ provider: 'copilot' });
    onConfigChanged(next);
    window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: next }));
  }, [onConfigChanged, copilotAvailability]);

  const retryEngine = useCallback(() => {
    setEngineError(null);
    setState({ kind: 'checking' });
  }, []);

  const shown: FirstRunModelState =
    state.kind === 'engine'
      ? { ...state, progress: engineProgress, ...(engineError ? { error: engineError } : {}) }
      : state;

  return {
    state: shown,
    rate,
    now,
    busy,
    copilotAvailable: copilotAvailability ? copilotAvailability.available : null,
    start,
    retry,
    retryEngine,
    downloadAnyway,
    pickInstalled,
    switchToLlamaCpp,
    switchToCopilot,
  };
}
