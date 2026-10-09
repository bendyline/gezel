import { useState } from 'react';
import { PhotoThumb } from './PhotoThumb.js';

export interface PhotoGridItem {
  path: string;
  caption?: string;
  /** A second muted line under the caption: why a pick made the cut. */
  note?: string;
}

/**
 * Photos as a square-tiled grid that fills its width. Shows a page at a time
 * with a "Show more" key instead of rendering a library at once, and each
 * tile loads its thumbnail only when it scrolls into view.
 */
export function PhotoGrid({
  projectId,
  photos,
  pageSize = 60,
  showCaptions = false,
  onOpen,
}: {
  projectId: string;
  photos: PhotoGridItem[];
  pageSize?: number;
  showCaptions?: boolean;
  onOpen?: (path: string) => void;
}) {
  const [shown, setShown] = useState(pageSize);
  const visible = photos.slice(0, shown);
  return (
    <div className="photo-grid-wrap">
      <ul className={`photo-grid${showCaptions ? ' with-captions' : ''}`}>
        {visible.map((photo) => {
          const tile = <PhotoThumb projectId={projectId} path={photo.path} alt={photo.caption} />;
          return (
            <li key={photo.path} className="photo-grid-item">
              {onOpen ? (
                <button
                  type="button"
                  className="photo-grid-tile"
                  title={photo.path}
                  onClick={() => onOpen(photo.path)}
                >
                  {tile}
                </button>
              ) : (
                <span className="photo-grid-tile" title={photo.path}>
                  {tile}
                </span>
              )}
              {showCaptions && (photo.caption || photo.note) && (
                <span className="photo-grid-caption small">
                  {photo.caption}
                  {photo.note && <span className="muted"> {photo.note}</span>}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {photos.length > shown && (
        <button
          type="button"
          className="secondary small"
          onClick={() => setShown((n) => n + pageSize)}
        >
          Show {Math.min(pageSize, photos.length - shown)} more
        </button>
      )}
    </div>
  );
}
