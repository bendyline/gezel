import type { IncompleteModelDownload } from '@bendyline/gezel-client';
import { formatBytes } from './engine-pill-stats.js';

/**
 * Surfaces interrupted or unverified model downloads — directories that hold
 * bytes on disk but no install manifest, so they never appear in the installed
 * list. Without this they stay invisible until the daemon's 7-day reclaim
 * sweep silently deletes them; here the user can resume a still-cataloged one
 * or delete it to reclaim the disk now. Shared by the llama-cpp / ds4 / mlx
 * model managers. Renders nothing when there are no incomplete downloads.
 */
export function IncompleteDownloads({
  items,
  onResume,
  onDelete,
}: {
  items: IncompleteModelDownload[];
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ollama-section">
      <h4>Incomplete downloads</h4>
      <p className="muted small" style={{ marginBottom: '0.5rem' }}>
        These downloads were interrupted or never finished checking. They take up disk space but
        aren't usable yet.
      </p>
      <div className="ollama-pull-list">
        {items.map((d) => (
          <div key={d.id} className="ollama-pull">
            <div className="ollama-pull-head">
              <code>{d.name ?? d.id}</code>
              <span className="muted small">
                {formatBytes(d.bytes)}
                {d.resumable ? '' : ' · no longer in the catalog'}
              </span>
              <span style={{ display: 'inline-flex', gap: '0.75rem' }}>
                {d.resumable && (
                  <button type="button" className="gz-link-button" onClick={() => onResume(d.id)}>
                    Resume
                  </button>
                )}
                <button type="button" className="gz-link-button" onClick={() => onDelete(d.id)}>
                  Delete
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
