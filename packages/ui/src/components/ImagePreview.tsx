import type React from 'react';
import { useEffect } from 'react';

/**
 * Reusable full-screen image preview overlay. Click outside or hit
 * the X button (or press Escape) to close. Used for tool-call
 * screenshots today; intended to be the common surface for any
 * "click thumbnail to enlarge" interaction the app picks up later.
 *
 * Renders a fixed-position backdrop + centered image so it's not
 * confined by any parent's `overflow: hidden`. The image scales to
 * fit the viewport (max-width / max-height: 95%) so very tall or wide
 * screenshots stay fully visible without scrollbars.
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
  // Escape-to-close. Listen on document so the handler fires regardless
  // of where focus is (the overlay itself doesn't auto-focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lock body scroll while the preview is open so wheel/trackpad
  // gestures don't scroll the chat behind it.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();
  };
  const onBackdropKey = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <dialog
      className="image-preview-backdrop"
      open
      onClick={onBackdropClick}
      onKeyDown={onBackdropKey}
      aria-label="Image preview"
    >
      <div className="image-preview-actions">
        {downloadFilename && (
          <a
            className="image-preview-download"
            href={src}
            download={downloadFilename}
            aria-label={`Download ${downloadFilename}`}
            title={`Download ${downloadFilename}`}
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label={`Download ${downloadFilename}`}
            >
              <title>{`Download ${downloadFilename}`}</title>
              <path
                d="M8 1.5v8m0 0L4.5 6m3.5 3.5L11.5 6M2 12.5h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        )}
        <button
          type="button"
          className="image-preview-close"
          onClick={onClose}
          aria-label="Close preview"
        >
          ×
        </button>
      </div>
      <div className="image-preview-content">
        <img className="image-preview-img" src={src} alt={alt ?? ''} />
        {caption && <div className="image-preview-caption">{caption}</div>}
      </div>
    </dialog>
  );
}
