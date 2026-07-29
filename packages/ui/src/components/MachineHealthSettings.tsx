import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

type UserDeviceSafetyMode = 'observe' | 'guard';

interface Props {
  config: ConfigResponse | null;
  onConfigChanged: (config: ConfigResponse) => void;
  platform?: string;
}

const DEFAULT_MANAGE_TEMPERATURE_C = 80;
const MIN_MANAGE_TEMPERATURE_C = 40;
const MAX_MANAGE_TEMPERATURE_C = 95;
const RESUME_HYSTERESIS_C = 5;

function supportsMachineHealth(platform: string | undefined): boolean {
  return platform === 'win32' || platform === 'linux';
}

/**
 * Windows/Linux machine-health controls for sustained local accelerator work.
 *
 * The product calls the runtime's `guard` mode "Manage": the implementation
 * term describes admission gating, while the user-facing term describes the
 * outcome. macOS stays hidden until it has a supported telemetry adapter.
 */
export function MachineHealthSettings({ config, onConfigChanged, platform }: Props) {
  const configuredTemperature =
    config?.deviceSafety?.maxStartTemperatureC ?? DEFAULT_MANAGE_TEMPERATURE_C;
  const [temperatureDraft, setTemperatureDraft] = useState(String(configuredTemperature));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTemperatureDraft(String(configuredTemperature));
  }, [configuredTemperature]);

  const savePolicy = useCallback(
    async (patch: NonNullable<ConfigResponse['deviceSafety']>) => {
      if (saving) return;
      setSaving(true);
      setError(null);
      try {
        const next = await api.updateConfig({
          deviceSafety: {
            ...(config?.deviceSafety ?? {}),
            ...patch,
          },
        });
        onConfigChanged(next);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [config?.deviceSafety, onConfigChanged, saving],
  );

  const saveMode = useCallback(
    (mode: UserDeviceSafetyMode) => {
      if (config?.deviceSafety?.mode === mode) return;
      void savePolicy({ mode });
    },
    [config?.deviceSafety?.mode, savePolicy],
  );

  const saveTemperature = useCallback(() => {
    const temperature = Number(temperatureDraft);
    if (
      !Number.isInteger(temperature) ||
      temperature < MIN_MANAGE_TEMPERATURE_C ||
      temperature > MAX_MANAGE_TEMPERATURE_C
    ) {
      setError(
        `Enter a whole number from ${MIN_MANAGE_TEMPERATURE_C} to ${MAX_MANAGE_TEMPERATURE_C}°C.`,
      );
      return;
    }
    if (temperature === configuredTemperature) {
      setError(null);
      return;
    }
    void savePolicy({
      maxStartTemperatureC: temperature,
      resumeTemperatureC: temperature - RESUME_HYSTERESIS_C,
    });
  }, [configuredTemperature, savePolicy, temperatureDraft]);

  if (!supportsMachineHealth(platform)) return null;

  const configuredMode = config?.deviceSafety?.mode ?? 'observe';

  return (
    <section className="machine-health-settings" aria-labelledby="machine-health-heading">
      <h4 id="machine-health-heading">Machine health</h4>
      <p className="muted" style={{ marginTop: 0 }}>
        Choose whether Gezel only reports accelerator health or also waits for the machine to cool
        before starting new on-device work.
      </p>

      <div
        className="gz-tray machine-health-mode"
        role="radiogroup"
        aria-label="Machine health mode"
      >
        <button
          type="button"
          role="radio"
          aria-checked={configuredMode === 'observe'}
          className={`gz-key gz-key--stacked${configuredMode === 'observe' ? ' gz-key-active' : ''}`}
          disabled={saving}
          onClick={() => saveMode('observe')}
        >
          <span>Observe</span>
          <small>Report only</small>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={configuredMode === 'guard'}
          className={`gz-key gz-key--stacked${configuredMode === 'guard' ? ' gz-key-active' : ''}`}
          disabled={saving}
          onClick={() => saveMode('guard')}
        >
          <span>Manage</span>
          <small>Pause new work</small>
        </button>
      </div>

      {configuredMode === 'off' && (
        <p className="muted small machine-health-off-note">
          Machine health is disabled by an advanced configuration override. Choose Observe or
          Manage to turn it back on.
        </p>
      )}

      <div className="machine-health-temperature-row">
        <label htmlFor="machine-health-temperature">Manage temperature</label>
        <span className="machine-health-temperature-control">
          <input
            id="machine-health-temperature"
            type="number"
            inputMode="numeric"
            min={MIN_MANAGE_TEMPERATURE_C}
            max={MAX_MANAGE_TEMPERATURE_C}
            step={1}
            value={temperatureDraft}
            disabled={saving}
            aria-describedby="machine-health-temperature-help"
            onChange={(event) => setTemperatureDraft(event.target.value)}
            onBlur={saveTemperature}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <span aria-hidden="true">°C</span>
        </span>
      </div>
      <p id="machine-health-temperature-help" className="muted small machine-health-temperature-help">
        In Manage mode, new accelerator work waits above this temperature and resumes after a 5°C
        cooldown. The default is 80°C. Both modes retain the 95°C emergency cutoff.
      </p>

      {saving && (
        <p className="muted small machine-health-save-state" role="status">
          Saving…
        </p>
      )}
      {error && (
        <p className="error small machine-health-save-state" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
