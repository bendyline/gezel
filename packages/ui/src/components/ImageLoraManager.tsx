import type {
  CatalogItemSummary,
  ImageLoraManifest,
  InstalledImageLora,
  InstalledImageModel,
} from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { LicenseButton } from './LicenseButton.js';
import {
  type ImagePullEndpoints,
  ImagePullProgress,
  formatSize,
  useImagePulls,
} from './image-pulls.js';

const LORA_PULLS: ImagePullEndpoints = {
  list: () => api.listActiveImageLoraPulls(),
  start: (id, onEvent, signal) => api.pullImageLora(id, onEvent, signal),
  subscribe: (id, onEvent, signal) => api.subscribeImageLoraPull(id, onEvent, signal),
  cancel: (id) => api.cancelImageLoraPull(id),
};

const PURPOSE_LABEL = { speed: 'Fast mode', style: 'Style' } as const;

/**
 * Styles and fast mode for the installed local models: catalog LoRAs, which
 * people never see named as such. Each one works only with the models it
 * lists, so the catalog shows only those that fit a model on this computer.
 * Turning fast mode off is a per-model switch in the Local models table.
 */
export function ImageLoraManager({
  models,
  disabledReason,
  onChanged,
}: {
  /** Installed local models. */
  models: readonly InstalledImageModel[];
  disabledReason?: string;
  /** Fired after an install or removal, so the model listing reloads its styles. */
  onChanged: () => void;
}) {
  const [installed, setInstalled] = useState<InstalledImageLora[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [engineTooOld, setEngineTooOld] = useState(false);
  const [toRemove, setToRemove] = useState<string | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const refresh = useCallback(async () => {
    try {
      const res = await api.listInstalledImageLoras();
      setInstalled(res.loras);
      setEngineTooOld(false);
      setError(null);
    } catch (err) {
      // A machine engine from before styles answers with a 404.
      if (err instanceof GezelApiError && err.status === 404) setEngineTooOld(true);
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { pulls, startPull, retryPull, cancelPull } = useImagePulls(LORA_PULLS, () => {
    void refresh();
    onChangedRef.current();
  });

  const confirmRemove = useCallback(async () => {
    if (!toRemove) return;
    try {
      await api.deleteImageLora(toRemove);
      await refresh();
      onChangedRef.current();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setToRemove(null);
    }
  }, [toRemove, refresh]);

  const modelNames = useMemo(() => new Map(models.map((m) => [m.id, m.name])), [models]);
  const installedIds = useMemo(() => new Set(installed.map((l) => l.id)), [installed]);
  const namesFor = (baseModels: readonly string[]) =>
    baseModels
      .map((id) => modelNames.get(id))
      .filter((name): name is string => name !== undefined)
      .join(', ');

  if (engineTooOld) {
    return (
      <div className="ollama-section">
        <h4>Styles and fast mode</h4>
        <p className="muted small">
          The image engine on this computer is older than this app. Update Gezel to add styles and
          fast mode.
        </p>
      </div>
    );
  }

  return (
    <>
      {pulls.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(pulls.values()).map((pull) => (
              <ImagePullProgress
                key={pull.id}
                pull={pull}
                onCancel={() => cancelPull(pull.id)}
                onRetry={() => retryPull(pull.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="ollama-section ollama-section--flat ollama-section--download">
        <h4>Styles and fast mode</h4>
        <p className="muted small">
          Fast mode draws a picture in a few steps instead of dozens. A style gives every picture
          you ask for in it the same look. Each one works with the models it names.
        </p>
        {error && <p className="error">{error}</p>}
        {installed.length > 0 && (
          <table className="ollama-model-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>For</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {installed.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="muted small">{PURPOSE_LABEL[l.purpose]}</td>
                  <td className="muted small">{namesFor(l.baseModels) || 'No installed model'}</td>
                  <td>{formatSize(l.approxSizeBytes)}</td>
                  <td>
                    <button
                      type="button"
                      className="gz-link-button"
                      onClick={() => setToRemove(l.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CatalogBrowser
          kind="image-lora"
          emptyMessage="No styles or fast mode for your models yet."
          filter={(item: CatalogItemSummary) =>
            item.manifest.kind === 'image-lora' &&
            (item.manifest as ImageLoraManifest).baseModels.some((id) => modelNames.has(id))
          }
          action={(item: CatalogItemSummary) => {
            if (item.manifest.kind !== 'image-lora') return null;
            const l = item.manifest as ImageLoraManifest;
            const already = installedIds.has(l.id);
            const active = pulls.get(l.id);
            const pct =
              active && active.totalBytes > 0
                ? Math.min(100, Math.round((active.bytesWritten / active.totalBytes) * 100))
                : null;
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <span>{PURPOSE_LABEL[l.purpose]}</span>
                    <span>·</span>
                    <span>For {namesFor(l.baseModels)}</span>
                    <span>·</span>
                    <span>{formatSize(l.approxSizeBytes)}</span>
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton manifest={l} />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={already || Boolean(active) || Boolean(disabledReason)}
                  title={disabledReason}
                  onClick={() => startPull(l.id)}
                >
                  {already
                    ? 'On device'
                    : active
                      ? pct !== null
                        ? `Downloading… ${pct}%`
                        : 'Downloading…'
                      : 'Get'}
                </button>
              </div>
            );
          }}
        />
      </div>

      <ConfirmDialog
        open={toRemove !== null}
        title="Remove this from the image engine?"
        message={
          toRemove
            ? `"${installed.find((l) => l.id === toRemove)?.name ?? toRemove}" will be removed from this computer. Get it again later to use it.`
            : ''
        }
        confirmLabel="Remove"
        danger
        onCancel={() => setToRemove(null)}
        onConfirm={confirmRemove}
      />
    </>
  );
}
