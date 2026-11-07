import type { RelevanceModelStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import { SettingCheck, SettingField } from './SettingsSection.js';

/**
 * Settings → Project knowledge: the relevance check. A small on-device model
 * that reads each indexed passage beside the question and sets aside what is
 * off-topic before a gezel sees it. First run turns it on for new installs;
 * turning it on downloads the chosen model once. The status line is the whole lifecycle — download,
 * load, ready — because the check never makes a conversation wait for it.
 */
export function RelevanceModelCard() {
  const [status, setStatus] = useState<RelevanceModelStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.retrieval.relevanceModelStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = status?.status === 'downloading' || status?.status === 'warming';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 1_500);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const save = useCallback(
    async (patch: { enabled?: boolean; modelId?: string }) => {
      if (!status) return;
      setSaving(true);
      setError(null);
      try {
        await api.updateConfig({
          relevanceModel: { enabled: status.enabled, modelId: status.modelId, ...patch },
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [status, refresh],
  );

  const models = (status?.models ?? []).filter((model) => !model.experimental);
  const selected = models.find((model) => model.id === status?.modelId);
  const overridden = status?.source === 'env';

  const lifecycle = status ? statusLine(status) : undefined;
  return (
    <div className="gz-setting-stack">
      <SettingCheck
        label="Check that indexed context is on topic before using it"
        hint="Before indexed material reaches a gezel, a small model on this device reads each passage beside the question and sets aside what is off-topic. It never makes a conversation wait: while it loads, material is chosen the usual way."
        checked={status?.enabled === true}
        disabled={!status || saving || overridden}
        onChange={(checked) => void save({ enabled: checked })}
      />
      {models.length > 0 ? (
        <SettingField label="Relevance model" hint={lifecycle}>
          <div>
            <div
              className={`gz-tray${selected ? ' gz-tray--described' : ''}`}
              role="radiogroup"
              onKeyDown={onRadioKeyDown}
              aria-label="Relevance model"
            >
              {models.map((model) => {
                const active = model.id === status?.modelId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                    role="radio"
                    aria-checked={active}
                    tabIndex={active || (!selected && model === models[0]) ? 0 : -1}
                    className={`gz-key gz-key--stacked${active ? ' gz-key-active' : ''}`}
                    disabled={saving || overridden}
                    onClick={() => void save({ modelId: model.id })}
                  >
                    <span className="gz-key-label">{model.displayName}</span>
                    <span className="gz-key-hint">about {megabytes(model.approxBytes)} MB</span>
                  </button>
                );
              })}
            </div>
            {selected && (
              <p className="gz-tray-description">
                <strong>{selected.displayName}</strong> — {selected.description}
                {!selected.calibrated &&
                  ' Until it has been tuned, it only puts the closest matches first; it does not hide anything.'}
              </p>
            )}
          </div>
        </SettingField>
      ) : (
        lifecycle && <p className="gz-setting-hint">{lifecycle}</p>
      )}
      {(error ?? status?.error) && (
        <p className="error small" role="alert">
          {error ?? status?.error}
        </p>
      )}
    </div>
  );
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000));
}

function statusLine(status: RelevanceModelStatusResponse): string {
  if (status.source === 'env') return 'Set by the environment for this run.';
  switch (status.status) {
    case 'off':
      return 'Off.';
    case 'not-installed':
      return 'Not downloaded yet.';
    case 'blocked-network':
      return 'Downloads are turned off in Security settings, so the model cannot be fetched.';
    case 'downloading': {
      const progress = status.progress;
      return progress
        ? `Downloading… ${megabytes(progress.bytesDone)} of ${megabytes(progress.bytesTotal)} MB`
        : 'Downloading…';
    }
    case 'cold':
      return 'Downloaded. Loads the first time it is needed.';
    case 'warming':
      return 'Loading…';
    case 'ready':
      return 'Ready.';
    case 'unavailable':
      return 'Could not load the model; material is chosen the usual way.';
    case 'disabled':
      return 'Turned off for this run by the environment.';
    default:
      return '';
  }
}
