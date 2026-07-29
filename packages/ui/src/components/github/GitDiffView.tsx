import type { GitChangeKind } from '@bendyline/gezel';
import { useMemo, useState } from 'react';
import { parseUnifiedDiff } from './diffModel.js';
import { GIT_COPY, plural } from './gitCopy.js';

/**
 * Jargon-free unified-diff renderer for the GitHub tab. Hunk headers are
 * hidden — quiet "N unchanged lines" separators stand in for `@@` rows —
 * with a dual line-number gutter and word-wrap so prose-y files don't
 * scroll sideways. Dependency-free like ToolDiffBlock, but built for a
 * full pane rather than a collapsed chat row.
 */

/** Render at most this many lines until the reader asks for everything. */
const COLLAPSE_LINE_LIMIT = 500;

interface Props {
  diff?: string;
  kind?: GitChangeKind;
  oldPath?: string;
  binary?: boolean;
  /** True when the backend cut the diff at its size cap. */
  truncated?: boolean;
}

export function GitDiffView({ diff, kind, oldPath, binary, truncated }: Props) {
  const [showAll, setShowAll] = useState(false);
  const parsed = useMemo(() => parseUnifiedDiff(diff ?? ''), [diff]);

  if (binary) {
    return <p className="git-diff-placeholder muted">{GIT_COPY.diffBinary}</p>;
  }

  const totalLines = parsed.hunks.reduce((n, h) => n + h.lines.length, 0);
  if (totalLines === 0) {
    return (
      <p className="git-diff-placeholder muted">
        {kind === 'renamed' && oldPath
          ? `Moved from ${oldPath} — the content didn't change.`
          : 'No differences to show.'}
      </p>
    );
  }

  const limit = showAll ? Number.POSITIVE_INFINITY : COLLAPSE_LINE_LIMIT;
  let rendered = 0;
  let clipped = false;

  return (
    <div className="git-diff">
      {kind === 'deleted' && (
        <div className="git-diff-note git-diff-note-deleted">This file was deleted.</div>
      )}
      {kind === 'renamed' && oldPath && (
        <div className="git-diff-note">
          Moved from <code>{oldPath}</code>
        </div>
      )}
      <div className="git-diff-body">
        {parsed.hunks.map((hunk, hi) => {
          if (rendered >= limit) {
            clipped = true;
            return null;
          }
          const lines = hunk.lines.slice(0, Math.max(0, limit - rendered));
          if (lines.length < hunk.lines.length) clipped = true;
          rendered += lines.length;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no stable id; position is the only key
            <div key={hi}>
              {hunk.skippedBefore > 0 && (
                <div className="git-diff-sep" aria-hidden>
                  · · · {plural(hunk.skippedBefore, 'unchanged line')} · · ·
                </div>
              )}
              {lines.map((line, li) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id; position is the only key
                <div key={li} className={`git-diff-line git-diff-line-${line.kind}`}>
                  <span className="git-diff-gutter" aria-hidden>
                    {line.oldNo ?? ''}
                  </span>
                  <span className="git-diff-gutter" aria-hidden>
                    {line.newNo ?? ''}
                  </span>
                  <span className="git-diff-marker" aria-hidden>
                    {line.kind === 'add' ? '+' : line.kind === 'rem' ? '−' : ''}
                  </span>
                  <span className="git-diff-text">{line.text}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {(clipped || truncated) && (
        <div className="git-diff-truncation">
          <span className="muted small">{GIT_COPY.diffBig}</span>
          {clipped && !showAll && (
            <button type="button" className="git-diff-show-all" onClick={() => setShowAll(true)}>
              {GIT_COPY.diffShowAll}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
