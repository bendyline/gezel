import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { SettingField, SettingsSection, settingHintId } from '../components/SettingsSection.js';
import {
  type MicrophoneInput,
  listMicrophoneInputs,
  resolveMicrophoneInput,
} from '../components/microphone-input.js';

/** OS microphone selection used by prompt narration across chat surfaces. */
export function MicrophoneSettings() {
  const [microphones, setMicrophones] = useState<MicrophoneInput[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getConfig()
      .then((config) => {
        setDeviceId(config.microphoneDeviceId ?? '');
        setDeviceLabel(config.microphoneDeviceLabel ?? '');
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  const refreshMicrophones = useCallback(async (requestAccess = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('Microphone selection is unavailable in this browser.');
      return;
    }
    let permissionStream: MediaStream | undefined;
    try {
      if (requestAccess) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      setMicrophones(await listMicrophoneInputs());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      for (const track of permissionStream?.getTracks() ?? []) track.stop();
    }
  }, []);

  useEffect(() => {
    void refreshMicrophones();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refreshMicrophones();
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshMicrophones]);

  const onSetMicrophone = useCallback(
    async (nextDeviceId: string) => {
      const previousId = deviceId;
      const previousLabel = deviceLabel;
      const selected = microphones.find((input) => input.deviceId === nextDeviceId);
      const nextLabel = selected?.label ?? '';
      setDeviceId(nextDeviceId);
      setDeviceLabel(nextLabel);
      setSaving(true);
      try {
        const response = await api.updateConfig({
          microphoneDeviceId: nextDeviceId || null,
          microphoneDeviceLabel: nextLabel || null,
        });
        setDeviceId(response.microphoneDeviceId ?? '');
        setDeviceLabel(response.microphoneDeviceLabel ?? '');
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: response }));
        setError(null);
      } catch (caught) {
        setDeviceId(previousId);
        setDeviceLabel(previousLabel);
        setError(errorMessage(caught));
      } finally {
        setSaving(false);
      }
    },
    [deviceId, deviceLabel, microphones],
  );

  const needsIdentification =
    microphones.length === 0 || microphones.every((input) => !input.label);

  return (
    <SettingsSection
      id="settings-microphone"
      title="Microphone"
      hint="Choose the input used by the Narrate button in chat."
    >
      <SettingField
        label="Input"
        controlId="settings-microphone-input"
        hint="Choose System default to follow your operating system's input selection."
      >
        <div className="gz-setting-row">
          <select
            id="settings-microphone-input"
            aria-label="Microphone input"
            aria-describedby={settingHintId('settings-microphone-input')}
            value={effectiveDeviceId(microphones, deviceId, deviceLabel)}
            disabled={saving}
            onChange={(event) => void onSetMicrophone(event.target.value)}
          >
            <option value="">System default</option>
            {microphones.map((input, index) => (
              <option key={input.deviceId} value={input.deviceId}>
                {input.label || `Microphone ${index + 1}`}
              </option>
            ))}
            {deviceId &&
              !microphones.some((input) => input.deviceId === deviceId) &&
              !microphones.some((input) => deviceLabel && input.label === deviceLabel) && (
                <option value={deviceId}>
                  {deviceLabel || 'Saved microphone'} (not currently available)
                </option>
              )}
          </select>
          <button
            type="button"
            className="secondary"
            onClick={() => void refreshMicrophones(needsIdentification)}
          >
            {needsIdentification ? 'Identify microphones' : 'Refresh'}
          </button>
        </div>
      </SettingField>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </SettingsSection>
  );
}

function effectiveDeviceId(
  inputs: readonly MicrophoneInput[],
  deviceId: string,
  label: string,
): string {
  return (
    resolveMicrophoneInput(inputs, {
      ...(deviceId ? { deviceId } : {}),
      ...(label ? { label } : {}),
    })?.deviceId ?? deviceId
  );
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
