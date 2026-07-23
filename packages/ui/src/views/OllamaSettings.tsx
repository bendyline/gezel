import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { OllamaModelManager } from '../components/OllamaModelManager.js';

interface Props {
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
}

interface StatusState {
  kind: 'idle' | 'probing' | 'ok' | 'fail';
  baseUrl?: string;
  modelCount?: number;
  error?: string;
}

export function OllamaSettings({ config, onConfigChanged }: Props) {
  const [urlDraft, setUrlDraft] = useState(config?.ollamaBaseUrl ?? '');
  const [status, setStatus] = useState<StatusState>({ kind: 'idle' });
  const [ctxDraft, setCtxDraft] = useState<string>(
    config?.ollamaNumCtx ? String(config.ollamaNumCtx) : '',
  );
  // Three timeout drafts. Empty string = "use the default";
  // explicit numeric value overrides. Defaults match the
  // service-side fallbacks in `OllamaProvider` /
  // `OLLAMA_TURN_TIMEOUT_MS`.
  const [streamingIdleDraft, setStreamingIdleDraft] = useState<string>(
    config?.ollamaStreamingIdleSec ? String(config.ollamaStreamingIdleSec) : '',
  );
  const [preFirstByteDraft, setPreFirstByteDraft] = useState<string>(
    config?.ollamaPreFirstByteIdleSec ? String(config.ollamaPreFirstByteIdleSec) : '',
  );
  const [turnTimeoutDraft, setTurnTimeoutDraft] = useState<string>(
    config?.ollamaTurnTimeoutMin ? String(config.ollamaTurnTimeoutMin) : '',
  );
  const [numPredictDraft, setNumPredictDraft] = useState<string>(
    config?.ollamaNumPredict ? String(config.ollamaNumPredict) : '',
  );

  useEffect(() => {
    setUrlDraft(config?.ollamaBaseUrl ?? '');
  }, [config?.ollamaBaseUrl]);

  useEffect(() => {
    setCtxDraft(config?.ollamaNumCtx ? String(config.ollamaNumCtx) : '');
  }, [config?.ollamaNumCtx]);

  useEffect(() => {
    setStreamingIdleDraft(
      config?.ollamaStreamingIdleSec ? String(config.ollamaStreamingIdleSec) : '',
    );
  }, [config?.ollamaStreamingIdleSec]);

  useEffect(() => {
    setPreFirstByteDraft(
      config?.ollamaPreFirstByteIdleSec ? String(config.ollamaPreFirstByteIdleSec) : '',
    );
  }, [config?.ollamaPreFirstByteIdleSec]);

  useEffect(() => {
    setTurnTimeoutDraft(config?.ollamaTurnTimeoutMin ? String(config.ollamaTurnTimeoutMin) : '');
  }, [config?.ollamaTurnTimeoutMin]);

  useEffect(() => {
    setNumPredictDraft(config?.ollamaNumPredict ? String(config.ollamaNumPredict) : '');
  }, [config?.ollamaNumPredict]);

  const refreshStatus = useCallback(async () => {
    setStatus({ kind: 'probing' });
    try {
      const s = await api.ollamaStatus();
      if (s.ok) {
        setStatus({ kind: 'ok', baseUrl: s.baseUrl, modelCount: s.modelCount });
        return;
      }
      // Probe failed. If auto-start is enabled and Ollama is installed
      // locally, try to launch it, then re-probe once.
      if (config?.autoStartOllama !== false) {
        const launch = await api.ollamaStart();
        if (launch.started) {
          const s2 = await api.ollamaStatus();
          if (s2.ok) {
            setStatus({ kind: 'ok', baseUrl: s2.baseUrl, modelCount: s2.modelCount });
            return;
          }
        }
      }
      setStatus({ kind: 'fail', baseUrl: s.baseUrl, error: s.error });
    } catch (err) {
      setStatus({ kind: 'fail', error: (err as Error).message });
    }
  }, [config?.autoStartOllama]);

  const handleStartClick = useCallback(async () => {
    setStatus({ kind: 'probing' });
    try {
      const res = await api.ollamaStart();
      if (res.started) {
        await refreshStatus();
      } else {
        setStatus({ kind: 'fail', error: res.error ?? 'Ollama did not start' });
      }
    } catch (err) {
      setStatus({ kind: 'fail', error: (err as Error).message });
    }
  }, [refreshStatus]);

  const toggleAutoStart = useCallback(
    async (next: boolean) => {
      const res = await api.updateConfig({ autoStartOllama: next });
      onConfigChanged(res);
    },
    [onConfigChanged],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-probe when the base URL changes, even though refreshStatus captures it indirectly.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, config?.ollamaBaseUrl]);

  const saveBaseUrl = useCallback(async () => {
    const next = urlDraft.trim();
    const res = await api.updateConfig({ ollamaBaseUrl: next || undefined });
    onConfigChanged(res);
    await refreshStatus();
  }, [urlDraft, onConfigChanged, refreshStatus]);

  const saveNumCtx = useCallback(async () => {
    const trimmed = ctxDraft.trim();
    const parsed = trimmed ? Number.parseInt(trimmed, 10) : undefined;
    if (trimmed && (!Number.isFinite(parsed) || (parsed ?? 0) <= 0)) {
      return;
    }
    const res = await api.updateConfig({ ollamaNumCtx: parsed });
    onConfigChanged(res);
  }, [ctxDraft, onConfigChanged]);

  const saveNumPredict = useCallback(async () => {
    const trimmed = numPredictDraft.trim();
    const parsed = trimmed ? Number.parseInt(trimmed, 10) : undefined;
    if (trimmed && (!Number.isFinite(parsed) || (parsed ?? 0) <= 0)) return;
    const res = await api.updateConfig({ ollamaNumPredict: parsed });
    onConfigChanged(res);
  }, [numPredictDraft, onConfigChanged]);

  // Generic positive-int saver shared by the three timeout knobs.
  // Empty string clears the override (back to service-side default).
  const savePositiveInt = useCallback(
    async (
      key: 'ollamaStreamingIdleSec' | 'ollamaPreFirstByteIdleSec' | 'ollamaTurnTimeoutMin',
      raw: string,
    ) => {
      const trimmed = raw.trim();
      const parsed = trimmed ? Number.parseInt(trimmed, 10) : undefined;
      if (trimmed && (!Number.isFinite(parsed) || (parsed ?? 0) <= 0)) return;
      const res = await api.updateConfig({ [key]: parsed });
      onConfigChanged(res);
    },
    [onConfigChanged],
  );

  return (
    <div className="ollama-settings">
      <h3>Ollama (local models)</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Run models locally — no credentials, no traffic leaving the machine. Install{' '}
        <code>ollama serve</code> and point gezel at it below.
      </p>

      {/* Server */}
      <div className="ollama-section">
        <h4>Server</h4>
        <div className="new-row">
          <input
            placeholder="http://localhost:11434"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => void saveBaseUrl()}
            disabled={urlDraft.trim() === (config?.ollamaBaseUrl ?? '')}
          >
            Save
          </button>
          <button type="button" onClick={() => void refreshStatus()}>
            {status.kind === 'probing' ? 'Testing…' : 'Test'}
          </button>
          {status.kind === 'fail' && (
            <button type="button" onClick={() => void handleStartClick()}>
              Start Ollama
            </button>
          )}
        </div>
        <OllamaStatusLine status={status} />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginTop: '0.5rem',
            fontSize: '0.85rem',
          }}
        >
          <input
            type="checkbox"
            checked={config?.autoStartOllama !== false}
            onChange={(e) => void toggleAutoStart(e.target.checked)}
          />
          <span>Automatically start Ollama when it's installed but not running.</span>
        </label>
      </div>

      <div className="ollama-section">
        <h4>Context window</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Ollama's default <code>num_ctx</code> is small (2048–4096) and silently drops older
          messages when it overflows. Gezel picks a parameter-size aware default (4k for ≤3B, 8k for
          7B+, 16k for 30B+). Override here to force a specific value for every session.
        </p>
        <div className="new-row">
          <input
            type="number"
            min={1}
            placeholder="e.g. 8192"
            value={ctxDraft}
            onChange={(e) => setCtxDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => void saveNumCtx()}
            disabled={ctxDraft.trim() === (config?.ollamaNumCtx ? String(config.ollamaNumCtx) : '')}
          >
            Save
          </button>
        </div>
      </div>

      <div className="ollama-section">
        <h4>Response budget</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Cap on tokens the model can generate per turn (<code>num_predict</code>). Ollama's own
          default (128) is far too small for real chat — the model can spend it all on silent
          reasoning and emit nothing visible. Gezel defaults to 4096; bump higher if you see
          warnings about replies being truncated at the cap.
        </p>
        <div className="new-row">
          <input
            type="number"
            min={1}
            placeholder="e.g. 4096"
            value={numPredictDraft}
            onChange={(e) => setNumPredictDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => void saveNumPredict()}
            disabled={
              numPredictDraft.trim() ===
              (config?.ollamaNumPredict ? String(config.ollamaNumPredict) : '')
            }
          >
            Save
          </button>
        </div>
      </div>

      {/* Reasoning-mode toggle moved to the Artificial Intelligence tab
         alongside the Default model selector — it only applies to
         reasoning-family models and the context makes more sense
         there. See `SettingsView`. */}

      <div className="ollama-section">
        <h4>Timeouts</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Local models on consumer hardware can take minutes for one turn — these caps decide when
          we give up. Two of them watch for *silence* (reset on activity); the third is a hard
          ceiling that ticks down regardless. Leave blank to use the defaults.
        </p>
        <TimeoutRow
          label="Pre-first-byte cap"
          unit="seconds"
          help="Cold-start load + prompt prefill before the first visible token. Default 300s. Bump for big models with heavy system prompts or reasoning models that think silently before output."
          value={preFirstByteDraft}
          onChange={setPreFirstByteDraft}
          configValue={config?.ollamaPreFirstByteIdleSec}
          onSave={() => void savePositiveInt('ollamaPreFirstByteIdleSec', preFirstByteDraft)}
        />
        <TimeoutRow
          label="Mid-stream silence cap"
          unit="seconds"
          help="How long the model can go silent mid-reply before we abort. Default 300s. Bump for reasoning models that pause between visible bursts. The 'wire pulse' dots in the chat tell you whether silence is real or just framing chunks."
          value={streamingIdleDraft}
          onChange={setStreamingIdleDraft}
          configValue={config?.ollamaStreamingIdleSec}
          onSave={() => void savePositiveInt('ollamaStreamingIdleSec', streamingIdleDraft)}
        />
        <TimeoutRow
          label="Hard turn timeout"
          unit="minutes"
          help="Total wall-clock cap from when the model takes the slot to when it's done. Default 30m. Fires regardless of whether bytes are flowing — the backstop for runaway tool loops."
          value={turnTimeoutDraft}
          onChange={setTurnTimeoutDraft}
          configValue={config?.ollamaTurnTimeoutMin}
          onSave={() => void savePositiveInt('ollamaTurnTimeoutMin', turnTimeoutDraft)}
        />
      </div>

      <OllamaModelManager
        enabled={status.kind === 'ok'}
        onModelsChanged={() => void refreshStatus()}
      />
    </div>
  );
}

/** Single editable timeout row — shared by the three caps. Left
 *  blank to fall back to the service-side default; explicit value
 *  overrides. The Save button stays disabled when the draft
 *  matches the persisted value. */
export function TimeoutRow({
  label,
  unit,
  help,
  value,
  onChange,
  configValue,
  onSave,
}: {
  label: string;
  unit: 'seconds' | 'minutes';
  help: string;
  value: string;
  onChange: (next: string) => void;
  configValue: number | undefined;
  onSave: () => void;
}) {
  const persistedDraft = configValue ? String(configValue) : '';
  return (
    <div style={{ marginTop: '0.6rem' }}>
      <div style={{ fontSize: '0.85rem', marginBottom: '0.2rem' }}>
        <strong>{label}</strong> <span className="muted small">({unit})</span>
      </div>
      <p className="muted small" style={{ margin: '0 0 0.3rem 0' }}>
        {help}
      </p>
      <div className="new-row">
        <input
          type="number"
          min={1}
          placeholder="default"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={onSave} disabled={value.trim() === persistedDraft}>
          Save
        </button>
      </div>
    </div>
  );
}

function OllamaStatusLine({ status }: { status: StatusState }) {
  if (status.kind === 'idle' || status.kind === 'probing') {
    return <p className="muted small">Checking…</p>;
  }
  if (status.kind === 'ok') {
    return (
      <p className="muted small">
        ✓ Reachable at <code>{status.baseUrl}</code> — {status.modelCount} model
        {status.modelCount === 1 ? '' : 's'} available locally.
      </p>
    );
  }
  return (
    <p className="error small">
      ✗ Couldn't reach <code>{status.baseUrl ?? '(no URL)'}</code>: {status.error}
    </p>
  );
}
