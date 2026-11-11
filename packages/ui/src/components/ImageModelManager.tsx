import type { CatalogItemSummary, ImageModelManifest, InstalledImageModel } from '@bendyline/gezel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AddModelDialog, HuggingFaceHostingNote, ModelListHeading } from './AddModelDialog.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ImageLoraManager } from './ImageLoraManager.js';
import { LicenseButton } from './LicenseButton.js';
import {
  type ImagePullEndpoints,
  ImagePullProgress,
  formatSize,
  useImagePulls,
} from './image-pulls.js';
import {
  HiddenModelsToggle,
  MediaFitNote,
  fitConfirmMessage,
  hiddenByFit,
  useMediaModelFit,
} from './media-model-fit.js';

/**
 * Install / pull / delete flow for `image-model` catalog entries.
 * Mirrors {@link OllamaModelManager}'s structure: a list of installed
 * models, the generic {@link CatalogBrowser} for the catalog picker,
 * and a per-entry action button wired to the pull SSE stream. Models the
 * daemon says this machine cannot run are hidden (docs/media-model-memory.md).
 */

/** The download: the weights plus every auxiliary file they need. */
function downloadBytes(m: ImageModelManifest): number {
  return m.approxSizeBytes + m.auxiliaryFiles.reduce((n, f) => n + f.approxSizeBytes, 0);
}

const MODEL_PULLS: ImagePullEndpoints = {
  list: () => api.listActiveImagePulls(),
  start: (id, onEvent, signal) => api.pullImageModel(id, onEvent, signal),
  subscribe: (id, onEvent, signal) => api.subscribeImagePull(id, onEvent, signal),
  cancel: (id) => api.cancelImagePull(id),
};

interface Props {
  /** When true, the Install button is disabled — e.g. no engine configured. */
  disabledReason?: string;
  /** Fired after an install / delete so the parent can refresh status pills. */
  onModelsChanged?: () => void;
  /**
   * The `config.defaultImageModel['sd-cpp']` value. Drives which installed
   * row is marked active. When {@link onSetActiveModel} is also supplied the
   * Local models table grows a leading radio column for picking it.
   */
  configuredDefaultModelId?: string;
  /** Persist a new default image model. Enables the active-model radios. */
  onSetActiveModel?: (id: string) => void | Promise<void>;
  /** `config.imageFastMode`: a model it omits has fast mode on. */
  fastMode?: Record<string, boolean>;
  /** Persist fast mode for one model. Enables the Fast mode column. */
  onFastModeChange?: (id: string, on: boolean) => void | Promise<void>;
}

export function ImageModelManager({
  disabledReason,
  onModelsChanged,
  configuredDefaultModelId,
  onSetActiveModel,
  fastMode,
  onFastModeChange,
}: Props) {
  const [installed, setInstalled] = useState<InstalledImageModel[]>([]);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const fit = useMediaModelFit('image');
  const [showAll, setShowAll] = useState(false);
  const [fitConfirm, setFitConfirm] = useState<{ id: string; message: string } | null>(null);
  const onModelsChangedRef = useRef(onModelsChanged);
  onModelsChangedRef.current = onModelsChanged;

  const refresh = useCallback(async () => {
    try {
      const res = await api.listInstalledImageModels();
      setInstalled(res.models);
      setInstalledError(null);
    } catch (err) {
      setInstalled([]);
      setInstalledError((err as Error).message);
    } finally {
      setInstalledLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { pulls, startPull, retryPull, cancelPull } = useImagePulls(MODEL_PULLS, () => {
    void refresh();
    onModelsChangedRef.current?.();
  });

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    try {
      await api.deleteImageModel(toDelete);
      await refresh();
      onModelsChanged?.();
    } catch (err) {
      setInstalledError((err as Error).message);
    } finally {
      setToDelete(null);
    }
  }, [toDelete, refresh, onModelsChanged]);

  const installedIds = useMemo(() => new Set(installed.map((m) => m.id)), [installed]);
  const hiddenCount = useMemo(
    () =>
      fit.byId
        ? [...fit.byId.values()].filter((f) => hiddenByFit(f) && !installedIds.has(f.id)).length
        : 0,
    [fit.byId, installedIds],
  );

  // The model sd-server actually binds: the configured default when it's
  // still installed, else the first installed model (the engine's own
  // fallback). The highlighted radio mirrors what a
  // generation would really load.
  // A model made only for editing never draws a new picture, so it is never
  // the active one (core `chooseImageModel`); an edit picks it on its own.
  const drawing = installed.filter((m) => !m.editOnly);
  const showActivePicker = Boolean(onSetActiveModel) && drawing.length > 0;
  const activeModelId =
    configuredDefaultModelId && drawing.some((m) => m.id === configuredDefaultModelId)
      ? configuredDefaultModelId
      : drawing[0]?.id;
  const fastModeFor = (m: InstalledImageModel) => m.loras?.find((l) => l.purpose === 'speed');
  const showFastMode = Boolean(onFastModeChange) && installed.some((m) => fastModeFor(m));
  const localModels = installed.filter((m) => m.kind !== 'cloud');

  return (
    <div className="ollama-model-manager">
      {pulls.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(pulls.values()).map((pull) => (
              <ImagePullProgress
                key={pull.id}
                pull={pull}
                onCancel={() => cancelPull(pull.id)}
                // The shared downloader picks up from the existing
                // `.partial` so the user doesn't restart at zero.
                onRetry={() => retryPull(pull.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="ollama-section">
        <ModelListHeading title="Local models" onAdd={() => setAddOpen(true)} />
        {installedError && <p className="error">{installedError}</p>}
        {installedLoaded && !installedError && installed.length === 0 && (
          <p className="muted small">No models on this device yet.</p>
        )}
        {showActivePicker && installed.length > 1 && (
          <p className="muted small">
            The <strong>active</strong> model is what an image generator and the{' '}
            <code>render_image</code> tool use by default. Gezel can still ask for a specific model
            per image; switching reloads the engine, which takes a moment.
          </p>
        )}
        {installed.length > 0 && (
          // Up to six columns do not fit a phone's panel; the table scrolls inside it.
          <div className="ollama-model-table-wrap">
            <table className="ollama-model-table">
              <thead>
                <tr>
                  {showActivePicker && (
                    <th scope="col" className="gz-active-model-column">
                      Active
                    </th>
                  )}
                  <th>Name</th>
                  {showFastMode && <th scope="col">Fast mode</th>}
                  <th>Size</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {installed.map((m) => (
                  <tr key={m.id}>
                    {showActivePicker && (
                      <td className="gz-active-model-column">
                        {m.editOnly ? (
                          <span
                            className="muted small"
                            title="Changes a picture you give it; never draws a new one"
                          >
                            Edits
                          </span>
                        ) : (
                          <input
                            type="radio"
                            name="active-image-model"
                            className="gz-active-model-radio"
                            aria-label={`Use ${m.name} as the active image model`}
                            checked={activeModelId === m.id}
                            onChange={() => {
                              // Re-selecting the active model would still reset the
                              // provider and cold-reload a warm engine — no-op it.
                              if (activeModelId !== m.id) void onSetActiveModel?.(m.id);
                            }}
                          />
                        )}
                      </td>
                    )}
                    <td>{m.name}</td>
                    {showFastMode && (
                      <td>
                        {fastModeFor(m) && (
                          <input
                            type="checkbox"
                            aria-label={`Fast mode for ${m.name}`}
                            title={`Draws in ${fastModeFor(m)?.steps ?? 'a few'} steps`}
                            checked={fastMode?.[m.id] !== false}
                            onChange={(e) => void onFastModeChange?.(m.id, e.target.checked)}
                          />
                        )}
                      </td>
                    )}
                    <td>{formatSize(m.approxSizeBytes)}</td>
                    <td className="muted small">{new Date(m.installedAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        type="button"
                        className="gz-link-button"
                        onClick={() => setToDelete(m.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {localModels.length > 0 && (
        <ImageLoraManager
          models={localModels}
          {...(disabledReason ? { disabledReason } : {})}
          onChanged={() => {
            void refresh();
            onModelsChangedRef.current?.();
          }}
        />
      )}

      <AddModelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        description={<HuggingFaceHostingNote />}
      >
        <HiddenModelsToggle
          hiddenCount={hiddenCount}
          showAll={showAll}
          onToggle={() => setShowAll((v) => !v)}
        />
        <CatalogBrowser
          kind="image-model"
          emptyMessage="No image models in the catalog yet. Remote catalog sources can add entries without an app update."
          filter={(item: CatalogItemSummary) =>
            showAll ||
            installedIds.has(item.manifest.id) ||
            !hiddenByFit(fit.byId?.get(item.manifest.id))
          }
          action={(item: CatalogItemSummary) => {
            if (item.manifest.kind !== 'image-model') return null;
            const m = item.manifest as ImageModelManifest;
            const already = installedIds.has(m.id);
            const active = pulls.get(m.id);
            const pulling = Boolean(active);
            const pct =
              active && active.totalBytes > 0
                ? Math.min(100, Math.round((active.bytesWritten / active.totalBytes) * 100))
                : null;
            const modelFit = fit.byId?.get(m.id);
            const tooLarge = !already && hiddenByFit(modelFit);
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <code>{m.id}</code>
                    <span>·</span>
                    <span>{formatSize(downloadBytes(m))}</span>
                    {m.quantization && (
                      <>
                        <span>·</span>
                        <span>{m.quantization}</span>
                      </>
                    )}
                    <MediaFitNote fit={modelFit} />
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton manifest={m} />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={already || pulling || tooLarge || Boolean(disabledReason)}
                  title={(tooLarge ? modelFit?.reason : disabledReason) ?? undefined}
                  onClick={() => {
                    const message = fitConfirmMessage(m.name, modelFit, downloadBytes(m));
                    if (message) setFitConfirm({ id: m.id, message });
                    else void startPull(m.id);
                  }}
                >
                  {already
                    ? 'On device'
                    : pulling
                      ? pct !== null
                        ? `Downloading… ${pct}%`
                        : 'Downloading…'
                      : tooLarge
                        ? 'Too large'
                        : 'Download'}
                </button>
              </div>
            );
          }}
        />
      </AddModelDialog>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete image model?"
        message={
          toDelete
            ? `"${installed.find((m) => m.id === toDelete)?.name ?? toDelete}" will be removed from local storage. This frees disk space; download it again later to use it.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={fitConfirm !== null}
        title="This model may not fit"
        message={fitConfirm?.message}
        confirmLabel="Download anyway"
        onCancel={() => setFitConfirm(null)}
        onConfirm={() => {
          if (fitConfirm) void startPull(fitConfirm.id);
          setFitConfirm(null);
        }}
      />
    </div>
  );
}
