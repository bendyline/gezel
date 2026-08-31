import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { api } = await import('../api.js');
const { MicrophoneSettings } = await import('./MicrophoneSettings.js');

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const enumerateDevices = vi.fn(async () => [
  { kind: 'audioinput', deviceId: 'mic-built-in', label: 'Built-in microphone' },
  { kind: 'audioinput', deviceId: 'mic-studio', label: 'Studio microphone' },
  { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
]);
const stopPermissionTrack = vi.fn();
const getUserMedia = vi.fn(async () => ({
  getTracks: () => [{ stop: stopPermissionTrack }],
}));

describe('MicrophoneSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices, getUserMedia },
    });
    vi.mocked(api.getConfig).mockResolvedValue({
      microphoneDeviceId: 'mic-built-in',
      microphoneDeviceLabel: 'Built-in microphone',
    } as never);
  });

  afterEach(() => {
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });

  it('lists microphones and persists the selected narration input', async () => {
    vi.mocked(api.updateConfig).mockResolvedValue({
      microphoneDeviceId: 'mic-studio',
      microphoneDeviceLabel: 'Studio microphone',
    } as never);
    render(<MicrophoneSettings />);

    const microphone = (await screen.findByLabelText('Microphone input')) as HTMLSelectElement;
    await waitFor(() => expect(microphone).toHaveValue('mic-built-in'));
    fireEvent.change(microphone, { target: { value: 'mic-studio' } });

    await waitFor(() => {
      expect(api.updateConfig).toHaveBeenCalledWith({
        microphoneDeviceId: 'mic-studio',
        microphoneDeviceLabel: 'Studio microphone',
      });
    });
  });
});
