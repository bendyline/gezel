import type { GitCommitDetailResponse, GitLogEntry } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { GitDiffView } from './GitDiffView.js';
import { splitMultiFileDiff } from './diffModel.js';
import { GIT_COPY, friendlyDate, plural } from './gitCopy.js';

/**
 * Plain-language save history: "Alex saved 3 files · yesterday" rows on
 * the left, the selected save's per-file diffs on the right. Saves with
 * no diff of their own (merge commits) read as sync points.
 */

const PAGE_SIZE = 50;

interface Props {
  projectId: string;
}

export function GitTimelineView({ projectId }: Props) {
  const [commits, setCommits] = useState<GitLogEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetailResponse | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (skip: number) => {
      const res = await api.getProjectGitLog(projectId, { limit: PAGE_SIZE, skip });
      setHasMore(res.hasMore);
      setCommits((prev) => (skip === 0 ? res.commits : [...(prev ?? []), ...res.commits]));
    },
    [projectId],
  );

  useEffect(() => {
    setCommits(null);
    setSelectedSha(null);
    setDetail(null);
    void load(0).catch(() => setCommits([]));
  }, [load]);

  useEffect(() => {
    if (!selectedSha) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    void api
      .getProjectGitCommit(projectId, selectedSha)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedSha]);

  if (commits === null) {
    return <p className="muted gh-timeline-loading">Loading…</p>;
  }
  if (commits.length === 0) {
    return <p className="muted gh-timeline-empty">{GIT_COPY.timelineEmpty}</p>;
  }

  const sections = detail?.diff ? splitMultiFileDiff(detail.diff) : [];

  return (
    <div className="gh-timeline-layout">
      <div className="gh-timeline-rail">
        <ul className="gh-timeline-list">
          {commits.map((c) => (
            <li key={c.sha}>
              <button
                type="button"
                className={`gh-timeline-item${c.sha === selectedSha ? ' is-selected' : ''}`}
                onClick={() => setSelectedSha(c.sha)}
              >
                <span className="gh-timeline-subject">{c.subject}</span>
                <span className="muted small">
                  {c.author} saved {plural(c.filesChanged, 'file')} · {friendlyDate(c.date)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hasMore && (
          <button
            type="button"
            className="gh-timeline-more"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void load(commits.length).finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? 'Loading…' : 'Show earlier saves'}
          </button>
        )}
      </div>
      <div className="gh-timeline-detail">
        {selectedSha === null ? (
          <p className="placeholder">Pick a save to see what changed.</p>
        ) : detail === null ? (
          <p className="muted gh-timeline-loading">Loading…</p>
        ) : (
          <>
            <div className="gh-timeline-detail-header">
              <strong>{detail.subject}</strong>
              <span className="muted small">
                {detail.author} · {friendlyDate(detail.date)}
              </span>
            </div>
            {sections.length === 0 ? (
              <p className="muted">
                Sync point — this save combined changes that are each shown separately.
              </p>
            ) : (
              sections.map((section) => (
                <div key={section.path || 'diff'} className="gh-timeline-file">
                  {section.path && (
                    <div className="gh-timeline-file-path">
                      <code>{section.path}</code>
                    </div>
                  )}
                  <GitDiffView diff={section.diff} />
                </div>
              ))
            )}
            {detail.truncated && <p className="muted small">{GIT_COPY.diffBig}</p>}
          </>
        )}
      </div>
    </div>
  );
}
