import type { AudioCatalogModel, InstalledAudioModel } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { LicenseButton } from './LicenseButton.js';
import { RecommendedBadge } from './RecommendedBadge.js';

/**
 * Install / pull / delete flow for audio (STT + TTS) models. Shape
 * mirrors {@link ImageModelManager} but reads the embedded audio
 * catalog (`api.listAudioCatalog`) rather than the generic catalog
 * service — the narration MVP ships a small fixed list.
 */

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

interface ActivePull {
  id: string;
  bytesWritten: number;
  totalBytes: number;
  error?: string;
  controller: AbortController;
}

interface Props {
  /** `'stt'` for whisper.cpp models, `'tts'` for Kokoro. */
  kind: 'stt' | 'tts';
  /** When set, the install button is disabled — e.g. engine not configured. */
  disabledReason?: string;
  /** Fired after install / delete so the parent can refresh status pills. */
  onModelsChanged?: () => void;
}

export function AudioModelManager({ kind, disabledReason, onModelsChanged }: Props) {
  const [installed, setInstalled] = useState<InstalledAudioModel[]>([]);
  const [catalog, setCatalog] = useState<AudioCatalogModel[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Map<string, ActivePull>>(new Map());
  const [toDelete, setToDelete] = useState<string | null>(null);
  const pullsRef = useRef(pulls);
  pullsRef.current = pulls;

  const refresh = useCallback(async () => {
    try {
      const [installedRes, catalogRes] = await Promise.all([
        kind === 'stt' ? api.listInstalledSttModels() : api.listInstalledTtsModels(),
        api.listAudioCatalog(),
      ]);
      setInstalled(installedRes.models);
      setCatalog(kind === 'stt' ? catalogRes.stt : catalogRes.tts);
      setInstalledError(null);
    } catch (err) {
      setInstalled([]);
      setInstalledError((err as Error).message);
    }
  }, [kind]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startPull = useCallback(
    async (id: string) => {
      if (pullsRef.current.has(id)) return;
      const controller = new AbortController();
      setPulls((prev) => new Map(prev).set(id, { id, bytesWritten: 0, totalBytes: 0, controller }));
      try {
        await api.pullAudioModel(
          kind,
          id,
          (event) => {
            if (event.type === 'progress') {
              setPulls((prev) => {
                const next = new Map(prev);
                const cur = next.get(id);
                if (!cur) return prev;
                next.set(id, {
                  ...cur,
                  bytesWritten: event.bytesWritten,
                  totalBytes: event.totalBytes ?? cur.totalBytes,
                });
                return next;
              });
            } else if (event.type === 'error') {
              setPulls((prev) => {
                const next = new Map(prev);
                const cur = next.get(id);
                if (cur) next.set(id, { ...cur, error: event.error });
                return next;
              });
            }
          },
          controller.signal,
        );
        setTimeout(() => {
          // Keep error rows visible — the user needs to read the message
          // and click Dismiss. Only auto-clear on a clean pull.
          setPulls((prev) => {
            const cur = prev.get(id);
            if (cur?.error) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          void refresh();
          onModelsChanged?.();
        }, 800);
      } catch (err) {
        if (controller.signal.aborted) {
          setPulls((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
          return;
        }
        setPulls((prev) => {
          const next = new Map(prev);
          const cur = next.get(id);
          if (cur) next.set(id, { ...cur, error: (err as Error).message });
          return next;
        });
      }
    },
    [kind, refresh, onModelsChanged],
  );

  const cancelPull = useCallback((id: string) => {
    const pull = pullsRef.current.get(id);
    if (pull?.error) {
      // Already failed — abort is a no-op; this acts as Dismiss.
      setPulls((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    pull?.controller.abort();
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    try {
      if (kind === 'stt') await api.deleteSttModel(toDelete);
      else await api.deleteTtsModel(toDelete);
      await refresh();
      onModelsChanged?.();
    } catch (err) {
      setInstalledError((err as Error).message);
    } finally {
      setToDelete(null);
    }
  }, [kind, toDelete, refresh, onModelsChanged]);

  const installedIds = new Set(installed.map((m) => m.id));

  return (
    <div className="ollama-model-manager">
      {pulls.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(pulls.values()).map((pull) => (
              <AudioPullProgress key={pull.id} pull={pull} onCancel={() => cancelPull(pull.id)} />
            ))}
          </div>
        </div>
      )}

      {(installed.length > 0 || installedError) && (
        <div className="ollama-section">
          <h4>Local models</h4>
          {installedError && <p className="error">{installedError}</p>}
          {installed.length > 0 && (
            <table className="ollama-model-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {installed.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <code>{m.id}</code>
                      <div className="muted small">{m.name}</div>
                    </td>
                    <td>{formatSize(m.approxSizeBytes)}</td>
                    <td className="muted small">{new Date(m.installedAt).toLocaleDateString()}</td>
                    <td>
                      <button type="button" className="home-link" onClick={() => setToDelete(m.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="ollama-section ollama-section--flat">
        <h4>Download a model</h4>
        {catalog.length === 0 ? (
          <p className="muted small">No models in the catalog yet.</p>
        ) : (
          <div className="catalog-ollama-list">
            {catalog.map((m) => {
              const already = installedIds.has(m.id);
              const active = pulls.get(m.id);
              const pulling = Boolean(active);
              const pct =
                active && active.totalBytes > 0
                  ? Math.min(100, Math.round((active.bytesWritten / active.totalBytes) * 100))
                  : null;
              return (
                <div key={m.id} className="catalog-ollama-action">
                  <div className="catalog-ollama-meta">
                    <div className="catalog-ollama-specs muted small">
                      <code>{m.id}</code>
                      <span>·</span>
                      <span>{formatSize(m.approxSizeBytes)}</span>
                    </div>
                    <div className="muted small">
                      <strong>{m.name}</strong> — {m.description}
                    </div>
                    <div className="catalog-ollama-pills">
                      <LicenseButton manifest={m} />
                      <RecommendedBadge manifest={m} />
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={already || pulling || Boolean(disabledReason)}
                    title={disabledReason ?? undefined}
                    onClick={() => void startPull(m.id)}
                  >
                    {already
                      ? 'On device'
                      : pulling
                        ? pct !== null
                          ? `Downloading… ${pct}%`
                          : 'Downloading…'
                        : 'Download'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete ${kind === 'stt' ? 'STT' : 'TTS'} model?`}
        message={
          toDelete
            ? `"${toDelete}" will be removed from local storage. This frees disk space; download it again later to use it.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function AudioPullProgress({
  pull,
  onCancel,
}: {
  pull: ActivePull;
  onCancel: () => void;
}) {
  const known = pull.totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((pull.bytesWritten / pull.totalBytes) * 100)) : 0;
  const statusLine = pull.error
    ? pull.error
    : known
      ? `Downloading… (${formatSize(pull.bytesWritten)} of ${formatSize(pull.totalBytes)}, ${pct}%)`
      : `Downloading… (${formatSize(pull.bytesWritten)})`;
  return (
    <div className={`ollama-pull${pull.error ? ' ollama-pull-error' : ''}`}>
      <div className="ollama-pull-head">
        <code>{pull.id}</code>
        <span className="muted small">{statusLine}</span>
        <button type="button" className="home-link" onClick={onCancel}>
          {pull.error ? 'Dismiss' : 'Cancel'}
        </button>
      </div>
      {known ? (
        <div className="ollama-pull-bar">
          <div className="ollama-pull-bar-fill" style={{ width: `${pct}%` }} />
          <span className="ollama-pull-bar-label">{pct}%</span>
        </div>
      ) : (
        <div className="ollama-pull-bar ollama-pull-bar-indeterminate">
          <div className="ollama-pull-bar-fill" />
        </div>
      )}
    </div>
  );
}
