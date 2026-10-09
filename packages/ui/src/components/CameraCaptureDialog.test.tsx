// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraCaptureDialog } from './CameraCaptureDialog.js';

function fakeStream(deviceId = 'cam-1') {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId }) };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
  };
}

function installCamera(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([
          { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera' },
        ]),
    },
  });
}

describe('CameraCaptureDialog', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
      configurable: true,
      get: () => 1280,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
      configurable: true,
      get: () => 720,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ drawImage: vi.fn() }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value(callback: (blob: Blob | null) => void, type: string) {
        callback(new Blob(['jpeg'], { type }));
      },
    });
    URL.createObjectURL = vi.fn(() => 'blob:photo');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('asks for video only, captures a still, and releases the camera before review', async () => {
    const { stream, track } = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installCamera(getUserMedia);
    const onCapture = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<CameraCaptureDialog open onClose={onClose} onCapture={onCapture} />);

    const shutter = await screen.findByRole('button', { name: 'Take photo' });
    await waitFor(() => expect((shutter as HTMLButtonElement).disabled).toBe(false));
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    expect(getUserMedia.mock.calls[0]![0].video).toBeTruthy();

    fireEvent.click(shutter);
    expect(await screen.findByRole('img', { name: 'What the camera captured' })).toBeTruthy();
    expect(track.stop).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Insert photo' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const photo = onCapture.mock.calls[0]![0] as File;
    expect(photo.type).toBe('image/jpeg');
    expect(photo.name).toMatch(/^photo-\d{4}-\d{2}-\d{2}-\d{6}\.jpg$/);
  });

  it('keeps the still on screen when inserting fails', async () => {
    installCamera(vi.fn().mockResolvedValue(fakeStream().stream));
    const onCapture = vi.fn().mockRejectedValue(new Error('Disk full'));
    const onClose = vi.fn();
    render(<CameraCaptureDialog open onClose={onClose} onCapture={onCapture} />);

    const shutter = await screen.findByRole('button', { name: 'Take photo' });
    await waitFor(() => expect((shutter as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(shutter);
    fireEvent.click(await screen.findByRole('button', { name: 'Insert photo' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Disk full');
    expect(screen.getByRole('img', { name: 'What the camera captured' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains a refused permission and offers to try again', async () => {
    const denied = new DOMException('denied', 'NotAllowedError');
    const getUserMedia = vi.fn().mockRejectedValue(denied);
    installCamera(getUserMedia);
    render(<CameraCaptureDialog open onClose={vi.fn()} onCapture={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/not allowed to use the camera/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  it('falls back to the default camera when the remembered one is gone', async () => {
    window.localStorage.setItem('gezel.composer.camera', 'unplugged');
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      .mockResolvedValue(fakeStream('cam-1').stream);
    installCamera(getUserMedia);
    render(<CameraCaptureDialog open onClose={vi.fn()} onCapture={vi.fn()} />);

    const shutter = await screen.findByRole('button', { name: 'Take photo' });
    await waitFor(() => expect((shutter as HTMLButtonElement).disabled).toBe(false));
    expect(getUserMedia.mock.calls[0]![0].video.deviceId).toEqual({ exact: 'unplugged' });
    expect(getUserMedia.mock.calls[1]![0].video.deviceId).toBeUndefined();
  });

  it('stops the camera when the dialog closes', async () => {
    const { stream, track } = fakeStream();
    installCamera(vi.fn().mockResolvedValue(stream));
    const { rerender } = render(<CameraCaptureDialog open onClose={vi.fn()} onCapture={vi.fn()} />);
    const shutter = await screen.findByRole('button', { name: 'Take photo' });
    await waitFor(() => expect((shutter as HTMLButtonElement).disabled).toBe(false));

    rerender(<CameraCaptureDialog open={false} onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(track.stop).toHaveBeenCalled();
  });
});
