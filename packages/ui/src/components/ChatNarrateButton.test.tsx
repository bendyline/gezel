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

describe('ChatNarrateButton', () => {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(
    async () => ({ getTracks: () => [{ stop: stopTrack }] }) as unknown as MediaStream,
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
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
    expect(screen.getByRole('button', { name: 'Stop narrating' })).toBeEnabled();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
      await Promise.resolve();
    });
    expect(onTranscript).toHaveBeenCalledWith('first thought');
    expect(api.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        audio: expect.objectContaining({ mimeType: 'audio/webm;codecs=opus' }),
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
});
