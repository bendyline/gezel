import {
  type EditorContextMenuItem,
  useEditorContext,
  useEditorContextMenuItems,
} from '@bendyline/squisq-editor-react';
import { useCallback, useEffect, useMemo } from 'react';

interface ComposerImageClipboardProps {
  onError: (message: string | null) => void;
}

const COPY_ERROR = 'Could not copy that image.';

function imageAt(target: Element): HTMLImageElement | null {
  return target.closest<HTMLImageElement>('img.squisq-image');
}

async function renderImageAsPng(image: HTMLImageElement): Promise<Blob> {
  if (!image.complete) await image.decode();
  if (image.naturalWidth < 1 || image.naturalHeight < 1) {
    throw new Error('image has no decoded pixels');
  }

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas is unavailable');
  context.drawImage(image, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('image could not be encoded'));
    }, 'image/png');
  });
}

async function clipboardPng(image: HTMLImageElement): Promise<Blob> {
  const src = image.currentSrc || image.src;
  if (!src) throw new Error('image has no source');
  const response = await fetch(src);
  if (!response.ok) throw new Error(`image read failed (${response.status})`);
  const source = await response.blob();
  return source.type.toLowerCase() === 'image/png' ? source : renderImageAsPng(image);
}

/**
 * Copy the pixels rather than the editor's Markdown/HTML image node. Passing
 * the still-loading PNG promise into ClipboardItem lets the browser begin the
 * privileged clipboard write during the user's click or key gesture.
 */
export async function copyComposerImage(image: HTMLImageElement): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('image clipboard is unavailable');
  }
  const item = new ClipboardItem({ 'image/png': clipboardPng(image) });
  await navigator.clipboard.write([item]);
}

/**
 * Adds the image-aware part of the composer clipboard contract to Squisq's
 * shared context menu. It also catches Copy while Tiptap has an image node
 * selected; ordinary text selections continue through Squisq/ProseMirror.
 */
export function ComposerImageClipboard({ onError }: ComposerImageClipboardProps) {
  const { tiptapEditor } = useEditorContext();
  const copy = useCallback(
    async (image: HTMLImageElement) => {
      onError(null);
      try {
        await copyComposerImage(image);
      } catch {
        onError(COPY_ERROR);
      }
    },
    [onError],
  );

  const contextMenuItems = useMemo<readonly EditorContextMenuItem[]>(
    () => [
      {
        id: 'gezel.copy-composer-image',
        label: 'Copy image',
        group: 'image',
        when: ({ target }) => imageAt(target) !== null,
        onSelect: ({ target }) => {
          const image = imageAt(target);
          if (image) return copy(image);
        },
      },
    ],
    [copy],
  );
  useEditorContextMenuItems(contextMenuItems);

  useEffect(() => {
    if (!tiptapEditor) return;
    const { view } = tiptapEditor;
    const onCopy = (event: Event) => {
      const { selection } = tiptapEditor.state;
      const selectedNode =
        'node' in selection
          ? (selection as { node?: { type?: { name?: string } } }).node
          : undefined;
      if (selectedNode?.type?.name !== 'image') return;
      const dom = view.nodeDOM(selection.from);
      const image =
        dom instanceof HTMLImageElement
          ? dom
          : dom instanceof Element
            ? dom.querySelector<HTMLImageElement>('img.squisq-image')
            : null;
      if (!image) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void copy(image);
    };

    view.dom.addEventListener('copy', onCopy, true);
    return () => view.dom.removeEventListener('copy', onCopy, true);
  }, [copy, tiptapEditor]);

  return null;
}
