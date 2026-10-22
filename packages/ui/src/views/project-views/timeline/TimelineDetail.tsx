import type { TimelineBucket, TimelineBucketResponse } from '@bendyline/gezel';
import { GalleryCard } from '../gallery/GalleryCard.js';

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** One stretch of the timeline: what was committed, and the files it touched most. */
export function TimelineDetail({
  projectId,
  bucket,
  detail,
  error,
  selectedPath,
  onSelectPath,
}: {
  projectId: string;
  bucket: TimelineBucket;
  detail: TimelineBucketResponse | null;
  error: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const summary =
    detail?.source === 'git'
      ? `${bucket.commits} ${bucket.commits === 1 ? 'commit' : 'commits'} · ${bucket.files} ${bucket.files === 1 ? 'file' : 'files'} changed`
      : `${bucket.files} ${bucket.files === 1 ? 'file' : 'files'}`;
  return (
    <section className="timeline-detail" aria-label={bucket.label}>
      <header className="timeline-detail-header">
        <h3>{bucket.label}</h3>
        <span className="timeline-detail-summary">{summary}</span>
      </header>
      {error && <p className="timeline-view-empty">Couldn’t load this stretch: {error}</p>}
      {detail && detail.commits.length === 0 && detail.files.length === 0 && (
        <p className="timeline-view-empty">Nothing changed in this stretch.</p>
      )}
      {detail && detail.commits.length > 0 && (
        <ol className="timeline-commits">
          {detail.commits.map((commit) => (
            <li key={commit.sha} className="timeline-commit">
              <time dateTime={commit.at}>{when(commit.at)}</time>
              <span className="timeline-commit-subject">{commit.subject || 'No message'}</span>
              <span className="timeline-commit-files">
                {commit.files.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="timeline-file-link"
                    aria-current={path === selectedPath ? 'true' : undefined}
                    title={path}
                    onClick={() => onSelectPath(path)}
                  >
                    {path.slice(path.lastIndexOf('/') + 1)}
                  </button>
                ))}
                {commit.fileCount > commit.files.length && (
                  <span className="timeline-commit-more">
                    and {commit.fileCount - commit.files.length} more
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {detail && detail.files.length > 0 && (
        <>
          <h4>{detail.source === 'git' ? 'Changed most' : 'Files from this stretch'}</h4>
          <ul
            className={
              detail.files.every((f) => f.family === 'photos')
                ? 'gallery-grid gallery-grid--photos'
                : 'gallery-grid'
            }
          >
            {detail.files.map((file) => (
              <li key={file.path}>
                <GalleryCard
                  projectId={projectId}
                  item={file}
                  selected={file.path === selectedPath}
                  onSelect={onSelectPath}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {detail?.truncated && (
        <p className="timeline-view-note">
          Showing the first of many; pick a shorter stretch to see more.
        </p>
      )}
    </section>
  );
}
