import type { VideoEngineStatusResponse } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { VideoGeneratorGezelHint } from '../components/VideoGeneratorGezelHint.js';
import { VideoModelManager } from '../components/VideoModelManager.js';

interface Props {
  onModelsChanged?: () => void;
}

type MemoryProfile = Awaited<ReturnType<typeof api.getMemoryProfile>>;

type ProbeState =
  | { kind: 'idle' | 'probing' }
  | { kind: 'ready'; status: VideoEngineStatusResponse }
  | { kind: 'no-models'; status: VideoEngineStatusResponse }
  | { kind: 'engine-not-configured'; status: VideoEngineStatusResponse }
  | { kind: 'engine-unreachable'; status: VideoEngineStatusResponse }
  | { kind: 'probe-failed'; error: string };

/**
 * Settings subsection for video generation. Drives the bundled
 * diffusers/PyTorch engine (LTX). Unlike the image settings there's no
 * cloud option yet, but there IS an accelerator readout — generation on
 * the CPU fallback is so slow it warrants a prominent warning.
 */
export function VideoEngineSettings({ onModelsChanged }: Props) {
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [refreshTick, setRefreshTick] = useState(0);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [memory, setMemory] = useState<MemoryProfile | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProbe({ kind: 'probing' });
    try {
      const [statusRes, cfg, mem] = await Promise.all([
        api.getVideoEngineStatus(),
        api.getConfig(),
        // Only feeds the CPU-fallback wording — a failure here must not turn
        // the whole panel into "service unreachable".
        api
          .getMemoryProfile()
          .catch(() => null),
      ]);
      setConfig(cfg);
      setMemory(mem);
      if (statusRes.engine.status === 'not-configured') {
        setProbe({ kind: 'engine-not-configured', status: statusRes });
      } else if (statusRes.engine.status === 'unreachable') {
        setProbe({ kind: 'engine-unreachable', status: statusRes });
      } else if (statusRes.modelCount === 0) {
        setProbe({ kind: 'no-models', status: statusRes });
      } else {
        setProbe({ kind: 'ready', status: statusRes });
      }
    } catch (err) {
      setProbe({ kind: 'probe-failed', error: (err as Error).message });
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a bump counter — incrementing it is the re-probe trigger.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshTick]);

  const engineDown = probe.kind === 'probe-failed';
  const accelerator = 'status' in probe ? probe.status.engine.accelerator : undefined;

  const onConfirmationChange = useCallback(async (mode: 'ask' | 'always-allow') => {
    setStatus('saving…');
    try {
      const updated = await api.updateConfig({ videoGenerationConfirmation: mode });
      setConfig(updated);
      setStatus(null);
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const onActiveModelChange = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const updated = await api.updateConfig({ defaultVideoModel: id });
      setConfig(updated);
      setStatus(null);
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const confirmationMode = normalizeConfirmation(config?.videoGenerationConfirmation);

  return (
    <div className="provider-card">
      <div className="settings-card-header">
        <h3>Video generation</h3>
        <StatusPill probe={probe} />
      </div>

      <p className="muted small">
        Generate short video clips locally on your own machine. The first-time setup takes a few
        minutes; after that, each clip can still take anywhere from several minutes to a few hours,
        depending on the model and your hardware.
      </p>

      <VideoGeneratorGezelHint />

      {accelerator === 'cpu' && <CpuFallbackNotice memory={memory} />}
      {probe.kind === 'probe-failed' && (
        <p className="error">Couldn't reach the Gezel service. Details: {probe.error}</p>
      )}

      <VideoModelManager
        {...(engineDown ? { disabledReason: 'Video engine is not reachable.' } : {})}
        {...(config?.defaultVideoModel
          ? { configuredDefaultModelId: config.defaultVideoModel }
          : {})}
        onSetActiveModel={onActiveModelChange}
        onModelsChanged={() => {
          setRefreshTick((n) => n + 1);
          onModelsChanged?.();
        }}
      />

      <fieldset
        className="provider-row"
        style={{ flexDirection: 'column', alignItems: 'flex-start' }}
      >
        <legend>Confirmation</legend>
        <p className="muted small">
          Video generation is long-running and monopolizes the GPU, pausing the chat model. Choose
          whether the agent should ask before each generation.
        </p>
        <div className="gz-tray" role="radiogroup" aria-label="Video generation confirmation">
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={confirmationMode === 'ask'}
            className={`gz-key${confirmationMode === 'ask' ? ' gz-key-active' : ''}`}
            onClick={() => void onConfirmationChange('ask')}
          >
            Ask before each generation (default)
          </button>
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={confirmationMode === 'always-allow'}
            className={`gz-key${confirmationMode === 'always-allow' ? ' gz-key-active' : ''}`}
            onClick={() => void onConfirmationChange('always-allow')}
          >
            Always allow without asking
          </button>
        </div>
      </fieldset>

      {status && <p className="muted small">{status}</p>}
    </div>
  );
}

const VENDOR_LABEL: Record<'amd' | 'nvidia' | 'intel', string> = {
  amd: 'AMD',
  nvidia: 'Nvidia',
  intel: 'Intel',
};

export type CpuFallbackCause =
  /** The machine has no usable GPU at all. */
  | { kind: 'no-gpu' }
  /** A GPU is present, but PyTorch has no backend for it on this platform. */
  | { kind: 'unsupported-gpu'; vendorLabel: string | null }
  /** An NVIDIA card is present but the engine could not resolve CUDA. */
  | { kind: 'cuda-unavailable' };

/**
 * Why video generation resolved to the CPU. The distinction is the whole
 * point of this function: on a Radeon or Arc card gezel *can* see the GPU
 * — chat runs on it, and the engine pill in the header says so — because
 * llama.cpp has a vendor-agnostic Vulkan backend. The video engine is
 * PyTorch/diffusers, which ships CUDA, MPS and CPU backends and nothing
 * else. Reporting that as "no GPU detected" contradicts the rest of the
 * app and reads as a gezel bug rather than an upstream limitation.
 *
 * `memory` is null when the profile probe failed; unknown hardware must
 * not assert a cause, so it falls back to the vaguer no-gpu copy.
 */
export function cpuFallbackCause(memory: MemoryProfile | null): CpuFallbackCause {
  const hasGpu = memory?.source === 'gpu-nvidia' || memory?.source === 'gpu-vulkan';
  if (!hasGpu) return { kind: 'no-gpu' };
  const vendor = memory?.gpuVendor;
  // nvidia + CPU fallback means both probes disagreed about the same card,
  // so the driver is the suspect — never tell an NVIDIA owner their GPU is
  // unsupported.
  if (vendor === 'nvidia') return { kind: 'cuda-unavailable' };
  return { kind: 'unsupported-gpu', vendorLabel: vendor ? VENDOR_LABEL[vendor] : null };
}

const SLOWNESS = 'which is extremely slow (minutes to hours per clip)';

function CpuFallbackNotice({ memory }: { memory: MemoryProfile | null }) {
  const cause = cpuFallbackCause(memory);

  if (cause.kind === 'unsupported-gpu') {
    const who = cause.vendorLabel ? `Your ${cause.vendorLabel} GPU` : "This machine's GPU";
    return (
      <p className="error">
        {who} can't be used for video generation — the video engine is built on PyTorch, which only
        accelerates on NVIDIA (CUDA) cards and Apple Silicon. Chat still runs on your GPU; video
        will be generated on the <strong>CPU</strong>, {SLOWNESS}.
      </p>
    );
  }

  if (cause.kind === 'cuda-unavailable') {
    return (
      <p className="error">
        An NVIDIA GPU is present, but the video engine couldn't reach CUDA — check that the NVIDIA
        driver is installed and that <code>nvidia-smi</code> runs. Until then video will be
        generated on the <strong>CPU</strong>, {SLOWNESS}.
      </p>
    );
  }

  return (
    <p className="error">
      No GPU detected — video will be generated on the <strong>CPU</strong>, {SLOWNESS}. A CUDA
      (NVIDIA) GPU or Apple Silicon is strongly recommended.
    </p>
  );
}

function normalizeConfirmation(
  raw: ConfigResponse['videoGenerationConfirmation'] | undefined,
): 'ask' | 'always-allow' {
  if (raw === 'always-allow') return 'always-allow';
  return 'ask';
}

function StatusPill({ probe }: { probe: ProbeState }) {
  switch (probe.kind) {
    case 'idle':
    case 'probing':
      return <span className="gz-status-pill">Probing…</span>;
    case 'ready':
      return <span className="gz-status-pill gz-status-pill--ok">Ready</span>;
    case 'no-models':
      return <span className="gz-status-pill gz-status-pill--warn">No local models</span>;
    case 'engine-not-configured':
      return <span className="gz-status-pill gz-status-pill--warn">Engine not configured</span>;
    case 'engine-unreachable':
      return <span className="gz-status-pill gz-status-pill--fail">Engine unreachable</span>;
    case 'probe-failed':
      return <span className="gz-status-pill gz-status-pill--fail">Service unreachable</span>;
  }
}
