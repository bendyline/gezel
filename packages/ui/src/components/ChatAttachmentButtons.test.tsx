// @vitest-environment jsdom

import type { MediaProvider } from '@bendyline/squisq';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const insertAtCursor = vi.hoisted(() => vi.fn());
const bumpMediaRevision = vi.hoisted(() => vi.fn());

vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ bumpMediaRevision, insertAtCursor }),
}));

const cameraDialogProps = vi.hoisted(() => ({
  current: null as null | { onCapture: (photo: File) => Promise<void>; onClose: () => void },
}));

vi.mock('./CameraCaptureDialog.js', () => ({
  CameraCaptureDialog: (props: {
    onCapture: (photo: File) => Promise<void>;
    onClose: () => void;
  }) => {
    cameraDialogProps.current = props;
    return <div data-testid="camera-dialog" />;
  },
}));

const { ChatAttachmentButtons } = await import('./ChatAttachmentButtons.js');

function setPlatform(platform: string | undefined) {
  (window as { __GEZEL__?: unknown }).__GEZEL__ = platform ? { platform } : undefined;
}

function setMediaDevices(devices: Array<{ kind: string; deviceId: string }> | null) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: devices
      ? {
          getUserMedia: vi.fn(),
          enumerateDevices: vi.fn().mockResolvedValue(devices),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }
      : undefined,
  });
}

function mediaProvider(relativePath: string): MediaProvider {
  return {
    addMedia: vi.fn().mockResolvedValue(relativePath),
    resolveUrl: vi.fn(),
    listMedia: vi.fn().mockResolvedValue([]),
    removeMedia: vi.fn(),
    dispose: vi.fn(),
  };
}

function selectableFile(name: string, type: string): File {
  const file = new File(['contents'], name, { type });
  if (!file.arrayBuffer) {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('contents').buffer,
    });
  }
  return file;
}

describe('ChatAttachmentButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cameraDialogProps.current = null;
    setPlatform(undefined);
    setMediaDevices(null);
  });

  afterEach(() => {
    cleanup();
    setPlatform(undefined);
    setMediaDevices(null);
  });

  it('uploads and inserts an image through the direct image action', async () => {
    const provider = mediaProvider('attachments/diagram.png');
    const onError = vi.fn();
    const { container } = render(
      <ChatAttachmentButtons mediaProvider={provider} onError={onError} />,
    );

    expect(screen.getByRole('button', { name: 'Insert image' })).toBeTruthy();
    const input = container.querySelector('input[accept="image/*"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: { files: [selectableFile('system_diagram.png', 'image/png')] },
    });

    await waitFor(() =>
      expect(insertAtCursor).toHaveBeenCalledWith('![system diagram](attachments/diagram.png)'),
    );
    expect(provider.addMedia).toHaveBeenCalledWith(
      'system_diagram.png',
      expect.any(ArrayBuffer),
      'image/png',
    );
    expect(bumpMediaRevision).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(null);
  });

  it('uploads a general file and inserts a linked attachment', async () => {
    const provider = mediaProvider('attachments/design.pdf');
    const { container } = render(
      <ChatAttachmentButtons mediaProvider={provider} onError={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Attach file' })).toBeTruthy();
    const inputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(inputs[1]!, {
      target: { files: [selectableFile('design_brief.pdf', 'application/pdf')] },
    });

    await waitFor(() =>
      expect(insertAtCursor).toHaveBeenCalledWith('[design brief](attachments/design.pdf)'),
    );
  });

  it('keeps an image chosen through Attach file as an attachment link', async () => {
    const provider = mediaProvider('attachments/reference.png');
    const { container } = render(
      <ChatAttachmentButtons mediaProvider={provider} onError={vi.fn()} />,
    );

    const inputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(inputs[1]!, {
      target: { files: [selectableFile('reference.png', 'image/png')] },
    });

    await waitFor(() =>
      expect(insertAtCursor).toHaveBeenCalledWith('[reference](attachments/reference.png)'),
    );
  });

  it('surfaces upload failures without inserting broken markup', async () => {
    const provider = mediaProvider('unused');
    vi.mocked(provider.addMedia).mockRejectedValue(new Error('Upload failed'));
    const onError = vi.fn();
    const { container } = render(
      <ChatAttachmentButtons mediaProvider={provider} onError={onError} />,
    );

    const inputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(inputs[1]!, {
      target: { files: [selectableFile('brief.pdf', 'application/pdf')] },
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Upload failed'));
    expect(bumpMediaRevision).not.toHaveBeenCalled();
    expect(insertAtCursor).not.toHaveBeenCalled();
  });

  it('opens the phone camera through a capture input and inserts the photo', async () => {
    setPlatform('mobile');
    const provider = mediaProvider('attachments/photo.jpg');
    render(<ChatAttachmentButtons mediaProvider={provider} onError={vi.fn()} />);

    const input = screen.getByTestId('chat-camera-input') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('environment');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    expect(click).toHaveBeenCalledTimes(1);

    fireEvent.change(input, {
      target: { files: [selectableFile('IMG_4021.jpg', 'image/jpeg')] },
    });
    await waitFor(() =>
      expect(insertAtCursor).toHaveBeenCalledWith('![Photo](attachments/photo.jpg)'),
    );
    expect(screen.queryByTestId('camera-dialog')).toBeNull();
  });

  it('offers the desktop viewfinder only when a camera is attached', async () => {
    setMediaDevices([{ kind: 'audioinput', deviceId: '' }]);
    const { unmount } = render(
      <ChatAttachmentButtons mediaProvider={mediaProvider('unused')} onError={vi.fn()} />,
    );
    await waitFor(() => expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Take photo' })).toBeNull();
    unmount();

    setMediaDevices([{ kind: 'videoinput', deviceId: '' }]);
    render(<ChatAttachmentButtons mediaProvider={mediaProvider('unused')} onError={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Take photo' })).toBeTruthy();
    expect(screen.queryByTestId('chat-camera-input')).toBeNull();
  });

  it('inserts a viewfinder photo and lets the dialog report a failed upload', async () => {
    setMediaDevices([{ kind: 'videoinput', deviceId: 'cam-1' }]);
    const provider = mediaProvider('attachments/photo-2026.jpg');
    render(<ChatAttachmentButtons mediaProvider={provider} onError={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Take photo' }));
    await screen.findByTestId('camera-dialog');
    const photo = selectableFile('photo-2026-10-06-101500.jpg', 'image/jpeg');
    await cameraDialogProps.current!.onCapture(photo);
    expect(insertAtCursor).toHaveBeenCalledWith('![Photo](attachments/photo-2026.jpg)');

    vi.mocked(provider.addMedia).mockRejectedValueOnce(new Error('Disk full'));
    await expect(cameraDialogProps.current!.onCapture(photo)).rejects.toThrow('Disk full');
  });
});
