export interface MicrophoneInput {
  deviceId: string;
  label: string;
}

export interface MicrophonePreference {
  deviceId?: string;
  label?: string;
}

/** Enumerate only microphone inputs, retaining the browser's preferred order. */
export async function listMicrophoneInputs(): Promise<MicrophoneInput[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label.trim() }));
}

/**
 * Device ids are origin-scoped. Prefer the current id, then recover a saved
 * preference by label after a local daemon port/origin change.
 */
export function resolveMicrophoneInput(
  inputs: readonly MicrophoneInput[],
  preference: MicrophonePreference,
): MicrophoneInput | undefined {
  if (preference.deviceId) {
    const exact = inputs.find((input) => input.deviceId === preference.deviceId);
    if (exact) return exact;
  }
  if (preference.label) {
    return inputs.find((input) => input.label === preference.label);
  }
  return undefined;
}
