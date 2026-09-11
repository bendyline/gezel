// @vitest-environment jsdom

import type { EditorContextMenuItem } from '@bendyline/squisq-editor-react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerImageClipboard, copyComposerImage } from './ComposerImageClipboard.js';

const editorHarness = vi.hoisted(() => ({
  contextMenuItems: [] as EditorContextMenuItem[],
  tiptapEditor: null as null | {
    state: { selection: object };
    view: {
      dom: HTMLElement;
      nodeDOM: (position: number) => Node | null;
    };
  },
}));

vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ tiptapEditor: editorHarness.tiptapEditor }),
  useEditorContextMenuItems: (items: EditorContextMenuItem[]) => {
    editorHarness.contextMenuItems = [...items];
  },
}));

class MockClipboardItem {
  constructor(readonly items: Record<string, string | Blob | PromiseLike<string | Blob>>) {}
}

function pngClipboard() {
  const png = new Blob(['pixels'], { type: 'image/png' });
  const write = vi.fn<(items: ClipboardItems) => Promise<void>>(async () => {});
  vi.stubGlobal('ClipboardItem', MockClipboardItem);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => png,
    })),
  );
  return { png, write };
}

function composerImage(): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'squisq-image';
  image.src = 'blob:composer-image';
  return image;
}

describe('ComposerImageClipboard', () => {
  beforeEach(() => {
    editorHarness.contextMenuItems = [];
    editorHarness.tiptapEditor = null;
    vi.unstubAllGlobals();
  });

  it('writes an inline PNG to the image clipboard, not as editor text', async () => {
    const { png, write } = pngClipboard();
    const image = composerImage();

    await copyComposerImage(image);

    expect(fetch).toHaveBeenCalledWith('blob:composer-image');
    expect(write).toHaveBeenCalledTimes(1);
    const clipboardItem = write.mock.calls[0]![0][0] as unknown as MockClipboardItem;
    expect(await clipboardItem.items['image/png']).toBe(png);
  });

  it('adds Copy image only at an inline Squisq image location', async () => {
    const { write } = pngClipboard();
    const onError = vi.fn();
    render(<ComposerImageClipboard onError={onError} />);
    const item = editorHarness.contextMenuItems[0]!;
    const image = composerImage();

    expect(item.label).toBe('Copy image');
    expect((item.when as (context: object) => boolean)({ target: image })).toBe(true);
    expect(
      (item.when as (context: object) => boolean)({ target: document.createElement('p') }),
    ).toBe(false);
    await item.onSelect({ target: image } as never);

    expect(onError).toHaveBeenCalledWith(null);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('uses Ctrl/Cmd+C to copy the pixels when Tiptap selected the image node', async () => {
    const { write } = pngClipboard();
    const root = document.createElement('div');
    const figure = document.createElement('figure');
    const image = composerImage();
    figure.append(image);
    root.append(figure);
    document.body.append(root);
    editorHarness.tiptapEditor = {
      state: { selection: { from: 4, node: { type: { name: 'image' } } } },
      view: { dom: root, nodeDOM: () => figure },
    };
    render(<ComposerImageClipboard onError={vi.fn()} />);

    const event = new Event('copy', { bubbles: true, cancelable: true });
    image.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  });
});
