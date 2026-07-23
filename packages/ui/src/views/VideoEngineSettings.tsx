import type { VideoEngineStatusResponse } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { VideoGeneratorGezelHint } from '../components/VideoGeneratorGezelHint.js';
import { VideoModelManager } from '../components/VideoModelManager.js';

interface Props {
  onModelsChanged?: () => void;
}

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
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProbe({ kind: 'probing' });
    try {
      const [statusRes, cfg] = await Promise.all([api.getVideoEngineStatus(), api.getConfig()]);
      setConfig(cfg);
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

      {accelerator === 'cpu' && (
        <p className="error">
          No GPU detected — video will be generated on the <strong>CPU</strong>, which is extremely
          slow (minutes to hours per clip). A CUDA (NVIDIA) GPU or Apple Silicon is strongly
          recommended.
        </p>
      )}
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
      return <span className="home-status-pill">Probing…</span>;
    case 'ready':
      return <span className="home-status-pill home-status-ok">Ready</span>;
    case 'no-models':
      return <span className="home-status-pill home-status-warn">No local models</span>;
    case 'engine-not-configured':
      return <span className="home-status-pill home-status-warn">Engine not configured</span>;
    case 'engine-unreachable':
      return <span className="home-status-pill home-status-fail">Engine unreachable</span>;
    case 'probe-failed':
      return <span className="home-status-pill home-status-fail">Service unreachable</span>;
  }
}
