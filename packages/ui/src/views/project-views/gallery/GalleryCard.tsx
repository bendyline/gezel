import type { GalleryItem } from '@bendyline/gezel';
import { FileTypeIcon } from '../../../components/FileTypeIcon.js';
import { PhotoThumb } from '../../../components/PhotoThumb.js';
import { formatRelativeTime } from '../../../relative-time.js';

/** One file on a gallery shelf: a photo as its picture, anything else as a card. */
export function GalleryCard({
  projectId,
  item,
  selected,
  onSelect,
}: {
  projectId: string;
  item: GalleryItem;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const current = selected ? 'true' : undefined;
  if (item.family === 'photos' && item.type !== 'drawing' && item.type !== 'icon') {
    return (
      <button
        type="button"
        className="gallery-card gallery-card--photo"
        data-path={item.path}
        aria-current={current}
        aria-label={item.name}
        title={item.lead ? `${item.path}\n${item.lead}` : item.path}
        onClick={() => onSelect(item.path)}
      >
        <PhotoThumb projectId={projectId} path={item.path} alt={item.lead ?? item.name} />
      </button>
    );
  }
  const slash = item.path.lastIndexOf('/');
  const folder = slash < 0 ? '' : item.path.slice(0, slash);
  return (
    <button
      type="button"
      className="gallery-card"
      data-path={item.path}
      aria-current={current}
      title={item.path}
      onClick={() => onSelect(item.path)}
    >
      <span className="gallery-card-type">
        <FileTypeIcon name={item.name} />
        {item.typeLabel}
      </span>
      <span className="gallery-card-title">{item.title ?? item.name}</span>
      {item.lead && <span className="gallery-card-lead">{item.lead}</span>}
      <span className="gallery-card-meta">
        {(item.title || folder) && (
          <span className="gallery-card-folder">{item.title ? item.path : folder}</span>
        )}
        <span>{formatRelativeTime(item.mtimeMs)}</span>
      </span>
    </button>
  );
}
