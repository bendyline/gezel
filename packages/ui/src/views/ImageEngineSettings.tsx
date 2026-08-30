import type { ImageEngineStatusResponse } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ImageGeneratorGezelHint } from '../components/ImageGeneratorGezelHint.js';
import { ImageModelManager } from '../components/ImageModelManager.js';

interface Props {
  onModelsChanged?: () => void;
}

type ProbeState =
  | { kind: 'idle' | 'probing' }
  | { kind: 'ready'; status: ImageEngineStatusResponse }
  | { kind: 'no-models'; status: ImageEngineStatusResponse }
  | { kind: 'engine-not-configured'; status: ImageEngineStatusResponse }
  | { kind: 'engine-unreachable'; status: ImageEngineStatusResponse }
  | { kind: 'probe-failed'; error: string };

type ProviderChoice = NonNullable<ConfigResponse['imageProvider']>;

/**
 * Settings subsection for image generation. Lets the user pick between
 * the local stable-diffusion.cpp engine and cloud providers (Google
 * Nano Banana 2 / OpenAI GPT Image 2), enter the appropriate API key,
 * and decide whether each cloud generation should prompt for
 * confirmation.
 */
export function ImageEngineSettings({ onModelsChanged }: Props) {
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [refreshTick, setRefreshTick] = useState(0);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProbe({ kind: 'probing' });
    try {
      const [statusRes, cfg] = await Promise.all([api.getImageEngineStatus(), api.getConfig()]);
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

  const engineDown =
    probe.kind === 'engine-not-configured' ||
    probe.kind === 'engine-unreachable' ||
    probe.kind === 'probe-failed';

  const provider: ProviderChoice = config?.imageProvider ?? 'sd-cpp';
  const engineKind: 'local' | 'cloud' =
    'status' in probe ? (probe.status.engine.kind ?? 'local') : 'local';
  const isCloud = provider === 'google-ai' || provider === 'openai';

  const onProviderChange = useCallback(async (next: ProviderChoice) => {
    setStatus('switching engine…');
    try {
      const updated = await api.updateConfig({ imageProvider: next });
      setConfig(updated);
      setKeyDraft('');
      setStatus(null);
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setStatus(`switch failed: ${(err as Error).message}`);
    }
  }, []);

  const onSaveKey = useCallback(async () => {
    if (!keyDraft.trim()) return;
    setStatus('saving key…');
    try {
      const patch =
        provider === 'google-ai'
          ? { googleAiApiKey: keyDraft.trim() }
          : provider === 'openai'
            ? { openaiApiKey: keyDraft.trim() }
            : {};
      const updated = await api.updateConfig(patch);
      setConfig(updated);
      setKeyDraft('');
      setStatus('key saved');
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, [keyDraft, provider]);

  const onClearKey = useCallback(async () => {
    setStatus('clearing key…');
    try {
      const patch =
        provider === 'google-ai'
          ? { googleAiApiKey: '' }
          : provider === 'openai'
            ? { openaiApiKey: '' }
            : {};
      const updated = await api.updateConfig(patch);
      setConfig(updated);
      setKeyDraft('');
      setStatus('key cleared');
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setStatus(`clear failed: ${(err as Error).message}`);
    }
  }, [provider]);

  const onActiveModelChange = useCallback(
    async (id: string) => {
      setStatus('saving…');
      try {
        // `defaultImageModel` is keyed by provider, so patch the sd-cpp slot
        // and carry the cloud entries through — a bare `{ 'sd-cpp': id }`
        // would drop whichever cloud default the user had set.
        const updated = await api.updateConfig({
          defaultImageModel: { ...config?.defaultImageModel, 'sd-cpp': id },
        });
        setConfig(updated);
        setStatus(null);
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.defaultImageModel],
  );

  const onConfirmationChange = useCallback(async (mode: 'ask' | 'always-allow') => {
    setStatus('saving…');
    try {
      const updated = await api.updateConfig({ imageGenerationConfirmation: mode });
      setConfig(updated);
      setStatus(null);
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const confirmationMode = normalizeConfirmation(config?.imageGenerationConfirmation);

  return (
    <div className="provider-card">
      <div className="settings-card-header">
        <h3>Image generation</h3>
        <StatusPill probe={probe} />
      </div>

      <ImageGeneratorGezelHint />

      <label className="provider-row">
        <span>Engine</span>
        <select
          value={provider}
          onChange={(e) => void onProviderChange(e.target.value as ProviderChoice)}
        >
          <option value="sd-cpp">Local (Stable Diffusion)</option>
          <option value="google-ai">Google Nano Banana 2 (cloud)</option>
          <option value="openai">OpenAI GPT Image 2 (cloud)</option>
        </select>
      </label>

      {provider === 'sd-cpp' && (
        <>
          <p className="muted small">
            Generate images locally through the bundled Stable Diffusion engine.
          </p>

          {probe.kind === 'engine-not-configured' && (
            <p className="error">
              The image engine isn't wired up on this install. Models on disk can't run on their own
              — they need the <code>sd-server</code> binary or an external server. Set{' '}
              <code>GEZEL_SD_SERVER_URL</code> to point at a running sd-server, or build the bundled
              binary at{' '}
              <code>
                native/build/{'<'}platform{'>'}/sd-server
              </code>
              .
              {probe.status.engine.error && (
                <>
                  {' '}
                  <span className="muted small">Details: {probe.status.engine.error}</span>
                </>
              )}
            </p>
          )}
          {probe.kind === 'engine-unreachable' && (
            <p className="error">
              The image engine is configured but isn't responding at{' '}
              <code>{probe.status.engine.baseUrl}</code>. Check whether <code>sd-server</code> is
              running.
              {probe.status.engine.error && (
                <>
                  {' '}
                  <span className="muted small">Details: {probe.status.engine.error}</span>
                </>
              )}
            </p>
          )}
          {probe.kind === 'probe-failed' && (
            <p className="error">Couldn't reach the Gezel service. Details: {probe.error}</p>
          )}

          <ImageModelManager
            {...(engineDown
              ? {
                  disabledReason:
                    probe.kind === 'engine-not-configured'
                      ? 'Image engine is not configured — downloading a model now would still leave it unrunnable.'
                      : 'Image engine is not reachable.',
                }
              : {})}
            {...(config?.defaultImageModel?.['sd-cpp']
              ? { configuredDefaultModelId: config.defaultImageModel['sd-cpp'] }
              : {})}
            onSetActiveModel={onActiveModelChange}
            onModelsChanged={() => {
              setRefreshTick((n) => n + 1);
              onModelsChanged?.();
            }}
          />
        </>
      )}

      {provider === 'google-ai' && (
        <CloudPanel
          providerLabel="Google Nano Banana 2"
          modelId="gemini-3.1-flash-image-preview"
          docsHref="https://ai.google.dev/gemini-api/docs/image-generation"
          hasKey={config?.hasGoogleAiApiKey === true}
          maskedKey={config?.googleAiApiKey}
          keyPlaceholder="AIza…"
          keyDraft={keyDraft}
          onKeyDraftChange={setKeyDraft}
          onSaveKey={onSaveKey}
          onClearKey={onClearKey}
          probe={probe}
        />
      )}

      {provider === 'openai' && (
        <CloudPanel
          providerLabel="OpenAI GPT Image 2"
          modelId="gpt-image-2"
          docsHref="https://developers.openai.com/api/docs/models/gpt-image-2"
          hasKey={config?.hasOpenaiApiKey === true}
          maskedKey={config?.openaiApiKey}
          keyPlaceholder="sk-…"
          keyDraft={keyDraft}
          onKeyDraftChange={setKeyDraft}
          onSaveKey={onSaveKey}
          onClearKey={onClearKey}
          probe={probe}
        />
      )}

      {(isCloud || engineKind === 'cloud') && (
        <fieldset
          className="provider-row"
          style={{ flexDirection: 'column', alignItems: 'flex-start' }}
        >
          <legend>Cost confirmation</legend>
          <p className="muted small">
            Cloud image generations cost real money. Choose whether you want to be asked before each
            cloud generation.
          </p>
          <label className="provider-row">
            <input
              type="radio"
              name="image-confirmation"
              value="ask"
              checked={confirmationMode === 'ask'}
              onChange={() => void onConfirmationChange('ask')}
            />
            <span>Ask before each cloud image (default)</span>
          </label>
          <label className="provider-row">
            <input
              type="radio"
              name="image-confirmation"
              value="always-allow"
              checked={confirmationMode === 'always-allow'}
              onChange={() => void onConfirmationChange('always-allow')}
            />
            <span>Always allow without asking</span>
          </label>
        </fieldset>
      )}

      {status && <p className="muted small">{status}</p>}
    </div>
  );
}

function CloudPanel({
  providerLabel,
  modelId,
  docsHref,
  hasKey,
  maskedKey,
  keyPlaceholder,
  keyDraft,
  onKeyDraftChange,
  onSaveKey,
  onClearKey,
  probe,
}: {
  providerLabel: string;
  modelId: string;
  docsHref: string;
  hasKey: boolean;
  maskedKey?: string;
  keyPlaceholder: string;
  keyDraft: string;
  onKeyDraftChange: (next: string) => void;
  onSaveKey: () => void;
  onClearKey: () => void;
  probe: ProbeState;
}) {
  return (
    <>
      <p className="muted small">
        Generate images through <strong>{providerLabel}</strong>. Models are managed by the
        provider; you only need an API key. Default model: <code>{modelId}</code>.{' '}
        <a href={docsHref} target="_blank" rel="noreferrer">
          Provider docs ↗
        </a>
      </p>

      {probe.kind === 'engine-not-configured' && (
        <p className="error">API key not configured. Add a key below to enable {providerLabel}.</p>
      )}
      {probe.kind === 'engine-unreachable' && (
        <p className="error">
          {providerLabel} isn't reachable.
          {probe.status.engine.error && (
            <>
              {' '}
              <span className="muted small">Details: {probe.status.engine.error}</span>
            </>
          )}
        </p>
      )}

      <div className="provider-row">
        <span>API key {hasKey && <span className="muted small">({maskedKey})</span>}</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={keyPlaceholder}
          value={keyDraft}
          onChange={(e) => onKeyDraftChange(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={onSaveKey} disabled={!keyDraft.trim()}>
          Save
        </button>
        {hasKey && (
          <button type="button" className="subtle" onClick={onClearKey}>
            Clear
          </button>
        )}
      </div>
    </>
  );
}

function normalizeConfirmation(
  raw: ConfigResponse['imageGenerationConfirmation'] | undefined,
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
