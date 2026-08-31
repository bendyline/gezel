// @vitest-environment jsdom

import type { MediaProvider } from '@bendyline/squisq';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const insertAtCursor = vi.hoisted(() => vi.fn());
const bumpMediaRevision = vi.hoisted(() => vi.fn());

vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ bumpMediaRevision, insertAtCursor }),
}));

const { ChatAttachmentButtons } = await import('./ChatAttachmentButtons.js');

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
  });

  afterEach(() => {
    cleanup();
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
});
