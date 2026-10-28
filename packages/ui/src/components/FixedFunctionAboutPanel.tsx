import {
  type GezelDetail,
  IMAGE_ASPECT_RATIOS,
  type ImageAspectRatio,
  type ImageQuality,
  type InstalledImageModel,
  imageSizeSettingsFrom,
} from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import { ASPECT_RATIO_NAMES } from './composer-image-settings.js';

interface FixedFunctionAboutPanelProps {
  gezel: GezelDetail;
  onUpdated: (gezel: GezelDetail) => void;
}

/**
 * Replacement for the about.md editor on fixed-function gezels.
 * These gezels have no system prompt — the chat path forwards the
 * user's message text straight to the named MCP tool and surfaces
 * the result. So instead of an editor we show:
 *
 *   - A "Forwards to: …" line naming the wired MCP tool.
 *   - The template's user-facing description.
 *   - A JSON textarea for editing the tool's `defaults` map (width,
 *     height, model, etc.). v1 keeps this as a plain JSON editor;
 *     a future revision can replace it with a schema-driven form
 *     once the service exposes a tool-schema lookup endpoint.
 */
export function FixedFunctionAboutPanel({ gezel, onUpdated }: FixedFunctionAboutPanelProps) {
  const ff = gezel.fixedFunction;
  const initial = ff?.defaults ? JSON.stringify(ff.defaults, null, 2) : '';
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Reset draft when a different gezel is selected. The textarea is
  // intentionally NOT auto-synced to subsequent prop updates from
  // an outer remount — once the user is editing, they own the
  // value until they click Save (or they navigate away). Out-of-
  // band defaults changes would only realistically come from the
  // user themselves anyway (via a second tab or the MCP tool).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional id-only dep
  useEffect(() => {
    setDraft(initial);
    setDirty(false);
    setError(null);
    setStatus(null);
  }, [gezel.id]);

  const saveDefaults = useCallback(
    async (next: Record<string, unknown> | null) => {
      setBusy(true);
      try {
        const updated = await api.updateGezelFixedFunctionDefaults(gezel.id, {
          defaults: next && Object.keys(next).length > 0 ? next : null,
        });
        onUpdated(updated);
        const saved = updated.fixedFunction?.defaults;
        setDraft(saved ? JSON.stringify(saved, null, 2) : '');
        setDirty(false);
        setStatus('Saved');
      } catch (err) {
        setError(`Save failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [gezel.id, onUpdated],
  );

  const save = useCallback(async () => {
    setError(null);
    setStatus(null);
    let parsed: Record<string, unknown> | null = null;
    if (draft.trim()) {
      try {
        const value = JSON.parse(draft);
        if (value === null || Array.isArray(value) || typeof value !== 'object') {
          throw new Error('defaults must be a JSON object');
        }
        parsed = value as Record<string, unknown>;
      } catch (err) {
        setError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }
    await saveDefaults(parsed);
  }, [draft, saveDefaults]);

  if (!ff) {
    // Shouldn't render — the parent gates on `gezel.fixedFunction`.
    return null;
  }

  return (
    <div className="ff-about-panel">
      <div className="ff-about-summary">
        <div className="ff-about-row">
          <span className="ff-label">Forwards to</span>
          <code className="ff-tool-name">{ff.tool}</code>
          <span className="muted small">— no LLM is invoked</span>
        </div>
        <div className="ff-about-row">
          <span className="ff-label">Argument</span>
          <span>
            Your message text is passed as <code>{ff.promptKey}</code>.
          </span>
        </div>
        {ff.requiresInputImage && (
          <div className="ff-about-row">
            <span className="ff-label">Pictures</span>
            <span>
              Changes the pictures you attach, or the last one it made in the thread. A message with
              neither is turned away.
            </span>
          </div>
        )}
        {gezel.description && <p className="muted">{gezel.description}</p>}
      </div>
      {ff.tool === 'generate_image' && (
        <ImageDefaultsKeys
          defaults={ff.defaults}
          disabled={busy || dirty}
          onChange={(next) => {
            setError(null);
            setStatus(null);
            void saveDefaults(next);
          }}
        />
      )}
      <ArgumentsJson open={ff.tool !== 'generate_image'}>
        <div className="ff-defaults">
          <label className="ff-defaults-label" htmlFor={`ff-defaults-${gezel.id}`}>
            Default arguments
          </label>
          <p className="muted small ff-defaults-help">
            Merged into every call as JSON. Your message text on <code>{ff.promptKey}</code> always
            wins over a collision here. Common keys for <code>{ff.tool}</code>: <code>width</code>,{' '}
            <code>height</code>, <code>steps</code>, <code>model</code>, <code>negativePrompt</code>
            . Leave empty to forward only the prompt.
          </p>
          <textarea
            id={`ff-defaults-${gezel.id}`}
            className="ff-defaults-textarea"
            value={draft}
            spellCheck={false}
            rows={10}
            placeholder='{\n  "width": 1024,\n  "height": 1024\n}'
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
              setStatus(null);
            }}
            disabled={busy}
          />
          <div className="ff-defaults-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={busy || !dirty}
            >
              {busy ? 'Saving…' : 'Save defaults'}
            </button>
            {status && <span className="muted small">{status}</span>}
            {error && <span className="error small">{error}</span>}
          </div>
        </div>
      </ArgumentsJson>
    </div>
  );
}

/** The raw JSON editor: open for most tools, behind a disclosure where typed keys cover the common case. */
function ArgumentsJson({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (open) return <>{children}</>;
  return (
    <details className="ff-defaults-advanced">
      <summary>Advanced: default arguments as JSON</summary>
      {children}
    </details>
  );
}

const QUALITY_KEYS: ReadonlyArray<{ id: ImageQuality; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'standard', label: 'Standard' },
  { id: 'high', label: 'High' },
];

/**
 * The shape, size and model every message to this image gezel starts from.
 * The composer's image strip changes them per message; these are what a new
 * thread opens with. A shape replaces any default pixel size.
 */
function ImageDefaultsKeys({
  defaults,
  disabled,
  onChange,
}: {
  defaults: Record<string, unknown> | undefined;
  disabled: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const settings = imageSizeSettingsFrom(defaults);
  const [models, setModels] = useState<InstalledImageModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .listInstalledImageModels()
      .then((res) => {
        if (!cancelled) setModels(res.models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const set = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...(defaults ?? {}), ...patch };
    if ('aspectRatio' in patch || 'quality' in patch) {
      delete next.width;
      delete next.height;
    }
    for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
    onChange(next);
  };
  const aspect = settings.aspectRatio ?? (settings.width ? undefined : '1:1');
  const quality = settings.quality ?? 'standard';
  return (
    <div className="ff-image-defaults">
      <span className="ff-defaults-label">New messages start as</span>
      <div
        className="gz-tray ff-image-defaults-tray"
        role="radiogroup"
        aria-label="Default shape"
        onKeyDown={onRadioKeyDown}
      >
        {IMAGE_ASPECT_RATIOS.map((ratio: ImageAspectRatio) => (
          <button
            key={ratio}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={ratio === aspect}
            tabIndex={ratio === (aspect ?? '1:1') ? 0 : -1}
            disabled={disabled}
            className={`gz-key${ratio === aspect ? ' gz-key-active' : ''}`}
            title={ASPECT_RATIO_NAMES[ratio]}
            onClick={() => set({ aspectRatio: ratio === '1:1' ? undefined : ratio })}
          >
            {ratio}
          </button>
        ))}
      </div>
      <div
        className="gz-tray ff-image-defaults-tray"
        role="radiogroup"
        aria-label="Default size"
        onKeyDown={onRadioKeyDown}
      >
        {QUALITY_KEYS.map((key) => (
          <button
            key={key.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={key.id === quality}
            tabIndex={key.id === quality ? 0 : -1}
            disabled={disabled}
            className={`gz-key${key.id === quality ? ' gz-key-active' : ''}`}
            onClick={() => set({ quality: key.id === 'standard' ? undefined : key.id })}
          >
            {key.label}
          </button>
        ))}
      </div>
      {models.length > 1 && (
        <label className="ff-image-defaults-model">
          <span className="muted small">Model</span>
          <select
            value={settings.model ?? ''}
            disabled={disabled}
            onChange={(e) => set({ model: e.target.value || undefined })}
          >
            <option value="">The engine's default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
