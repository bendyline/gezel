import type { FileInsightResponse } from '@bendyline/gezel';
import { useState } from 'react';

type ConnectionGroup = 'imports' | 'importedBy' | 'links' | 'linkedFrom' | 'duplicates';

const GROUP_LABEL: Record<ConnectionGroup, string> = {
  imports: 'Imports',
  importedBy: 'Imported by',
  links: 'Links to',
  linkedFrom: 'Linked from',
  duplicates: 'Copies',
};

/** How many rows a connection list shows before "Show all". */
const FIRST_ROWS = 8;

/**
 * What the index says about the file: its summary and the purpose of its
 * folder, then the files it is connected to. Each connection opens in the
 * current view. Renders nothing it doesn't have.
 */
export function InspectorInsight({
  insight,
  fallbackSummary,
  onSelectPath,
}: {
  insight: FileInsightResponse | null;
  /** The code context's summary, used until the insight arrives. */
  fallbackSummary?: string | null;
  onSelectPath: (path: string) => void;
}) {
  const [open, setOpen] = useState<ConnectionGroup | null>(null);
  const [showAll, setShowAll] = useState(false);
  const summary = insight?.summary?.text ?? fallbackSummary ?? null;
  const folder = insight?.folder;
  const conn = insight?.connections;
  const groups = (['imports', 'importedBy', 'links', 'linkedFrom', 'duplicates'] as const)
    .map((g) => ({
      group: g,
      items:
        g === 'duplicates'
          ? (conn?.duplicates ?? []).map((path) => ({ path, names: [] as string[] }))
          : (conn?.[g] ?? []),
    }))
    .filter((g) => g.items.length > 0);
  const current = groups.find((g) => g.group === open);

  if (!summary && !folder?.purpose && groups.length === 0) return null;
  return (
    <>
      {(summary || folder?.purpose) && (
        <section className="file-inspector-summary" aria-label="Summary">
          {summary && <p>{summary}</p>}
          {folder?.purpose && (
            <p className="file-inspector-folder">
              <span className="file-inspector-folder-name">
                {folder.purposePath ?? folder.path}
              </span>{' '}
              — {folder.purpose}
            </p>
          )}
        </section>
      )}
      {groups.length > 0 && (
        <section className="file-inspector-connections" aria-label="Connections">
          <div className="gz-tray file-inspector-connection-keys">
            {groups.map(({ group, items }) => (
              <button
                key={group}
                type="button"
                className={`gz-key${open === group ? ' gz-key-active' : ''}`}
                aria-expanded={open === group}
                onClick={() => {
                  setOpen((o) => (o === group ? null : group));
                  setShowAll(false);
                }}
              >
                {GROUP_LABEL[group]} <span className="file-inspector-count">{items.length}</span>
              </button>
            ))}
          </div>
          {current && (
            <ul className="file-inspector-connection-list">
              {(showAll ? current.items : current.items.slice(0, FIRST_ROWS)).map((item) => (
                <li key={item.path}>
                  <button
                    type="button"
                    className="link-button"
                    title={item.path}
                    onClick={() => onSelectPath(item.path)}
                  >
                    {item.path}
                  </button>
                  {item.names.length > 0 && (
                    <span className="file-inspector-names">{item.names.join(', ')}</span>
                  )}
                </li>
              ))}
              {!showAll && current.items.length > FIRST_ROWS && (
                <li>
                  <button type="button" className="link-button" onClick={() => setShowAll(true)}>
                    Show all {current.items.length}
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

/** Chips for the facts the insight adds: when a photo was taken, its size, git activity. */
export function insightChips(insight: FileInsightResponse | null): string[] {
  if (!insight) return [];
  const chips: string[] = [];
  const media = insight.media;
  if (media?.takenAt) chips.push(`taken ${media.takenAt.slice(0, 10)}`);
  if (media?.width && media.height) chips.push(`${media.width}×${media.height}`);
  if (media?.cameraModel) chips.push(media.cameraModel);
  if (media?.screenshot) chips.push('screenshot');
  if (insight.git) {
    chips.push(`${insight.git.commits} commit${insight.git.commits === 1 ? '' : 's'} this year`);
  }
  return chips;
}
