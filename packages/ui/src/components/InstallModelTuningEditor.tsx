import type { ChatModelTuning, ProviderName } from '@bendyline/gezel';
import {
  CANONICAL_PROFILES,
  DEFAULT_TUNING_PROFILE_ID,
  isKnownProfileId,
  resolveProfileChain,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TuningPanel } from './TuningPanel.js';

interface InstallModelTuningEditorProps {
  /** Catalog model id this expando is scoped to (e.g. `gemma4-26b`). */
  modelId: string;
  provider: ProviderName;
  /** Catalog manifest's recommended defaults — the inherited layer. */
  inherited?: ChatModelTuning;
  /** Current install-wide override for this model id, if any. */
  override?: ChatModelTuning;
  /**
   * Currently-selected install-wide preset profile id for this model id,
   * if any (`config.modelTuningProfile[modelId]`).
   */
  profileId?: string;
  /**
   * Catalog-declared profile ids the active model implements (keys of
   * `catalog.tuning.profiles`). Drives the preset dropdown. When empty,
   * the preset picker is hidden and only the custom fine-tuning surface
   * remains — the model hasn't validated any presets, so offering
   * canonical ones would silently fall through.
   */
  availableProfiles: string[];
  onSaved?: (next: ConfigResponse) => void;
}

/**
 * Install-wide per-model tuning. Two stacked surfaces: a Preset picker
 * (saved into `GezelConfig.modelTuningProfile[<modelId>]`) and a
 * collapsed "Custom fine-tuning" panel that wraps the shared
 * {@link TuningPanel} (saved into `GezelConfig.modelTuning[<modelId>]`).
 * Both layers sit BETWEEN per-gezel overrides and the catalog default
 * in the resolution stack; custom values win over the preset's sampling
 * per-leaf, so the user can pick a preset and then nudge one knob.
 */
export function InstallModelTuningEditor({
  modelId,
  provider,
  inherited,
  override,
  profileId,
  availableProfiles,
  onSaved,
}: InstallModelTuningEditorProps) {
  const onSaveOverride = useCallback(
    async (nextOverride: ChatModelTuning | null) => {
      const current = (await api.getConfig()).modelTuning ?? {};
      const next: Record<string, ChatModelTuning> = { ...current };
      if (nextOverride === null) {
        delete next[modelId];
      } else {
        next[modelId] = nextOverride;
      }
      const updated = await api.updateConfig({ modelTuning: next });
      onSaved?.(updated);
    },
    [modelId, onSaved],
  );

  const onSaveProfile = useCallback(
    async (nextProfileId: string | null) => {
      const current = (await api.getConfig()).modelTuningProfile ?? {};
      const next: Record<string, string> = { ...current };
      if (nextProfileId === null) {
        delete next[modelId];
      } else {
        next[modelId] = nextProfileId;
      }
      const updated = await api.updateConfig({ modelTuningProfile: next });
      onSaved?.(updated);
    },
    [modelId, onSaved],
  );

  const hasCustomOverride = !!override && Object.keys(override).length > 0;
  // Mirror the runtime resolver: which profile id will actually take
  // effect after the canonical fallback chain walks against the model's
  // declared profiles? Surfaced in the picker's hint so users see when
  // their pick fell back or fell through.
  const resolvedProfileId = useMemo(
    () => (profileId ? resolveProfileChain(profileId, availableProfiles) : undefined),
    [profileId, availableProfiles],
  );

  return (
    <div className="install-model-tuning-editor" style={{ marginTop: '0.75rem' }}>
      {availableProfiles.length > 0 && (
        <PresetPicker
          modelId={modelId}
          profileId={profileId}
          resolvedProfileId={resolvedProfileId}
          availableProfiles={availableProfiles}
          customized={hasCustomOverride}
          onChange={onSaveProfile}
        />
      )}
      <details style={{ marginTop: '0.5rem' }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>
          {hasCustomOverride
            ? `Custom fine-tuning for ${modelId} (active)`
            : `Custom fine-tuning for ${modelId}`}
        </summary>
        <div style={{ marginTop: '0.5rem' }}>
          <TuningPanel
            provider={provider}
            {...(override ? { override } : {})}
            {...(inherited ? { inherited } : {})}
            {...(resolvedProfileId ? { tuningProfileId: resolvedProfileId } : {})}
            onSave={onSaveOverride}
            scopeLabel={`every gezel using ${modelId}`}
          />
        </div>
      </details>
    </div>
  );
}

function PresetPicker({
  modelId,
  profileId,
  resolvedProfileId,
  availableProfiles,
  customized,
  onChange,
}: {
  modelId: string;
  profileId: string | undefined;
  resolvedProfileId: string | undefined;
  availableProfiles: string[];
  customized: boolean;
  onChange: (next: string | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(
    () =>
      availableProfiles.map((id) => {
        const meta = isKnownProfileId(id) ? CANONICAL_PROFILES[id] : null;
        return {
          id,
          label: meta?.label ?? id,
          description: meta?.description,
        };
      }),
    [availableProfiles],
  );

  // What "no explicit preset" actually resolves to: the app-wide default
  // profile walked against this model's declared profiles. Surfaced in
  // the empty option so the picker doesn't claim "no preset" when a real
  // default is in effect. Empty when the model implements nothing in the
  // default's fallback chain (then base tuning genuinely applies).
  const defaultLabel = useMemo(() => {
    const resolved = resolveProfileChain(DEFAULT_TUNING_PROFILE_ID, availableProfiles);
    if (resolved && isKnownProfileId(resolved)) return CANONICAL_PROFILES[resolved].label;
    return null;
  }, [availableProfiles]);

  const handleChange = useCallback(
    async (next: string) => {
      setSaving(true);
      setError(null);
      try {
        await onChange(next === '' ? null : next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [onChange],
  );

  // Resolution hint: empty when the pick lands directly on a declared
  // profile (the dropdown label already says everything). Surfaced when
  // we fell back along the canonical chain, or fell through entirely.
  const hint = useMemo(() => {
    if (!profileId) return null;
    if (!resolvedProfileId) return 'Not implemented by this model — base tuning applies.';
    if (resolvedProfileId !== profileId) {
      const requestedLabel = isKnownProfileId(profileId)
        ? CANONICAL_PROFILES[profileId].label
        : profileId;
      const resolvedLabel = isKnownProfileId(resolvedProfileId)
        ? CANONICAL_PROFILES[resolvedProfileId].label
        : resolvedProfileId;
      return `Falls back to ${resolvedLabel} — ${requestedLabel} isn't defined on this model.`;
    }
    return null;
  }, [profileId, resolvedProfileId]);

  return (
    <div className="install-preset-picker" style={{ marginTop: '0.25rem' }}>
      <label
        htmlFor={`install-preset-${modelId}`}
        className="small"
        style={{ display: 'block', marginBottom: '0.25rem' }}
      >
        <strong>Preset</strong>{' '}
        <span className="muted">
          — applies to every gezel using {modelId}. Individual gezels can override below in their
          detail pane.
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <select
          id={`install-preset-${modelId}`}
          value={profileId ?? ''}
          onChange={(e) => void handleChange(e.target.value)}
          disabled={saving}
        >
          <option value="">
            {defaultLabel ? `(default — ${defaultLabel})` : '(model default — no preset)'}
          </option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id} title={opt.description}>
              {opt.label}
            </option>
          ))}
        </select>
        {customized && (
          <span
            className="small muted"
            title="Custom fine-tuning values are active — they override individual fields from the preset."
          >
            · Custom fine-tuning active
          </span>
        )}
      </div>
      {hint && (
        <div className="small muted" style={{ marginTop: '0.25rem' }}>
          {hint}
        </div>
      )}
      {error && (
        <div className="small error" style={{ marginTop: '0.25rem' }}>
          {error}
        </div>
      )}
    </div>
  );
}
