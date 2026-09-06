import type { CatalogItemSummary, ChatModelCategory, ChatModelManifest } from '@bendyline/gezel';
import { isRetiredModel } from '@bendyline/gezel';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { HuggingFaceRepoLink, huggingFaceRepoUrl } from './HuggingFaceRepoLink.js';
import { IncompleteDownloads } from './IncompleteDownloads.js';
import { InstallProgressRow } from './InstallProgressRow.js';
import { LicenseButton } from './LicenseButton.js';
import { ImportModelBundleButton } from './ModelBundleControls.js';
import { ModelActionsMenu, ModelContextSliderPanel } from './ModelContextControls.js';
import { ModelFitnessCell, fitnessMenuAction } from './ModelFitnessCell.js';
import { ModelSizeCell } from './ModelSizeCell.js';
import { SharedModelMigrationPanel } from './SharedModelMigrationPanel.js';
import { UnrecognizedModels } from './UnrecognizedModels.js';
import { mlxFitsMemoryBudget } from './mlx-model-fit.js';
import { formatContextWindow } from './model-context.js';
import { mlxModelAdapter } from './model-management-adapters.js';
import { formatBytes } from './model-memory-copy.js';
import { approximateQuantizationLabel, quantizationTitle } from './model-quantization.js';
import { useLocalModelManager } from './use-local-model-manager.js';
import type { ActiveModelInstall as ActiveInstall } from './use-model-installs.js';

interface MemoryProfile {
  totalRamBytes: number;
  gpuVramBytes: number | null;
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'gpu-integrated' | 'system-ram-fallback';
  usableBytes: number;
}

function formatApprox(bytes: number): string {
  return `~${formatBytes(bytes)}`;
}

function formatReleased(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

function asMlxEntry(
  m: CatalogItemSummary['manifest'],
): (ChatModelManifest & { mlx: NonNullable<ChatModelManifest['mlx']> }) | null {
  if (m.kind !== 'chat-model') return null;
  // No mlx build, or a build flagged as known-broken on MLX via
  // `disabledReason` — not offered in the MLX picker. The model may still be
  // installable via llama.cpp.
  if (!m.mlx || m.mlx.disabledReason) return null;
  return m as ChatModelManifest & { mlx: NonNullable<ChatModelManifest['mlx']> };
}

const TAG_TOOLTIPS: Record<string, string> = {
  'mix of experts':
    "Only a fraction of the model's parameters run per token, so it's faster than a dense model of the same nominal size.",
  vision: 'Can accept images alongside text.',
  tools: 'Supports function/tool calling via the API.',
  multimodal: 'Handles multiple input types (text + images).',
  large: 'Heavy model — needs a lot of memory and runs more slowly.',
  small: 'Compact model — runs quickly on modest hardware.',
};

interface Props {
  onModelsChanged?: () => void;
  compact?: boolean;
}

type CategoryTab = ChatModelCategory | 'all';

/**
 * MLX local model install/list/delete UX. Structural twin of
 * LlamaCppModelManager — same CatalogBrowser, same InstallProgress,
 * same memory-budget filter — pointed at /api/mlx/* with the `mlx`
 * source block.
 */
export function MlxModelManager({ onModelsChanged, compact = false }: Props) {
  const {
    models,
    modelsError,
    incomplete,
    unrecognized,
    installs,
    installWarning,
    setInstallWarning,
    installError,
    setInstallError,
    installMismatch,
    setInstallMismatch,
    toDelete,
    setToDelete,
    fitness,
    probing,
    refreshFitness,
    refresh,
    deleteOne,
    startInstall,
    retryInstall,
    cancelInstall,
    downloadAnyway,
  } = useLocalModelManager(mlxModelAdapter, onModelsChanged);
  const [memory, setMemory] = useState<MemoryProfile | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('all');
  // Which model row has the context-size editor expanded beneath it.
  const [contextEditorFor, setContextEditorFor] = useState<string | null>(null);
  // False until the override endpoint answers — an older daemon or machine
  // broker 404s and the affordance hides rather than erroring per row.
  const [contextOverridesSupported, setContextOverridesSupported] = useState(false);
  const [catalogItems, setCatalogItems] = useState<CatalogItemSummary[]>([]);
  useEffect(() => {
    void api
      .getMemoryProfile()
      .then((m) => setMemory(m as MemoryProfile))
      .catch(() => {});
    void api
      .getModelContextOverrides('mlx')
      .then(() => setContextOverridesSupported(true))
      .catch(() => setContextOverridesSupported(false));
  }, []);

  const installedIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);
  const attentionIds = useMemo(
    () => new Set(unrecognized.map((model) => model.id)),
    [unrecognized],
  );

  const availableCategories = useMemo<CategoryTab[]>(() => {
    const present = new Set<ChatModelCategory>();
    for (const item of catalogItems) {
      const m = asMlxEntry(item.manifest);
      if (!m) continue;
      present.add(m.category ?? 'general');
    }
    const order: ChatModelCategory[] = ['general', 'coding', 'reasoning', 'vision', 'embedding'];
    return ['all' as CategoryTab, ...order.filter((c) => present.has(c))];
  }, [catalogItems]);

  return (
    <div className="ollama-model-manager">
      {installs.size > 0 && (
        <div className="ollama-section">
          <h4>Downloading…</h4>
          <div className="ollama-pull-list">
            {Array.from(installs.values()).map((inst) => (
              <InstallProgress
                key={inst.catalogId}
                inst={inst}
                onCancel={() => cancelInstall(inst.catalogId)}
                onRetry={() => retryInstall(inst.catalogId)}
              />
            ))}
          </div>
        </div>
      )}

      <UnrecognizedModels
        items={unrecognized.filter((model) => !installs.has(model.id))}
        onUpdate={(id) => startInstall(id)}
        onRemove={(id) => setToDelete(id)}
      />

      <IncompleteDownloads
        items={incomplete.filter((d) => !installs.has(d.id))}
        onResume={(id) => startInstall(id)}
        onDelete={(id) => setToDelete(id)}
      />

      {installMismatch && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            ⚠ <code>{installMismatch.catalogId}</code> is newer on Hugging Face than the version
            Gezel knows about
          </div>
          <p style={{ marginBottom: '0.5rem' }}>
            The file <code>{installMismatch.file}</code> changed upstream, so its checksum no longer
            matches what this version of Gezel pinned. This is almost always a harmless upstream fix
            — model authors routinely re-publish chat templates and tokenizer configs — but we can't
            verify it automatically. You can download the current version now, or wait for a Gezel
            update with a refreshed catalog.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="gz-link-button"
              onClick={() => downloadAnyway(installMismatch.catalogId)}
            >
              Download anyway
            </button>
            <button
              type="button"
              className="gz-link-button"
              onClick={() => setInstallMismatch(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {installError && (
        <div className="ollama-section">
          <p className="error" style={{ marginBottom: '0.5rem' }}>
            {installError}
          </p>
        </div>
      )}

      {installWarning && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            ⚠ {installWarning.id}: {installWarning.message}
          </div>
        </div>
      )}

      {!compact && <SharedModelMigrationPanel engine="mlx" onModelsChanged={onModelsChanged} />}

      {(models.length > 0 || modelsError) && (
        <div className="ollama-section">
          <h4>{compact ? 'Models on this device' : 'Local models'}</h4>
          {modelsError && <p className="error">{modelsError}</p>}
          {models.length > 0 && (
            <div className="ollama-model-table-wrap">
              <table className="ollama-model-table">
                <colgroup>
                  <col className="model-name-column" />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Quant</th>
                    <th title="Effective per-turn context size after Gezel's configured limit">
                      Context size
                    </th>
                    <th title="Representative startup and decode speed with an approximately 20K-token prompt">
                      Fitness
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const outOfDate = m.updateAvailable === true;
                    const reinstalling = Boolean(installs.get(m.id));
                    const fitnessKey = `mlx:${m.id}`;
                    const entry = fitness.get(fitnessKey);
                    return (
                      <Fragment key={m.id}>
                        <tr>
                          <td className="model-name-table-cell">
                            <div className="model-name-cell">
                              <code>{m.id}</code>
                              <div className="model-name-meta">
                                {outOfDate && (
                                  <span
                                    className="gz-status-pill gz-status-pill--warn"
                                    title={
                                      m.updateReason ??
                                      'The catalog ships different model files than the copy on disk. Update to pick them up.'
                                    }
                                  >
                                    out of date
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <ModelSizeCell model={m} />
                          <td title={quantizationTitle(m.quantization)}>
                            {approximateQuantizationLabel(m.quantization)}
                          </td>
                          <td
                            title={
                              m.effectiveContextWindow
                                ? m.overrideContextTokens !== undefined
                                  ? `You've set this model to ${m.overrideContextTokens.toLocaleString()} tokens per turn; Gezel grants up to what memory allows (currently ${m.effectiveContextWindow.toLocaleString()}).`
                                  : `Gezel will grant up to ${m.effectiveContextWindow.toLocaleString()} tokens per turn${m.contextWindow ? `; the model advertises ${m.contextWindow.toLocaleString()} tokens` : ''}.`
                                : m.contextSizingStatus === 'restart-required'
                                  ? 'This model is running with a different context window than the current sizing settings resolve to. Restart the local engine (or let it go idle) so Gezel can re-admit it — no memory change needed.'
                                  : m.contextSizingStatus === 'insufficient-memory'
                                    ? 'The requested context window does not fit in memory safely. Unload another model or free memory before trying again.'
                                    : 'The effective context size is unavailable.'
                            }
                          >
                            {m.contextSizingStatus === 'restart-required' ? (
                              'Restart needed'
                            ) : m.contextSizingStatus === 'insufficient-memory' ? (
                              "Won't fit"
                            ) : (
                              <>
                                {formatContextWindow(m.effectiveContextWindow)}
                                {m.overrideContextTokens !== undefined && (
                                  <span className="gz-budget-tag gz-budget-tag-custom model-context-custom-tag">
                                    custom
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <ModelFitnessCell entry={entry} probing={probing.includes(fitnessKey)} />
                          <td className="model-actions-table-cell">
                            <div className="model-actions-cell">
                              <div className="model-action-status">
                                {m.readOnly && (
                                  <span
                                    className="muted small"
                                    title="Provided by the machine-wide install (shared asset store). It can't be removed from here — manage it with the machine installer, or install a user-owned copy to shadow it."
                                  >
                                    Machine model
                                  </span>
                                )}
                              </div>
                              <div className="model-action-links">
                                <ModelActionsMenu
                                  engine="mlx"
                                  model={{ ...m, updateAvailable: outOfDate }}
                                  updating={reinstalling}
                                  contextSupported={contextOverridesSupported}
                                  contextEditorOpen={contextEditorFor === m.id}
                                  onToggleContextEditor={() =>
                                    setContextEditorFor((prev) => (prev === m.id ? null : m.id))
                                  }
                                  fitnessAction={fitnessMenuAction(
                                    entry,
                                    probing.includes(fitnessKey),
                                    () => {
                                      void api
                                        .runModelFitnessProbe('mlx', m.id)
                                        .then(() => refreshFitness())
                                        .catch(() => {});
                                    },
                                  )}
                                  onUpdate={() => startInstall(m.id)}
                                  updateLabel={{ idle: 'Download again', busy: 'Downloading…' }}
                                  onDelete={() => setToDelete(m.id)}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                        {contextEditorFor === m.id && (
                          <tr className="model-context-editor-row">
                            <td colSpan={6}>
                              <ModelContextSliderPanel engine="mlx" model={m} onSaved={refresh} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="ollama-section ollama-section--flat ollama-section--download">
        <h4>Download a model</h4>
        <p className="muted small" style={{ marginTop: 0 }}>
          Models are hosted by{' '}
          <a
            href="https://huggingface.co"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit' }}
          >
            Hugging Face
          </a>
          , a community library of open, freely available AI models. Your device downloads them
          directly.
        </p>
        <p className="muted small">
          {memory
            ? 'Models that may not fit this machine, and retired models, are hidden by default. '
            : 'Retired models are hidden by default. '}
          <button
            type="button"
            className="gz-link-button"
            onClick={() => setShowAll((v) => !v)}
            style={{ padding: 0 }}
          >
            {showAll
              ? memory
                ? 'Hide retired and oversized models'
                : 'Hide retired models'
              : 'Show all models'}
          </button>
        </p>
        <div className="provider-switch" style={{ marginBottom: '0.5rem' }}>
          {availableCategories.map((c) => (
            <button
              key={c}
              type="button"
              className={`provider-pill${activeCategory === c ? ' provider-pill-active' : ''}`}
              onClick={() => setActiveCategory(c)}
            >
              {c === 'all' ? 'All' : c[0]?.toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
        <CatalogBrowser
          kind="chat-model"
          emptyMessage="No MLX-format entries in the catalog yet."
          onItemsLoaded={setCatalogItems}
          tagTooltips={TAG_TOOLTIPS}
          filter={(item: CatalogItemSummary) => {
            const m = asMlxEntry(item.manifest);
            if (!m) return false;
            if (!showAll && isRetiredModel(m)) return false;
            if (activeCategory !== 'all' && (m.category ?? 'general') !== activeCategory) {
              return false;
            }
            if (!showAll && memory) {
              if (!mlxFitsMemoryBudget(m.mlx, memory.usableBytes)) {
                return false;
              }
            }
            return true;
          }}
          action={(item: CatalogItemSummary) => {
            const m = asMlxEntry(item.manifest);
            if (!m) return null;
            const installed = installedIds.has(m.id);
            const needsAttention = attentionIds.has(m.id);
            const inflight = installs.get(m.id);
            const pct =
              inflight && inflight.totalBytes > 0
                ? Math.min(100, Math.round((inflight.bytesWritten / inflight.totalBytes) * 100))
                : null;
            const tight = memory ? !mlxFitsMemoryBudget(m.mlx, memory.usableBytes) : false;
            return (
              <div className="catalog-ollama-action">
                <div className="catalog-ollama-meta">
                  <div className="catalog-ollama-specs muted small">
                    <HuggingFaceRepoLink repo={m.mlx.huggingfaceRepo} />
                    <span>·</span>
                    <span>{m.parameterSize}</span>
                    <span>·</span>
                    <span>{formatApprox(m.mlx.approxSizeBytes)}</span>
                    {formatReleased(m.releasedAt) && (
                      <>
                        <span>·</span>
                        <span>{formatReleased(m.releasedAt)}</span>
                      </>
                    )}
                  </div>
                  <div className="catalog-ollama-pills">
                    <LicenseButton
                      manifest={m}
                      fallbackHref={huggingFaceRepoUrl(m.mlx.huggingfaceRepo)}
                    />
                    {tight && (
                      <span
                        className="gz-status-pill gz-status-pill--warn"
                        title="Larger than your estimated inference budget — may run slowly or fail."
                      >
                        may not fit
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={installed || needsAttention || Boolean(inflight)}
                  onClick={() => startInstall(m.id)}
                >
                  {installed
                    ? 'On device'
                    : inflight
                      ? inflight.phase === 'downloading'
                        ? pct !== null
                          ? `Downloading… ${pct}%`
                          : 'Downloading…'
                        : inflight.phase === 'verifying'
                          ? 'Verifying…'
                          : 'Reading metadata…'
                      : needsAttention
                        ? 'Needs attention above'
                        : 'Download'}
                </button>
              </div>
            );
          }}
        />
      </div>

      <div className="ollama-section ollama-section--flat">
        <ImportModelBundleButton />
        <span className="muted small" style={{ marginLeft: '0.75rem' }}>
          Import from a gezel local model package
        </span>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete ${toDelete ?? ''}?`}
        message="This removes the downloaded model from your device. It stays available in the catalog — you can download it again any time."
        confirmLabel="Delete"
        danger
        onConfirm={deleteOne}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}

function InstallProgress({
  inst,
  onCancel,
  onRetry,
}: {
  inst: ActiveInstall;
  onCancel: () => void;
  /** Re-kicks the install. The shared downloader resumes from the
   *  existing `.partial` so this isn't a full restart. */
  onRetry: () => void;
}) {
  const known = inst.totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((inst.bytesWritten / inst.totalBytes) * 100)) : 0;
  // Status precedence: hard error > retrying-between-attempts > normal phase.
  let phaseLabel: string;
  if (inst.error) {
    phaseLabel = inst.error;
  } else if (inst.retrying) {
    const delaySec = Math.max(1, Math.round(inst.retrying.delayMs / 1000));
    const shardHint = inst.fileCount > 1 ? ` on shard ${inst.fileIndex}/${inst.fileCount}` : '';
    phaseLabel = `${inst.retrying.reason}${shardHint} — retrying in ${delaySec}s (attempt ${inst.retrying.attempt}/${inst.retrying.maxAttempts})`;
  } else if (inst.phase === 'downloading') {
    phaseLabel = known
      ? `Downloading ${formatBytes(inst.bytesWritten)} of ${formatBytes(inst.totalBytes)} (${pct}%)`
      : inst.bytesWritten > 0
        ? `Downloading ${formatBytes(inst.bytesWritten)}…`
        : 'Preparing download…';
  } else if (inst.phase === 'verifying') {
    phaseLabel = `Checking download${inst.file ? ` (${inst.file})` : '…'}`;
  } else {
    phaseLabel = 'Reading model info…';
  }
  const indeterminate = inst.phase !== 'downloading' || !known;
  return (
    <InstallProgressRow
      title={<code>{inst.catalogId}</code>}
      status={phaseLabel}
      percent={indeterminate ? null : pct}
      tone={inst.error ? 'error' : inst.retrying ? 'warning' : 'normal'}
      onCancel={onCancel}
      onRetry={onRetry}
    />
  );
}
