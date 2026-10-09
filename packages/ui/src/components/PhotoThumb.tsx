import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * A workspace photo at thumbnail size, from the daemon's per-account cache.
 * Loads when it scrolls into view, so a grid of hundreds asks for the dozen
 * on screen; `<img src>` cannot carry the bearer token, so the bytes arrive
 * as a Blob. A photo this machine cannot read shows its initial, never the
 * browser's broken-image glyph.
 */
export function PhotoThumb({
  projectId,
  path,
  width = 320,
  alt,
  className,
}: {
  projectId: string;
  path: string;
  width?: 160 | 320 | 640;
  alt?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const label = alt ?? path.slice(path.lastIndexOf('/') + 1);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFailed(false);
    api
      .fetchProjectThumbnail(projectId, path, width, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, projectId, path, width]);

  return (
    <span ref={ref} className={`photo-thumb${className ? ` ${className}` : ''}`}>
      {url && !failed ? (
        <img src={url} alt={label} loading="lazy" />
      ) : (
        <span className="photo-thumb-fallback" aria-label={failed ? label : undefined}>
          {failed ? label.slice(0, 1).toUpperCase() : ''}
        </span>
      )}
    </span>
  );
}
