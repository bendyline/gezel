import type React from 'react';
import { useRef } from 'react';
import { Dialog } from '../primitives/index.js';

/**
 * Reusable full-screen image preview overlay. Click outside or hit
 * the X button (or press Escape) to close. Used for tool-call
 * screenshots today; intended to be the common surface for any
 * "click thumbnail to enlarge" interaction the app picks up later.
 *
 * Renders through the shared dialog portal so it's not confined by a
 * parent's overflow or stacking context. The image scales to fit the
 * viewport so very tall or wide screenshots stay fully visible.
 */
export function ImagePreview({
  src,
  alt,
  caption,
  onClose,
  downloadFilename,
}: {
  src: string;
  alt?: string;
  /** Optional small label rendered under the image (filename, MIME, etc.). */
  caption?: string;
  onClose: () => void;
  /**
   * When set, render a Download button alongside the close affordance.
   * Browsers honor the `download` attribute on object-URL hrefs, so
   * `src` (already a `blob:` URL when this overlay is reached via the
   * tool-call thumbnails) suffices as the source — no second fetch.
   * The filename ships verbatim via `<a download>` so the user gets
   * the artifact's original name on disk.
   */
  downloadFilename?: string;
}): React.ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="image-preview-backdrop" />
        <Dialog.Content
          className="image-preview-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Image preview</Dialog.Title>
          <div className="image-preview-actions">
            {downloadFilename && (
              <a
                className="image-preview-download"
                href={src}
                download={downloadFilename}
                aria-label={`Download ${downloadFilename}`}
                title={`Download ${downloadFilename}`}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 1.5v8m0 0L4.5 6m3.5 3.5L11.5 6M2 12.5h12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="sr-only">Download {downloadFilename}</span>
              </a>
            )}
            <Dialog.Close asChild>
              <button
                ref={closeRef}
                type="button"
                className="image-preview-close"
                aria-label="Close preview"
                title="Close preview"
              >
                ×
              </button>
            </Dialog.Close>
          </div>
          <div className="image-preview-content">
            <img className="image-preview-img" src={src} alt={alt ?? ''} />
            <Dialog.Description asChild>
              {caption ? (
                <div className="image-preview-caption" title={caption}>
                  {caption}
                </div>
              ) : (
                <span className="sr-only">Enlarged image</span>
              )}
            </Dialog.Description>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
