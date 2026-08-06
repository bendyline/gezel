import type { ConfigResponse, MlxRuntimeInfo } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { CacheControlsPanel } from '../components/CacheControlsPanel.js';
import { EngineBudgetStrip } from '../components/EngineBudgetStrip.js';
import { EngineClonePicker } from '../components/EngineClonePicker.js';
import { MlxModelManager } from '../components/MlxModelManager.js';

interface Props {
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
  showLlamaCpp?: boolean;
  onShowLlamaCppChange?: (next: boolean) => void;
}

const IS_APPLE_SILICON =
  typeof navigator !== 'undefined' &&
  /Mac/.test(navigator.platform) &&
  // Chromium gives us `navigator.userAgentData.architecture` on modern
  // macOS builds; fall back to UA string on older browsers.
  ((navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData
    ?.architecture === 'arm' ||
    /Mac.*Apple/i.test(navigator.userAgent));

/**
 * MLX-provider settings. Model browsing / install / delete is
 * delegated to MlxModelManager so the UX stays in lockstep with the
 * llama.cpp and Ollama managers; this component owns only the
 * MLX-specific surfaces (Python-runtime status, external mlx_lm.server
 * URL, override model directory, mlx-lm package pin, and the
 * "show llama.cpp" escape hatch).
 */
export function MlxSettings({
  config,
  onConfigChanged,
  showLlamaCpp,
  onShowLlamaCppChange,
}: Props) {
  const [baseUrlDraft, setBaseUrlDraft] = useState(config?.mlxBaseUrl ?? '');
  const [modelPathDraft, setModelPathDraft] = useState(config?.mlxModelPath ?? '');
  const [packageSpecDraft, setPackageSpecDraft] = useState(config?.mlxPackageSpec ?? '');
  const [runtime, setRuntime] = useState<MlxRuntimeInfo | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<'idle' | 'resetting' | 'done'>('idle');

  useEffect(() => {
    setBaseUrlDraft(config?.mlxBaseUrl ?? '');
  }, [config?.mlxBaseUrl]);
  useEffect(() => {
    setModelPathDraft(config?.mlxModelPath ?? '');
  }, [config?.mlxModelPath]);
  useEffect(() => {
    setPackageSpecDraft(config?.mlxPackageSpec ?? '');
  }, [config?.mlxPackageSpec]);

  const refreshRuntime = useCallback(async () => {
    try {
      const info = await api.getMlxRuntime();
      setRuntime(info);
    } catch {
      setRuntime(null);
    }
  }, []);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const resetVenv = useCallback(async () => {
    setResetStatus('resetting');
    try {
      await api.resetMlxRuntime();
      setResetStatus('done');
      // Flash the confirmation for a beat, then fade back — same
      // cadence as the "saved ✓" pills on the config inputs below.
      setTimeout(() => setResetStatus('idle'), 3000);
      void refreshRuntime();
    } catch (err) {
      setResetStatus('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshRuntime]);

  const saveBaseUrl = useCallback(async () => {
    const trimmed = baseUrlDraft.trim();
    setSaving('saving');
    try {
      const next = await api.updateConfig({ mlxBaseUrl: trimmed === '' ? null : trimmed });
      onConfigChanged(next);
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch {
      setSaving('idle');
    }
  }, [baseUrlDraft, onConfigChanged]);

  const saveModelPath = useCallback(async () => {
    const trimmed = modelPathDraft.trim();
    setSaving('saving');
    try {
      const next = await api.updateConfig({
        mlxModelPath: trimmed === '' ? null : trimmed,
      });
      onConfigChanged(next);
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch {
      setSaving('idle');
    }
  }, [modelPathDraft, onConfigChanged]);

  const savePackageSpec = useCallback(async () => {
    const trimmed = packageSpecDraft.trim();
    setSaving('saving');
    try {
      const next = await api.updateConfig({
        mlxPackageSpec: trimmed === '' ? null : trimmed,
      });
      onConfigChanged(next);
      setSaving('saved');
      setTimeout(() => setSaving('idle'), 1200);
    } catch {
      setSaving('idle');
    }
  }, [packageSpecDraft, onConfigChanged]);

  const saveKvBits = useCallback(
    async (value: number) => {
      setSaving('saving');
      try {
        const next = await api.updateConfig({
          // 0 = off, the default — send null to clear the pinned value.
          // undefined is stripped by JSON.stringify and never clears it.
          mlxKvBits: value === 0 ? null : value,
        });
        onConfigChanged(next);
        setSaving('saved');
        setTimeout(() => setSaving('idle'), 1200);
      } catch {
        setSaving('idle');
      }
    },
    [onConfigChanged],
  );

  const hasExternal = Boolean(config?.mlxBaseUrl);

  return (
    <div>
      <section style={{ marginBottom: '2rem' }}>
        <h3>This Mac</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          On-device AI powered by Apple's MLX framework.
        </p>

        {!IS_APPLE_SILICON && (
          <div
            className="home-status-pill home-status-warn"
            style={{ marginTop: '0.5rem', display: 'inline-block' }}
          >
            This machine doesn't look like Apple Silicon — chat turns routed to MLX will error out
            at send time.
          </div>
        )}

        {hasExternal && (
          <div className="new-row" style={{ marginTop: '0.75rem' }}>
            <span
              className="home-status-pill home-status-warn"
              title={`External engine: ${config?.mlxBaseUrl}`}
            >
              using external engine
            </span>
            {saving === 'saved' && <span className="muted small">saved ✓</span>}
          </div>
        )}
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <MlxModelManager onModelsChanged={() => void refreshRuntime()} />
      </section>

      <EngineBudgetStrip provider="mlx" />

      <section style={{ marginBottom: '2rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>Concurrent replicas</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Run multiple copies of the same model so unrelated sessions don't queue behind each other.
          Weights are shared by the OS via mmap so disk cost stays at one model file; resident
          memory grows because each clone keeps its own KV cache and activations.
        </p>
        <EngineClonePicker
          provider="mlx"
          modelId={config?.defaultModel?.mlx ?? null}
          config={config}
          onConfigChanged={onConfigChanged}
        />
      </section>

      {error && (
        <div className="muted small" style={{ color: '#ff9b9b', marginTop: '1rem' }} role="alert">
          {error}{' '}
          <button type="button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <section style={{ marginTop: '2rem' }}>
        <CacheControlsPanel
          providerName="mlx"
          label="This Mac AI"
          configuredBudgetMb={config?.cacheBudgetMb?.mlx}
        />
      </section>

      <details className="mlx-advanced" style={{ marginTop: '2rem' }}>
        <summary style={{ cursor: 'pointer' }}>
          <strong>Advanced</strong>
        </summary>

        {onShowLlamaCppChange && (
          <section style={{ marginTop: '1rem' }}>
            <label
              className="new-row"
              style={{ alignItems: 'flex-start', gap: '0.6rem', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={Boolean(showLlamaCpp)}
                onChange={(e) => onShowLlamaCppChange(e.target.checked)}
                style={{ marginTop: '0.25rem' }}
              />
              <span>
                <strong>Show llama local device processing</strong>
                <div className="muted small">
                  Reveals an additional "On-device (llama)" provider option and its settings tab.
                  Use this as a fallback when MLX isn't a fit — for example, Intel Macs or models
                  that only ship in GGUF.
                </div>
              </span>
            </label>
          </section>
        )}

        <section style={{ marginTop: '1.25rem' }}>
          <h4 style={{ marginBottom: '0.35rem' }}>Python runtime</h4>
          {runtime ? (
            <div className="muted small" style={{ marginTop: '0.25rem' }}>
              {runtime.source === null ? (
                <>
                  <strong>No Python runtime available.</strong>{' '}
                  {runtime.reason ??
                    'Install Python 3.11 or wait for a packaged build that bundles uv.'}
                </>
              ) : (
                <>
                  Source: <code>{runtime.source}</code>
                  {runtime.uvVersion && (
                    <>
                      {' '}
                      · uv <code>{runtime.uvVersion}</code>
                    </>
                  )}
                  {runtime.pythonVersion && (
                    <>
                      {' '}
                      · Python <code>{runtime.pythonVersion}</code>
                    </>
                  )}
                  {runtime.installerPath && (
                    <>
                      {' '}
                      · <span title={runtime.installerPath}>installer at path</span>
                    </>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="muted small">Probing…</div>
          )}
          <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => void resetVenv()}
              disabled={resetStatus === 'resetting'}
            >
              {resetStatus === 'resetting' ? 'Resetting…' : 'Reset gezel Python environment'}
            </button>
            {resetStatus === 'done' ? (
              <span className="home-status-pill home-status-ok">venv was reset ✓</span>
            ) : (
              <span className="muted small">
                Deletes the `mlx` venv; the next chat turn re-provisions it.
              </span>
            )}
          </div>
        </section>

        <section style={{ marginTop: '1.25rem' }}>
          <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
            <label className="muted" style={{ fontSize: '0.9rem', minWidth: '12rem' }}>
              External mlx_lm.server URL
            </label>
            <input
              type="text"
              placeholder="e.g. http://127.0.0.1:8000 (leave blank for supervised)"
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              disabled={saving === 'saving' || baseUrlDraft === (config?.mlxBaseUrl ?? '')}
              onClick={() => void saveBaseUrl()}
            >
              Save
            </button>
          </div>

          <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
            <label className="muted" style={{ fontSize: '0.9rem', minWidth: '12rem' }}>
              Override model directory
            </label>
            <input
              type="text"
              placeholder="Absolute path to an MLX model dir"
              value={modelPathDraft}
              onChange={(e) => setModelPathDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              disabled={saving === 'saving' || modelPathDraft === (config?.mlxModelPath ?? '')}
              onClick={() => void saveModelPath()}
            >
              Save
            </button>
          </div>

          <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
            <label className="muted" style={{ fontSize: '0.9rem', minWidth: '12rem' }}>
              mlx-lm package spec
            </label>
            <input
              type="text"
              placeholder="e.g. mlx-lm==0.25.3 (blank → latest)"
              value={packageSpecDraft}
              onChange={(e) => setPackageSpecDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              disabled={saving === 'saving' || packageSpecDraft === (config?.mlxPackageSpec ?? '')}
              onClick={() => void savePackageSpec()}
            >
              Save
            </button>
          </div>

          <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
            <label className="muted" style={{ fontSize: '0.9rem', minWidth: '12rem' }}>
              KV cache quantization
            </label>
            <select
              value={String(config?.mlxKvBits ?? 0)}
              onChange={(e) => void saveKvBits(Number(e.target.value))}
              style={{ flex: 1 }}
            >
              <option value="0">Off — full precision (default)</option>
              <option value="8">8-bit — mild speedup, near-lossless</option>
              <option value="6">6-bit — compromise</option>
              <option value="4">4-bit — best speedup</option>
            </select>
          </div>
          <p className="muted small" style={{ marginTop: '0.35rem' }}>
            Sets <code>--kv-bits</code> for mlx_lm.server. Quantizing the KV cache lowers memory use
            and can speed up generation. Off by default because MLX can crash (
            <code>RotatingKVCache Quantization NYI</code>) once a long session approaches the
            model's context limit — safe for short sessions, risky for deep Meester histories. Takes
            effect the next time the engine starts.
          </p>
        </section>
      </details>
    </div>
  );
}
