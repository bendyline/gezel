import type { ChatModelTuning, GezelDetail, ProviderName } from '@bendyline/gezel';
import { CANONICAL_PROFILES, isKnownProfileId } from '@bendyline/gezel';
import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TuningPanel } from './TuningPanel.js';

interface GezelTuningEditorProps {
  gezel: GezelDetail;
  /**
   * Resolved inherited defaults — catalog + install-wide modelTuning
   * merged. The gezel's own override layers on top of this. Used to
   * pre-fill the form so users see what's actually in effect, and to
   * diff at save-time so we only persist the gezel's deltas.
   */
  inherited?: ChatModelTuning;
  effectiveProvider: ProviderName;
  onUpdated: (updated: GezelDetail) => void;
}

/**
 * Per-gezel "Advanced tuning" surface. The Voice picker selects a named
 * sampling/reasoning preset declared by the active model; the underlying
 * {@link TuningPanel} still exposes raw field-level overrides on top.
 */
export function GezelTuningEditor({
  gezel,
  inherited,
  effectiveProvider,
  onUpdated,
}: GezelTuningEditorProps) {
  const onSave = useCallback(
    async (nextOverride: ChatModelTuning | null) => {
      const updated = await api.updateGezelSettings(gezel.id, { tuning: nextOverride });
      onUpdated(updated);
    },
    [gezel.id, onUpdated],
  );

  return (
    <div className="gezel-tuning-editor">
      <VoicePicker
        gezel={gezel}
        availableProfiles={Object.keys(inherited?.profiles ?? {})}
        onUpdated={onUpdated}
      />
      <TuningPanel
        provider={effectiveProvider}
        override={gezel.parsed?.frontmatter?.tuning}
        {...(inherited ? { inherited } : {})}
        {...(gezel.parsed?.frontmatter?.tuningProfile
          ? { tuningProfileId: gezel.parsed.frontmatter.tuningProfile }
          : {})}
        onSave={onSave}
        scopeLabel={gezel.name ?? 'this gezel'}
      />
    </div>
  );
}

/**
 * Single dropdown that selects the gezel's tuning profile. Options come
 * from the model's `tuning.profiles` keys; unrecognized ids show as the
 * raw id so future canonical additions still render. Saves via
 * `updateGezelSettings({ tuningProfile })` and refreshes the gezel record
 * so the rest of the page (including the resolved chip in TuningPanel)
 * reflects the new selection.
 */
function VoicePicker({
  gezel,
  availableProfiles,
  onUpdated,
}: {
  gezel: GezelDetail;
  availableProfiles: string[];
  onUpdated: (updated: GezelDetail) => void;
}) {
  const current = gezel.parsed?.frontmatter?.tuningProfile ?? '';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    return availableProfiles.map((id) => {
      const meta = isKnownProfileId(id) ? CANONICAL_PROFILES[id] : null;
      return {
        id,
        label: meta?.label ?? id,
        description: meta?.description,
      };
    });
  }, [availableProfiles]);

  const onChange = useCallback(
    async (next: string) => {
      setSaving(true);
      setError(null);
      try {
        const value = next === '' ? null : next;
        const updated = await api.updateGezelSettings(gezel.id, { tuningProfile: value });
        onUpdated(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [gezel.id, onUpdated],
  );

  if (options.length === 0 && !current) {
    return null;
  }

  return (
    <div className="voice-picker" style={{ marginBottom: '0.75rem' }}>
      <label
        htmlFor={`voice-${gezel.id}`}
        className="small"
        style={{ display: 'block', marginBottom: '0.25rem' }}
      >
        <strong>Voice</strong>{' '}
        <span className="muted">
          — preset the model applies for this gezel. Your manual tuning below overrides individual
          fields.
        </span>
      </label>
      <select
        id={`voice-${gezel.id}`}
        value={current}
        onChange={(e) => void onChange(e.target.value)}
        disabled={saving}
      >
        <option value="">(automatic — use template / model default)</option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id} title={opt.description}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <div className="small error" style={{ marginTop: '0.25rem' }}>
          {error}
        </div>
      )}
    </div>
  );
}
