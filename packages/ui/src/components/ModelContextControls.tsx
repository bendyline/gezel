/**
 * Per-model row controls for the Local models lists: the "…" actions menu
 * and the context-size editor it opens.
 *
 * The menu replaces the flat fitness / Export / Update / Delete link run so
 * row actions don't turn every model into a toolbar. The context editor
 * is the third user of the shared `.gz-budget-slider` recipe (see the CSS
 * comment in styles/village-and-overview.css) and follows the
 * EngineMemoryBudgetPanel pattern:
 * a draft that is `null` while following automatic, an "Auto" marker tick
 * on the track, explicit Save, and a first-class "Back to automatic".
 *
 * Engine-generic: every engine carries a KV linearization so the memory
 * readout moves live while the slider drags. ds4's comes from its catalog
 * entry rather than a GGUF header, and is far shallower than a llama.cpp-class
 * KV because cold context spills to SSD. A row with no linearization at all
 * (an unmeasured ds4 entry, an older daemon) says so instead of pretending a
 * number.
 */

import { estimateLlamaCppResidentBytes } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { announceModelInventoryChanged } from '../model-inventory.js';
import { DropdownMenu } from '../primitives/index.js';
import { ModelBundleExportProgressDialog, useExportModelBundle } from './ModelBundleControls.js';
import { formatContextWindow } from './model-context.js';
import { formatBytes } from './model-memory-copy.js';

export type ContextEngine = 'llama-cpp' | 'mlx' | 'ds4';

/** The row fields these controls need — the shared subset of the three engines' model shapes. */
export interface ContextControlModel {
  id: string;
  approxSizeBytes: number;
  /** Projector size on a multimodal llama.cpp model — not part of `approxSizeBytes`. */
  mmprojSizeBytes?: number;
  contextWindow?: number;
  effectiveContextWindow?: number;
  overrideContextTokens?: number;
  autoContextWindow?: number;
  kvBytesPerTokenPerSlot?: number;
  kvFixedBytesPerSlot?: number;
  weightsResidentBytes?: number;
  plannedSlots?: number;
  contextCeilingTokens?: number;
  readOnly?: boolean;
  updateAvailable?: boolean;
  availableVersion?: string;
}

export const CONTEXT_SLIDER_MIN = 32_768;
const CONTEXT_SLIDER_STEP = 8_192;

/**
 * The slider's max: the advertised native window, except ds4 rows where the
 * catalog launch ceiling wins (ds4 has no memory admission to catch a
 * window the engine can't actually serve). Undefined = no slider room, so
 * the menu item disables.
 */
export function contextSliderMax(model: ContextControlModel): number | undefined {
  const max = model.contextCeilingTokens ?? model.contextWindow;
  return max !== undefined && max > CONTEXT_SLIDER_MIN ? max : undefined;
}

export function ModelActionsMenu({
  engine,
  model,
  updating = false,
  contextSupported,
  contextEditorOpen,
  onToggleContextEditor,
  fitnessAction,
  onUpdate,
  updateLabel = { idle: 'Update', busy: 'Updating…' },
  onDelete,
}: {
  engine: ContextEngine;
  model: ContextControlModel;
  updating?: boolean;
  /** False when the daemon/broker predates the override endpoints — the item hides. */
  contextSupported: boolean;
  contextEditorOpen: boolean;
  onToggleContextEditor: () => void;
  fitnessAction?: { label: string; checking?: boolean; onRun: () => void };
  onUpdate?: () => void;
  /** MLX says "Download again" for a stale catalog install; same action slot. */
  updateLabel?: { idle: string; busy: string };
  onDelete?: () => void;
}) {
  const exporter = useExportModelBundle(engine, model.id);
  const sliderMax = contextSliderMax(model);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="model-actions-trigger"
            aria-label={`Actions for ${model.id}`}
            title="Model actions"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
            {contextSupported && (
              <DropdownMenu.Item
                className="app-nav-menu-item"
                disabled={sliderMax === undefined}
                title={
                  sliderMax === undefined
                    ? 'This model does not advertise a context window large enough to adjust.'
                    : undefined
                }
                onSelect={() => onToggleContextEditor()}
              >
                {contextEditorOpen ? 'Hide context size' : 'Context size…'}
              </DropdownMenu.Item>
            )}
            {fitnessAction && (
              <DropdownMenu.Item
                className="app-nav-menu-item"
                disabled={fitnessAction.checking}
                title="Run the fitness check (proeve): startup and decode speed with representative context, tool round-trip, reasoning budget, and context fit."
                onSelect={() => fitnessAction.onRun()}
              >
                {fitnessAction.label}
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="app-nav-menu-item"
              disabled={exporter.busy}
              onSelect={() => void exporter.run()}
            >
              {exporter.busy ? 'Exporting…' : 'Export'}
            </DropdownMenu.Item>
            {model.updateAvailable && onUpdate && (
              <DropdownMenu.Item
                className="app-nav-menu-item"
                disabled={updating}
                title={
                  model.availableVersion
                    ? `Re-download the current build (→ v${model.availableVersion}) and replace in place.`
                    : 'Re-download the current build and replace in place.'
                }
                onSelect={() => onUpdate()}
              >
                {updating ? updateLabel.busy : updateLabel.idle}
              </DropdownMenu.Item>
            )}
            {!model.readOnly && onDelete && (
              <DropdownMenu.Item className="app-nav-menu-item danger" onSelect={() => onDelete()}>
                Delete
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {exporter.error && <span className="error small">{exporter.error}</span>}
      <ModelBundleExportProgressDialog
        state={exporter.progress}
        canceling={exporter.canceling}
        onCancel={exporter.cancel}
        onDismiss={exporter.dismissProgress}
      />
    </>
  );
}

function clampTokens(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function ModelContextSliderPanel({
  engine,
  model,
  onSaved,
}: {
  engine: ContextEngine;
  model: ContextControlModel;
  onSaved?: () => void | Promise<void>;
}) {
  // null = follow automatic; a number = explicit slider position.
  const [draft, setDraft] = useState<number | null>(model.overrideContextTokens ?? null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fastPool, setFastPool] = useState<{ fastBytes: number; committedBytes: number } | null>(
    null,
  );

  // Adopt an override saved from another window (or cleared server-side).
  useEffect(() => {
    setDraft(model.overrideContextTokens ?? null);
  }, [model.overrideContextTokens]);

  // One snapshot for the over-fit warning; the models list itself re-prices
  // the row after a save, so this doesn't need to poll. THIS model's own
  // resident reservation must not count against the pool it would occupy —
  // a loaded model otherwise makes its own slider report "bigger than what
  // fits" at the automatic position.
  useEffect(() => {
    let cancelled = false;
    void api
      .getEngineStatus()
      .then((status) => {
        if (cancelled) return;
        const fastBytes = status.pools?.fastBytes;
        if (fastBytes && fastBytes > 0) {
          const ownResidentBytes = (status.entries ?? [])
            .filter((entry) => entry.provider === engine && entry.modelId === model.id)
            .reduce((sum, entry) => sum + entry.residentBytes, 0);
          setFastPool({
            fastBytes,
            committedBytes: Math.max(0, (status.committedBytes ?? 0) - ownResidentBytes),
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [engine, model.id]);

  const save = useCallback(
    async (tokens: number | null) => {
      setSaving(true);
      setMessage(null);
      try {
        await api.updateModelContextOverride(engine, model.id, tokens);
        setMessage(
          tokens === null
            ? 'Back to automatic — applies when the model next starts.'
            : 'Saved — applies when the model next starts.',
        );
        announceModelInventoryChanged(engine);
        await onSaved?.();
      } catch (err) {
        setMessage(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [engine, model.id, onSaved],
  );

  const sliderMax = contextSliderMax(model);
  if (sliderMax === undefined) return null;
  const min = CONTEXT_SLIDER_MIN;
  const autoTokens =
    model.overrideContextTokens !== undefined
      ? model.autoContextWindow
      : model.effectiveContextWindow;
  const value = clampTokens(
    draft ?? model.overrideContextTokens ?? autoTokens ?? min,
    min,
    sliderMax,
  );
  const onAuto =
    draft === null ||
    (autoTokens !== undefined && Math.abs(draft - autoTokens) < CONTEXT_SLIDER_STEP);
  const current = model.overrideContextTokens ?? null;
  const dirty = (onAuto ? null : value) !== current;
  const markerPct =
    autoTokens !== undefined
      ? ((clampTokens(autoTokens, min, sliderMax) - min) / Math.max(1, sliderMax - min)) * 100
      : undefined;

  // Live footprint at the dragged window: weights + fixed + slope × ctx for
  // one slot (matches the SIZE column's "in memory" headline), and the full
  // slot-fleet reservation for the over-fit check.
  const kvPerToken = model.kvBytesPerTokenPerSlot;
  const weightsBytes =
    model.weightsResidentBytes ??
    estimateLlamaCppResidentBytes(model.approxSizeBytes, { mmprojBytes: model.mmprojSizeBytes });
  const kvFixed = model.kvFixedBytesPerSlot ?? 0;
  const singleBytes =
    kvPerToken !== undefined ? weightsBytes + kvFixed + kvPerToken * value : undefined;
  const slots = model.plannedSlots ?? 1;
  const reservedBytes =
    kvPerToken !== undefined ? weightsBytes + slots * (kvFixed + kvPerToken * value) : undefined;
  const overFit =
    fastPool !== null &&
    reservedBytes !== undefined &&
    reservedBytes > Math.max(0, fastPool.fastBytes - fastPool.committedBytes);

  return (
    <div className="model-context-editor">
      <div className="gz-budget-slider">
        <div className="gz-budget-slider-head">
          <strong title={`${value.toLocaleString()} tokens per turn`}>
            {formatContextWindow(value)} context
          </strong>
          {onAuto ? (
            <span className="gz-budget-tag">Automatic</span>
          ) : (
            <span
              className={`gz-budget-tag ${overFit ? 'gz-budget-tag-risky' : 'gz-budget-tag-custom'}`}
            >
              {overFit ? 'Bigger than what fits' : 'Custom'}
            </span>
          )}
          {singleBytes !== undefined && (
            <span className="muted small model-context-editor-estimate">
              ~{formatBytes(singleBytes)} in memory
              {slots > 1 && reservedBytes !== undefined
                ? ` · ~${formatBytes(reservedBytes)} serving ${slots} chats at once`
                : ''}
            </span>
          )}
        </div>
        <div className="gz-budget-track">
          <input
            type="range"
            min={min}
            max={sliderMax}
            step={CONTEXT_SLIDER_STEP}
            value={value}
            aria-label={`Context size for ${model.id}`}
            onChange={(e) => setDraft(Number.parseInt(e.target.value, 10))}
          />
          {markerPct !== undefined && (
            <div
              className="gz-budget-marker"
              style={{ left: `${markerPct}%` }}
              title={`Automatic sizing grants ${formatContextWindow(autoTokens)} on this machine right now`}
              aria-hidden="true"
            >
              <span className="gz-budget-marker-arrow">▲</span>
              <span className="gz-budget-marker-label">
                Auto · {formatContextWindow(autoTokens)}
              </span>
            </div>
          )}
        </div>
        <div className="gz-budget-scale muted small">
          <span>{formatContextWindow(min)}</span>
          <span>{formatContextWindow(sliderMax)}</span>
        </div>
      </div>

      {kvPerToken === undefined && engine === 'ds4' && (
        <p className="muted small">
          Nobody has measured this model's memory-per-token yet, so the footprint above can't be
          re-priced as you drag. Cold context streams to disk, so expect it to move far less than
          the window does.
        </p>
      )}
      {kvPerToken !== undefined && engine === 'ds4' && (
        <p className="muted small">
          ds4 streams cold context to disk, so only part of the window stays resident —
          {` ${formatBytes(kvPerToken * 1024)} per 1K tokens`} for this model.
        </p>
      )}
      {overFit && (
        <output className="muted small model-context-editor-warning">
          Bigger than what fits right now — Gezel will grant as much as memory safely allows and the
          Context size column shows the result.
        </output>
      )}

      <div className="model-context-editor-actions">
        <button
          type="button"
          onClick={() => void save(onAuto ? null : value)}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {current !== null && (
          <button type="button" onClick={() => void save(null)} disabled={saving}>
            Back to automatic
          </button>
        )}
      </div>

      {message && <p className="muted small model-context-editor-message">{message}</p>}
    </div>
  );
}
