import { describe, expect, it } from 'vitest';
import { resolveMicrophoneInput } from './microphone-input.js';

describe('resolveMicrophoneInput', () => {
  const inputs = [
    { deviceId: 'current-built-in', label: 'Built-in microphone' },
    { deviceId: 'current-studio', label: 'Studio microphone' },
  ];

  it('prefers the exact current-origin device id', () => {
    expect(
      resolveMicrophoneInput(inputs, {
        deviceId: 'current-built-in',
        label: 'Studio microphone',
      }),
    ).toEqual(inputs[0]);
  });

  it('falls back to the device label after the renderer origin changes', () => {
    expect(
      resolveMicrophoneInput(inputs, {
        deviceId: 'expired-origin-id',
        label: 'Studio microphone',
      }),
    ).toEqual(inputs[1]);
  });
});
