// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { ChatNarrateButton } from './ChatNarrateButton.js';

vi.mock('../api.js', async () => {
  const { createMockApi } = await import('../test-utils/mockApi.js');
  return { api: createMockApi() };
});

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  readonly stream: MediaStream;
  readonly mimeType: string;
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({
        data: new Blob(['voice'], { type: this.mimeType }),
      } as BlobEvent);
      this.onstop?.(new Event('stop'));
    });
  }
}

class FakeAudioContext {
  async decodeAudioData(): Promise<AudioBuffer> {
    return {
      length: 4,
      numberOfChannels: 1,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([0, 0.25, -0.25, 0]),
    } as unknown as AudioBuffer;
  }

  async close(): Promise<void> {}
}

describe('ChatNarrateButton', () => {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(
    async () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
  );
  const enumerateDevices = vi.fn(async () => [] as MediaDeviceInfo[]);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { enumerateDevices, getUserMedia },
    });
    vi.mocked(api.getConfig).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('progressively transcribes microphone takes into the prompt and flushes on stop', async () => {
    vi.mocked(api.transcribeAudio)
      .mockResolvedValueOnce({ text: 'first thought', durationMs: 8_000 })
      .mockResolvedValueOnce({ text: 'second thought', durationMs: 2_000 });
    const onTranscript = vi.fn();
    const onError = vi.fn();
    render(
      <ChatNarrateButton projectId="project-1" onTranscript={onTranscript} onError={onError} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Narrate prompt' }));
      await Promise.resolve();
    });
    const recordingButton = screen.getByRole('button', { name: 'Stop narrating' });
    expect(recordingButton).toBeEnabled();
    expect(recordingButton).toHaveClass('chat-narrate-btn-recording');
    expect(screen.getByTestId('microphone-waveform').children).toHaveLength(12);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });
    expect(onTranscript).toHaveBeenCalledWith('first thought');
    expect(api.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        audio: expect.objectContaining({ mimeType: 'audio/wav' }),
        signal: expect.any(AbortSignal),
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop narrating' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Narrate prompt' })).toBeEnabled();
    expect(onTranscript.mock.calls.map(([text]) => text)).toEqual([
      'first thought',
      'second thought',
    ]);
    expect(api.transcribeAudio).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prompt: 'first thought' }),
    );
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(null);
  });

  it('turns a denied microphone request into actionable copy', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    const onError = vi.fn();
    render(<ChatNarrateButton projectId="default" onTranscript={vi.fn()} onError={onError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Narrate prompt' }));
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/system settings/i));
    expect(screen.getByRole('button', { name: 'Narrate prompt' })).toBeEnabled();
  });

  it('stops recording and surfaces API error details after a failed take', async () => {
    vi.mocked(api.transcribeAudio).mockRejectedValueOnce(
      Object.assign(new Error('Gezel API error 500 on POST /api/audio/transcribe'), {
        details: {
          error:
            'No STT model is available locally. Download one from Settings → Audio before transcribing.',
        },
      }),
    );
    const onError = vi.fn();
    render(<ChatNarrateButton projectId="default" onTranscript={vi.fn()} onError={onError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Narrate prompt' }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Settings → Audio/));
    expect(screen.getByRole('button', { name: 'Narrate prompt' })).toBeEnabled();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(api.transcribeAudio).toHaveBeenCalledOnce();
  });

  it('turns the stable transcription failure code into actionable copy', async () => {
    vi.mocked(api.transcribeAudio).mockRejectedValueOnce(
      Object.assign(new Error('Gezel API error 503 on POST /api/audio/transcribe'), {
        details: { error: 'speech_to_text_failed' },
      }),
    );
    const onError = vi.fn();
    render(<ChatNarrateButton projectId="default" onTranscript={vi.fn()} onError={onError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Narrate prompt' }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Check Settings → Audio/));
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('internal_error'));
  });

  it('uses the configured microphone and does not let one blank interval stop capture', async () => {
    enumerateDevices.mockResolvedValueOnce([
      {
        kind: 'audioinput',
        deviceId: 'current-studio-id',
        label: 'Studio microphone',
      } as MediaDeviceInfo,
    ]);
    vi.mocked(api.getConfig).mockResolvedValueOnce({
      microphoneDeviceId: 'old-origin-id',
      microphoneDeviceLabel: 'Studio microphone',
    } as never);
    vi.mocked(api.transcribeAudio).mockResolvedValue({ text: '', durationMs: 2_500 });
    const onError = vi.fn();
    render(<ChatNarrateButton projectId="default" onTranscript={vi.fn()} onError={onError} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Narrate prompt' }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'current-studio-id' } }),
      video: false,
    });
    expect(onError).not.toHaveBeenCalledWith(expect.stringMatching(/Studio microphone/));
    expect(screen.getByRole('button', { name: 'Stop narrating' })).toBeEnabled();
  });
});
