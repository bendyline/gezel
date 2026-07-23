/**
 * Banner shown on the Home view during the on-device first-run
 * install flow (see `bootstrapOnDeviceFirstRun` service-side).
 *
 * Four states:
 *   - **Needs-download**: Home's first boot after fresh install. Service
 *     pinned `config.provider` to `llama-cpp` or `mlx` + a Gemma 4 tier,
 *     but no install was fired. Banner shows a "Download recommended
 *     model (<name>, <size>)" button that the user must click before
 *     anything is downloaded.
 *   - **Installing**: User clicked the button (or another tab/process
 *     started the install). Banner tells the user what's happening +
 *     polls every 3s.
 *   - **Failed**: An install attempt threw. `firstRunInstallError`
 *     carries the message; offer Retry + a provider-aware escape
 *     hatch ("Switch to llama" when MLX failed; "Use Copilot
 *     instead" otherwise).
 *   - **Done** (hidden): model is installed. Return null — don't
 *     clutter the Home view once chat is usable.
 *
 * The component is generic over the two on-device providers. The only
 * per-provider wiring is "which install + list endpoints to hit" —
 * everything else (polling cadence, state machine, error copy) is
 * identical.
 */

import type { ConfigResponse, LocalActiveInstall } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

interface Props {
  config: ConfigResponse;
  onConfigChanged: (next: ConfigResponse) => void;
  /**
   * Fired exactly once per banner mount when the installed-models probe
   * first sees the recommended model on disk. The parent uses this to
   * re-run its provider probe so the Home view can transition out of
   * the setup section and into the Meester chat without the user
   * having to click anything.
   */
  onModelInstalled?: () => void;
}

interface MemoryProfile {
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'system-ram-fallback';
  usableBytes: number;
  gpuVramBytes: number | null;
}

interface InstallProgress {
  bytesWritten: number;
  totalBytes: number;
  phase: LocalActiveInstall['phase'];
}

type BannerState =
  | { kind: 'hidden' }
  | {
      kind: 'needs-download';
      provider: 'llama-cpp' | 'mlx';
      modelId: string;
      sizeBytes: number | null;
      memory: MemoryProfile | null;
    }
  | {
      kind: 'installing';
      provider: 'llama-cpp' | 'mlx';
      modelId: string;
      sizeBytes: number | null;
      progress: InstallProgress | null;
    }
  | {
      kind: 'failed';
      provider: 'llama-cpp' | 'mlx';
      modelId: string;
      error: string;
      /**
       * Present when the failure was a sha256 mismatch against the
       * catalog. Surfacing this lets the failed banner offer a
       * "Download anyway" button that retries with `{skipSha: true}`
       * — useful when Hugging Face has updated the upstream file but
       * the catalog hasn't caught up yet.
       */
      mismatch?: { file: string; expected: string; actual: string };
    };

/**
 * Convert a caught install error into a `'failed'` BannerState,
 * preserving structured `mismatch` info when `runInstall` enriched the
 * thrown Error with it. Centralized so every catch site presents the
 * same shape — the failed-banner UI then keys off `state.mismatch` to
 * show the "Download anyway" affordance.
 */
function failedFromCaught(
  err: unknown,
  provider: 'llama-cpp' | 'mlx',
  modelId: string,
): BannerState {
  const msg = err instanceof Error ? err.message : String(err);
  const mismatch =
    err instanceof Error && 'mismatch' in err
      ? (err as Error & { mismatch?: { file: string; expected: string; actual: string } }).mismatch
      : undefined;
  return mismatch
    ? { kind: 'failed', provider, modelId, error: msg, mismatch }
    : { kind: 'failed', provider, modelId, error: msg };
}

export function FirstRunInstallBanner({ config, onConfigChanged, onModelInstalled }: Props) {
  const [state, setState] = useState<BannerState>({ kind: 'hidden' });
  const [retryBusy, setRetryBusy] = useState(false);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const installedNotifiedRef = useRef(false);

  const check = useCallback(async () => {
    // Only applies to the two on-device first-run flows.
    if (config.provider !== 'llama-cpp' && config.provider !== 'mlx') {
      setState({ kind: 'hidden' });
      return;
    }
    const provider = config.provider;
    const targetModel = config.defaultModel?.[provider];
    if (!targetModel) {
      setState({ kind: 'hidden' });
      return;
    }
    // Fast path: error stamped → show failed, skip the installed-models poll.
    if (config.firstRunInstallError) {
      setState({
        kind: 'failed',
        provider,
        modelId: targetModel,
        error: config.firstRunInstallError,
      });
      return;
    }
    try {
      // Four signals: installed-models list, active-installs map, the
      // catalog item (for the size label on the download CTA), and the
      // memory profile (for the tier-aware explainer copy). Run them
      // all in parallel — all localhost, ordering doesn't matter.
      const [modelsRes, activeRes, catalog, memory] = await Promise.all([
        provider === 'mlx' ? api.listMlxModels() : api.listLlamaCppModels(),
        provider === 'mlx' ? api.listMlxActiveInstalls() : api.listLlamaCppActiveInstalls(),
        api.getCatalogItem('chat-model', targetModel).catch(() => null),
        api.getMemoryProfile().catch(() => null),
      ]);
      const installed = modelsRes.models.some((m) => m.id === targetModel);
      if (installed) {
        setState({ kind: 'hidden' });
        if (!installedNotifiedRef.current) {
          installedNotifiedRef.current = true;
          onModelInstalled?.();
        }
        return;
      }
      const sizeBytes = readSizeFromCatalog(catalog, provider);
      const active = activeRes.installs.find((i) => i.catalogId === targetModel);
      if (active) {
        // Genuine in-flight install (user clicked the button, or
        // another tab kicked it) — show the spinner banner.
        setState({
          kind: 'installing',
          provider,
          modelId: targetModel,
          sizeBytes,
          progress: {
            bytesWritten: active.bytesWritten,
            totalBytes: active.totalBytes,
            phase: active.phase,
          },
        });
        return;
      }
      // Pinned default but nothing installed and nothing in flight —
      // either fresh first-run or an abandoned mid-download. Either
      // way we wait for an explicit user click on the download CTA.
      setState({
        kind: 'needs-download',
        provider,
        modelId: targetModel,
        sizeBytes,
        memory,
      });
    } catch {
      // Service not reachable — stay in whatever we had.
    }
  }, [config.provider, config.defaultModel, config.firstRunInstallError, onModelInstalled]);

  useEffect(() => {
    // Only auto-poll in states where polling is the right signal —
    // 'hidden' means we haven't checked yet, 'installing' means a job
    // is in flight that we want to track. `'needs-download'` and
    // `'failed'` are user-action-set states; running check() on entry
    // to those would race against the action that set them and could
    // silently revert (e.g., overwriting a freshly set 'failed' state
    // with the polled-but-stale 'needs-download' before the user can
    // read the error).
    if (state.kind !== 'installing' && state.kind !== 'hidden') return;
    void check();
    const t = setInterval(() => void check(), 3_000);
    return () => clearInterval(t);
  }, [check, state.kind]);

  /**
   * Drive an install API call to completion and surface server-side
   * failures as thrown errors. The SSE client returns silently on both
   * `done` and `error` terminal events — without this, an immediate
   * server-side failure (no venv, no MLX source in catalog, etc.) would
   * leave the UI thinking the install succeeded; the next poll would
   * then see no active install and silently revert the banner to
   * "needs-download", giving the user no way to know what went wrong.
   * We don't need the per-event progress here (the polling loop covers
   * that), only the terminal error message.
   */
  const runInstall = useCallback(
    async (provider: 'mlx' | 'llama-cpp', modelId: string, skipSha = false) => {
      let installError: string | null = null;
      let installMismatch: { file: string; expected: string; actual: string } | null = null;
      const opts = skipSha ? { skipSha: true } : undefined;
      if (provider === 'mlx') {
        await api.installMlxModel(
          modelId,
          (ev) => {
            if (ev.type === 'error') {
              installError = ev.error;
              if (ev.mismatch) installMismatch = ev.mismatch;
            }
          },
          undefined,
          opts,
        );
      } else {
        await api.installLlamaCppModel(
          modelId,
          (ev) => {
            if (ev.type === 'error') {
              installError = ev.error;
              if (ev.mismatch) installMismatch = ev.mismatch;
            }
          },
          undefined,
          opts,
        );
      }
      if (installError) {
        const err = new Error(installError) as Error & {
          mismatch?: { file: string; expected: string; actual: string };
        };
        if (installMismatch) err.mismatch = installMismatch;
        throw err;
      }
    },
    [],
  );

  const startDownload = useCallback(async () => {
    if (state.kind !== 'needs-download') return;
    setDownloadBusy(true);
    try {
      // Optimistic flip — the next poll will confirm the install is
      // actually registered with the active-installs map.
      setState({
        kind: 'installing',
        provider: state.provider,
        modelId: state.modelId,
        sizeBytes: state.sizeBytes,
        progress: null,
      });
      await runInstall(state.provider, state.modelId);
      await check();
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setDownloadBusy(false);
    }
  }, [state, check, runInstall]);

  const retry = useCallback(async () => {
    if (state.kind !== 'failed') return;
    setRetryBusy(true);
    try {
      // Two steps:
      //   1. Clear the error flag so the banner flips back to
      //      `installing` view as soon as the install restarts.
      //   2. Kick the install via the provider-specific installer SSE
      //      route. That runs in-process regardless of bootstrap state
      //      and is what the user can also hit from Settings.
      const cleared = await api.updateConfig({
        // biome-ignore lint/suspicious/noExplicitAny: client types null-as-delete but the accessor types don't expose it
        firstRunInstallError: null as any,
      });
      onConfigChanged(cleared);
      await runInstall(state.provider, state.modelId);
      await check();
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setRetryBusy(false);
    }
  }, [state, onConfigChanged, check, runInstall]);

  /**
   * "Download anyway" — retry the install bypassing sha256 verification.
   * Only meaningful when the previous failure was a sha mismatch (i.e.
   * `state.mismatch` is set). The catalog's pinned hash is treated as
   * out-of-date relative to Hugging Face; we accept whatever the file
   * server returns and let the user proceed at their own risk.
   */
  const downloadAnyway = useCallback(async () => {
    if (state.kind !== 'failed' || !state.mismatch) return;
    setRetryBusy(true);
    try {
      const cleared = await api.updateConfig({
        // biome-ignore lint/suspicious/noExplicitAny: null-as-delete
        firstRunInstallError: null as any,
      });
      onConfigChanged(cleared);
      setState({
        kind: 'installing',
        provider: state.provider,
        modelId: state.modelId,
        sizeBytes: null,
        progress: null,
      });
      await runInstall(state.provider, state.modelId, true);
      await check();
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setRetryBusy(false);
    }
  }, [state, onConfigChanged, check, runInstall]);

  /**
   * Cloud fallback — only valid when the error left the user with no
   * working on-device setup. Swaps provider to Copilot; the user can
   * still manually retry the on-device install later from Settings.
   */
  const switchToCopilot = useCallback(async () => {
    const next = await api.updateConfig({ provider: 'copilot' });
    onConfigChanged(next);
    setState({ kind: 'hidden' });
  }, [onConfigChanged]);

  /**
   * MLX-specific escape hatch. If MLX first-run failed (Python venv
   * couldn't be provisioned, mlx-lm install errored, MLX model
   * download broke), we flip the user to llama-cpp and kick off the
   * equivalent GGUF install. That's a working path on every bundled
   * platform including Apple Silicon (Metal variant).
   */
  const switchToLlamaCpp = useCallback(async () => {
    if (state.kind !== 'failed') return;
    setFallbackBusy(true);
    try {
      // Map -mlx tier name back to the llama-cpp catalog id.
      const llamaTier = state.modelId.replace(/-mlx$/, '');
      const cleared = await api.updateConfig({
        provider: 'llama-cpp',
        defaultModel: { ...config.defaultModel, 'llama-cpp': llamaTier },
        // biome-ignore lint/suspicious/noExplicitAny: null-as-delete
        firstRunInstallError: null as any,
      });
      onConfigChanged(cleared);
      await runInstall('llama-cpp', llamaTier);
      await check();
    } catch (err) {
      setState(failedFromCaught(err, state.provider, state.modelId));
    } finally {
      setFallbackBusy(false);
    }
  }, [state, config.defaultModel, onConfigChanged, check, runInstall]);

  if (state.kind === 'hidden') return null;

  if (state.kind === 'needs-download') {
    const name = modelDisplay(state.modelId);
    const size = state.sizeBytes ? formatGb(state.sizeBytes) : null;
    const label = size
      ? `Download recommended model (${name}, ${size})`
      : `Download recommended model (${name})`;
    return (
      <output className="first-run-banner first-run-banner-installing">
        <div className="first-run-banner-head">
          <strong>Set up your first on-device model</strong>
        </div>
        <p className="first-run-banner-body">
          {describeDeviceCapacity(state.memory)} We've picked one we think will work well on this
          device — click below to download it. Usually {formatDownloadTime(state.sizeBytes)} on fast
          Internet, and you only have to do this once.
        </p>
        <div className="first-run-banner-actions">
          <button
            type="button"
            className="first-run-banner-btn first-run-banner-btn-primary"
            onClick={() => void startDownload()}
            disabled={downloadBusy}
          >
            {downloadBusy ? 'Starting…' : label}
          </button>
        </div>
      </output>
    );
  }

  if (state.kind === 'installing') {
    return (
      <output className="first-run-banner first-run-banner-installing">
        <div className="first-run-banner-head">
          <span className="first-run-banner-spinner" aria-hidden />
          <strong>Downloading {modelDisplay(state.modelId)} for first-time setup</strong>
        </div>
        <p className="first-run-banner-body">
          Gezel is downloading a local AI model so your conversations run on this device. Usually{' '}
          {formatDownloadTime(state.sizeBytes)} on fast Internet. You can start working with gezels
          as soon as this finishes.
        </p>
        <FirstRunProgressBar progress={state.progress} />
      </output>
    );
  }

  // state.kind === 'failed'
  const isMlx = state.provider === 'mlx';
  const isMismatch = state.mismatch != null;
  const headline = isMismatch
    ? `${modelDisplay(state.modelId)} is newer on Hugging Face than the version Gezel knows about`
    : `Couldn't download ${modelDisplay(state.modelId)}`;
  const body = isMismatch ? (
    <>
      <p className="first-run-banner-body">
        The file <code>{state.mismatch?.file}</code> on Hugging Face has changed since this version
        of Gezel was published, so its checksum doesn't match what we expected. The new file is
        probably fine — Hugging Face routinely re-publishes models with small upstream fixes — but
        we can't guarantee it.
      </p>
      <p className="first-run-banner-body">
        You can download it anyway and start using it now, or wait for a Gezel update with a
        refreshed catalog.
      </p>
    </>
  ) : (
    <p className="first-run-banner-body">{state.error}</p>
  );
  return (
    <output className="first-run-banner first-run-banner-failed">
      <div className="first-run-banner-head">
        <strong>{headline}</strong>
      </div>
      {body}
      <div className="first-run-banner-actions">
        {isMismatch && (
          <button
            type="button"
            className="first-run-banner-btn first-run-banner-btn-primary"
            onClick={() => void downloadAnyway()}
            disabled={retryBusy || fallbackBusy}
            title="Download the current file from Hugging Face without verifying it against the catalog's pinned checksum."
          >
            {retryBusy ? 'Downloading…' : 'Download anyway'}
          </button>
        )}
        <button
          type="button"
          className={
            isMismatch
              ? 'first-run-banner-btn'
              : 'first-run-banner-btn first-run-banner-btn-primary'
          }
          onClick={() => void retry()}
          disabled={retryBusy || fallbackBusy}
        >
          {retryBusy && !isMismatch ? 'Retrying…' : 'Retry download'}
        </button>
        {isMlx && (
          <button
            type="button"
            className="first-run-banner-btn"
            onClick={() => void switchToLlamaCpp()}
            disabled={retryBusy || fallbackBusy}
            title="Use the llama engine instead. Works without Python; slightly slower than MLX on Apple Silicon."
          >
            {fallbackBusy ? 'Switching…' : 'Switch to llama'}
          </button>
        )}
        <button
          type="button"
          className="first-run-banner-btn"
          onClick={() => void switchToCopilot()}
          disabled={retryBusy || fallbackBusy}
        >
          Use GitHub Copilot instead
        </button>
      </div>
    </output>
  );
}

function FirstRunProgressBar({ progress }: { progress: InstallProgress | null }) {
  const known = progress != null && progress.totalBytes > 0 && progress.phase === 'downloading';
  const pct = known
    ? Math.min(100, Math.round((progress.bytesWritten / progress.totalBytes) * 100))
    : 0;
  const label = !progress
    ? 'Starting…'
    : progress.phase === 'verifying'
      ? 'Checking download…'
      : progress.phase === 'extracting-metadata'
        ? 'Reading model info…'
        : known
          ? `${formatBytes(progress.bytesWritten)} of ${formatBytes(progress.totalBytes)} · ${pct}%`
          : progress.bytesWritten > 0
            ? `${formatBytes(progress.bytesWritten)} downloaded`
            : 'Starting…';
  return (
    <div className="first-run-banner-progress">
      <div
        className={
          known ? 'first-run-banner-bar' : 'first-run-banner-bar first-run-banner-bar-indeterminate'
        }
      >
        <div
          className="first-run-banner-bar-fill"
          style={known ? { width: `${pct}%` } : undefined}
        />
      </div>
      <span className="first-run-banner-progress-label">{label}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Tier-aware lead-in for the first-run download banner. Tier label
 * matches the badge on the on-device tab (`DeviceSummary.tsx`) — same
 * 25 / 13 / 5 GB usable thresholds (large / medium / small; below 5 GB
 * is "tiny"). The "comfortably" qualifier is reserved for hardware that
 * can actually keep up: Apple Silicon unified memory or a discrete GPU.
 * CPU-only devices skip the qualifier — they can run the model, but
 * "comfortably" would oversell the experience.
 */
const LARGE_BUDGET_BYTES = 25_000_000_000;
const MEDIUM_BUDGET_BYTES = 13_000_000_000;
const SMALL_BUDGET_BYTES = 5_000_000_000;

function describeDeviceCapacity(memory: MemoryProfile | null): string {
  if (!memory) return 'You can run AI models on this device.';
  const tier =
    memory.usableBytes >= LARGE_BUDGET_BYTES
      ? 'large'
      : memory.usableBytes >= MEDIUM_BUDGET_BYTES
        ? 'medium-size'
        : memory.usableBytes >= SMALL_BUDGET_BYTES
          ? 'small-size'
          : 'tiny';
  const accelerated = memory.source === 'darwin-unified' || memory.gpuVramBytes != null;
  const qualifier = accelerated ? ' comfortably' : '';
  return `You can run ${tier} AI models${qualifier} on this device.`;
}

/**
 * Rough download-time estimate, ceiled to the next 5-minute mark. Rate
 * is ~1 GB/min on fast Internet (assumes ~135 Mbps effective throughput);
 * we round up because a too-low estimate is more disappointing than a
 * too-high one. Returns the existing 2-5 min copy when size is unknown.
 */
function formatDownloadTime(sizeBytes: number | null): string {
  if (!sizeBytes) return '2–5 minutes';
  const gb = sizeBytes / 1024 ** 3;
  const minutes = Math.max(5, Math.ceil(gb / 5) * 5);
  return `~${minutes} minutes`;
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `~${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `~${Math.round(mb)} MB`;
}

function readSizeFromCatalog(
  detail: { manifest: unknown } | null,
  provider: 'mlx' | 'llama-cpp',
): number | null {
  if (!detail) return null;
  const m = detail.manifest as
    | {
        kind?: string;
        approxSizeBytes?: number;
        mlx?: { approxSizeBytes?: number };
        llamaCpp?: { approxSizeBytes?: number };
      }
    | undefined;
  if (!m || m.kind !== 'chat-model') return null;
  const perSource = provider === 'mlx' ? m.mlx?.approxSizeBytes : m.llamaCpp?.approxSizeBytes;
  return perSource ?? m.approxSizeBytes ?? null;
}

function modelDisplay(id: string): string {
  // Friendly labels for the recommended models the first-run picker can
  // pin (any model carrying a `recoScore`). Pre-suffix entries (e.g.
  // `gemma4-e2b-mlx`) no longer come out of `resolveFirstRunTarget`, but a
  // user upgrading from an older install may still have the suffix stamped
  // in `config.defaultModel` — keep the alias so labels stay correct until
  // the next install rewrites the pin. Unknown ids fall back to the raw id.
  switch (id) {
    case 'gemma4-e2b-q8':
    case 'gemma4-e2b':
    case 'gemma4-e2b-mlx':
      return 'Gemma 4 (E2B)';
    case 'gemma4-e4b-q8':
    case 'gemma4-e4b':
    case 'gemma4-e4b-mlx':
      return 'Gemma 4 (E4B)';
    case 'gemma4-12b-q4':
    case 'gemma4-12b-q8':
      return 'Gemma 4 (12B)';
    case 'gemma4-26b-q4':
    case 'gemma4-26b':
    case 'gemma4-26b-mlx':
      return 'Gemma 4 (26B-A4B MoE)';
    case 'gemma4-31b-q4':
      return 'Gemma 4 (31B)';
    case 'qwen3.6-27b-q4':
    case 'qwen3.6-27b-q8':
      return 'Qwen 3.6 (27B)';
    case 'qwen3.6-35b-a3b-q4':
    case 'qwen3.6-35b-a3b-q8':
      return 'Qwen 3.6 (35B-A3B MoE)';
    default:
      return id;
  }
}
