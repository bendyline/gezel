import type { GitHubPullDetail, GitHubPullSummary } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

/**
 * The Pull requests sub-tab: open-PR list on the left, a read-only
 * detail panel (description, per-file patches, comments) on the right.
 * Extracted as-is from the original ProjectGitHubView; gezels do the
 * actual PR actions via the github toolset's MCP tools.
 */

interface Props {
  projectId: string;
}

export function PullRequestsView({ projectId }: Props) {
  const [pulls, setPulls] = useState<GitHubPullSummary[] | null>(null);
  const [selectedPr, setSelectedPr] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPulls(null);
    setSelectedPr(null);
    setError(null);
    let cancelled = false;
    void api
      .listProjectGitHubPulls(projectId)
      .then((res) => {
        if (!cancelled) setPulls(res.pulls);
      })
      .catch((err) => {
        if (cancelled) return;
        setPulls([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="project-files-layout">
      <div className="file-tree-panel">
        {error && (
          <p className="error" style={{ padding: '0.5rem' }}>
            {error}
          </p>
        )}
        {pulls === null && (
          <p className="muted" style={{ padding: '0.5rem' }}>
            Loading…
          </p>
        )}
        {pulls && pulls.length === 0 && !error && (
          <p className="muted" style={{ padding: '0.5rem' }}>
            No open pull requests.
          </p>
        )}
        {pulls && pulls.length > 0 && (
          <ul className="pr-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {pulls.map((pr) => (
              <li key={pr.number} style={{ borderBottom: '1px solid var(--border-color, #eee)' }}>
                <button
                  type="button"
                  className={selectedPr === pr.number ? 'active' : ''}
                  onClick={() => setSelectedPr(pr.number)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.5rem 0.6rem',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 500 }}>
                    #{pr.number} {pr.title} {pr.draft && <em className="muted">(draft)</em>}
                  </div>
                  <div className="muted small">
                    by {pr.author} — {pr.headRef} → {pr.baseRef}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="file-viewer-panel">
        {selectedPr !== null ? (
          <PrDetailPanel projectId={projectId} num={selectedPr} />
        ) : (
          <p className="placeholder" style={{ padding: '2rem' }}>
            Select a pull request to view its details.
          </p>
        )}
      </div>
    </div>
  );
}

function PrDetailPanel({ projectId, num }: { projectId: string; num: number }) {
  const [detail, setDetail] = useState<GitHubPullDetail | null>(null);
  const [files, setFiles] = useState<
    Awaited<ReturnType<typeof api.listProjectGitHubPullFiles>>['files'] | null
  >(null);
  const [comments, setComments] = useState<
    Awaited<ReturnType<typeof api.listProjectGitHubPullComments>>['comments'] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setFiles(null);
    setComments(null);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const [d, f, c] = await Promise.all([
          api.getProjectGitHubPull(projectId, num),
          listAllPullFiles(projectId, num),
          api.listProjectGitHubPullComments(projectId, num),
        ]);
        if (cancelled) return;
        setDetail(d);
        setFiles(f);
        setComments(c.comments);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, num]);

  if (error)
    return (
      <p className="error" style={{ padding: '1rem' }}>
        {error}
      </p>
    );
  if (!detail)
    return (
      <p className="muted" style={{ padding: '1rem' }}>
        Loading…
      </p>
    );

  return (
    <div style={{ padding: '0.5rem 0.75rem', overflow: 'auto', height: 'calc(100vh - 320px)' }}>
      <h3 style={{ marginTop: 0 }}>
        #{detail.number} {detail.title}
      </h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        by {detail.author} — {detail.headRef} → {detail.baseRef} —{' '}
        <a href={detail.url} target="_blank" rel="noreferrer">
          view on GitHub
        </a>
      </p>
      <p className="muted small">
        {detail.merged ? 'merged' : detail.state} · {detail.changedFiles} files · +
        {detail.additions} −{detail.deletions}
      </p>
      {detail.body && (
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            background: 'var(--code-bg, #f6f8fa)',
            padding: '0.5rem',
            borderRadius: 4,
          }}
        >
          {detail.body}
        </pre>
      )}
      <h4>Files changed</h4>
      {files && files.length === 0 && <p className="muted small">No files.</p>}
      {files && files.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {files.map((f) => (
            <li key={f.filename} style={{ marginBottom: '0.5rem' }}>
              <details>
                <summary>
                  <code>{f.filename}</code>{' '}
                  <span className="muted small">
                    {f.status} +{f.additions} −{f.deletions}
                  </span>
                </summary>
                {f.patch ? (
                  <pre
                    style={{
                      background: 'var(--code-bg, #f6f8fa)',
                      padding: '0.5rem',
                      overflow: 'auto',
                      fontSize: '0.8rem',
                    }}
                  >
                    {f.patch}
                  </pre>
                ) : (
                  <p className="muted small">No patch returned (binary or too large).</p>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
      <h4>Comments</h4>
      {comments && comments.length === 0 && <p className="muted small">No comments yet.</p>}
      {comments && comments.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {comments.map((c) => (
            <li
              key={c.id}
              style={{
                marginBottom: '0.75rem',
                borderLeft: '3px solid var(--border-color, #ddd)',
                paddingLeft: '0.5rem',
              }}
            >
              <div className="muted small">
                <strong>{c.author}</strong> · {c.kind}
                {c.path && (
                  <>
                    {' '}
                    on <code>{c.path}</code>
                  </>
                )}
                {' · '}
                {new Date(c.createdAt).toLocaleString()}
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>
                {c.body}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function listAllPullFiles(
  projectId: string,
  num: number,
): Promise<Awaited<ReturnType<typeof api.listProjectGitHubPullFiles>>['files']> {
  const files: Awaited<ReturnType<typeof api.listProjectGitHubPullFiles>>['files'] = [];
  let offset = 0;
  for (;;) {
    const page = await api.listProjectGitHubPullFiles(projectId, num, {
      offset,
      limit: 200,
      includePatch: true,
    });
    files.push(...page.files);
    if (!page.hasMore || page.nextOffset === undefined) return files;
    offset = page.nextOffset;
  }
}
