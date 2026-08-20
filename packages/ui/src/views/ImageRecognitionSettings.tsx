import type {
  InstalledRecognitionModel,
  RecognitionCatalogEntry,
  RecognitionHealth,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

/**
 * Settings subsection for the image-recognition workload.
 *
 * The workload exists because most models can't see: ds4 structurally cannot,
 * and a local model only reads images when it was launched with a vision
 * projector. When the chat model is blind, a small local vision model
 * describes the image and the description is passed along as text.
 *
 * Layout follows {@link AudioEngineSettings} — readiness pill, guidance,
 * model list.
 */

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

interface ActivePull {
  id: string;
  bytesWritten: number;
  totalBytes: number;
  error?: string;
  controller: AbortController;
}

const MODE_OPTIONS = [
  { value: 'auto', label: 'When needed', hint: "Only when the model can't see" },
  { value: 'always', label: 'Always', hint: 'Even for models that can' },
  { value: 'off', label: 'Never', hint: 'Metadata only' },
] as const;

export function ImageRecognitionSettings() {
  const [health, setHealth] = useState<RecognitionHealth | null>(null);
  const [installed, setInstalled] = useState<InstalledRecognitionModel[]>([]);
  const [catalog, setCatalog] = useState<RecognitionCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'always' | 'off'>('auto');
  const [savingMode, setSavingMode] = useState(false);
  const [pulls, setPulls] = useState<Map<string, ActivePull>>(new Map());
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [cacheCleared, setCacheCleared] = useState(false);
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;

  const refresh = useCallback(async () => {
    try {
      const [h, inst, cat, cfg] = await Promise.all([
        api.getRecognitionHealth(),
        api.listInstalledRecognitionModels(),
        api.listRecognitionCatalog(),
        api.getConfig(),
      ]);
      setHealth(h);
      setInstalled(inst.models);
      setCatalog(cat.models);
      setMode(cfg.recognition?.mode ?? 'auto');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSetMode = useCallback(
    async (next: 'auto' | 'always' | 'off') => {
      const previous = mode;
      setMode(next);
      setSavingMode(true);
      try {
        const res = await api.updateConfig({ recognition: { mode: next } });
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      } catch (err) {
        setMode(previous);
        setError((err as Error).message);
      } finally {
        setSavingMode(false);
      }
    },
    [mode],
  );

  const startPull = useCallback(
    (entry: RecognitionCatalogEntry) => {
      const controller = new AbortController();
      setPulls((prev) =>
        new Map(prev).set(entry.id, {
          id: entry.id,
          bytesWritten: 0,
          totalBytes: entry.approxSizeBytes,
          controller,
        }),
      );
      void api
        .pullRecognitionModel(
          entry.id,
          (event) => {
            setPulls((prev) => {
              const next = new Map(prev);
              const current = next.get(entry.id);
              if (!current) return prev;
              if (event.type === 'progress') {
                next.set(entry.id, {
                  ...current,
                  bytesWritten: event.bytesWritten,
                  totalBytes: event.totalBytes ?? current.totalBytes,
                });
              } else if (event.type === 'error') {
                next.set(entry.id, { ...current, error: event.error });
              } else {
                next.delete(entry.id);
              }
              return next;
            });
            if (event.type === 'done') void refresh();
          },
          controller.signal,
        )
        .catch((err) => {
          setPulls((prev) => {
            const next = new Map(prev);
            const current = next.get(entry.id);
            if (current) next.set(entry.id, { ...current, error: (err as Error).message });
            return next;
          });
        });
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (id: string) => {
      setToDelete(null);
      try {
        await api.deleteRecognitionModel(id);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refresh],
  );

  const onClearCache = useCallback(async () => {
    try {
      await api.clearRecognitionCache();
      setCacheCleared(true);
      window.setTimeout(() => setCacheCleared(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const installedIds = new Set(installed.map((m) => m.id));

  return (
    <div className="provider-card">
      <div className="settings-card-header">
        <h3>Image recognition</h3>
        {health && <HealthPill health={health} />}
      </div>

      <p className="muted small">
        Most models can't see images. When someone pastes a screenshot into a chat with a model that
        has no vision, a small local model reads the image and passes along a description — so the
        conversation still works. Runs entirely on this device; weights live under{' '}
        <code>~/.gezel/engines/recognition/</code>. Also available to any gezel through the{' '}
        <code>describe_image</code> tool.
      </p>

      {error && <p className="error">{error}</p>}
      <HealthGuidance health={health} />

      <section style={{ marginTop: '1rem' }}>
        <h4 style={{ margin: '0 0 0.35rem' }}>When to read images locally</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          "Always" keeps images on this device even when the chat model could see them itself —
          cheaper than sending pictures to a paid model, and nothing leaves the machine. Individual
          gezels can override this.
        </p>
        <div className="gz-tray" role="radiogroup" aria-label="When to read images locally">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
              role="radio"
              aria-checked={mode === opt.value}
              disabled={savingMode}
              className={`gz-key gz-key--stacked${mode === opt.value ? ' gz-key-active' : ''}`}
              onClick={() => void onSetMode(opt.value)}
            >
              <span>{opt.label}</span>
              <small>{opt.hint}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="ollama-section" style={{ marginTop: '1.5rem' }}>
        <h4>Models</h4>
        <div className="catalog-ollama-list">
          {catalog.map((entry) => {
            const isInstalled = installedIds.has(entry.id);
            const pull = pulls.get(entry.id);
            const pct =
              pull && pull.totalBytes > 0
                ? Math.min(100, Math.round((pull.bytesWritten / pull.totalBytes) * 100))
                : null;
            return (
              <div key={entry.id} className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <code>{entry.id}</code>
                    <span>·</span>
                    <span>{formatSize(entry.approxSizeBytes)}</span>
                    <span>·</span>
                    <span>{entry.license}</span>
                  </div>
                  <div className="muted small">
                    <strong>{entry.name}</strong> — {entry.description}
                  </div>
                  {pull?.error && <div className="error small">{pull.error}</div>}
                </div>
                {pull ? (
                  <button
                    type="button"
                    onClick={() => {
                      pull.controller.abort();
                      setPulls((prev) => {
                        const next = new Map(prev);
                        next.delete(entry.id);
                        return next;
                      });
                    }}
                  >
                    {pct !== null ? `Downloading… ${pct}%` : 'Downloading…'}
                  </button>
                ) : isInstalled ? (
                  <button type="button" onClick={() => setToDelete(entry.id)}>
                    Remove
                  </button>
                ) : (
                  <button type="button" onClick={() => startPull(entry)}>
                    Download
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="ollama-section" style={{ marginTop: '1.25rem' }}>
        <h4>Cached descriptions</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Each image is read once and the result is reused, keyed by its contents. Clearing is safe
          — anything still needed is read again on demand.
        </p>
        <button type="button" onClick={() => void onClearCache()}>
          {cacheCleared ? 'Cleared' : 'Clear cache'}
        </button>
      </section>

      <ConfirmDialog
        open={toDelete !== null}
        title="Remove this model?"
        message="The weights are deleted from this device. You can download them again later."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (toDelete) void onDelete(toDelete);
        }}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}

function HealthPill({ health }: { health: RecognitionHealth }) {
  if (health.state === 'ok') {
    return <span className="gz-status-pill gz-status-pill--ok">Ready</span>;
  }
  if (health.state === 'no-model') {
    return <span className="gz-status-pill gz-status-pill--warn">No model</span>;
  }
  if (health.state === 'error') {
    return <span className="gz-status-pill gz-status-pill--error">Error</span>;
  }
  return <span className="gz-status-pill gz-status-pill--warn">Unavailable</span>;
}

function HealthGuidance({ health }: { health: RecognitionHealth | null }) {
  if (!health || health.state === 'ok') return null;
  if (health.state === 'no-model') {
    return (
      <p className="muted small">
        Download a model below to turn this on. Until then, images pasted into a chat with a model
        that can't see are described only by their file details — size, format, and any text stored
        inside the file.
      </p>
    );
  }
  return <p className="muted small">{health.detail ?? 'The recognition engine is unavailable.'}</p>;
}
