import type { GitConflictKind, GitConflictVersionsResponse } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { GIT_COPY } from './gitCopy.js';

/**
 * One conflicted file's resolution surface: stacked "Your version" /
 * "GitHub's version" cards with keep buttons, plus the AI combine flow
 * (propose → preview → use / edit / back). Stacked, not side-by-side —
 * easier to read for non-technical users and safe at narrow widths.
 */

export type Resolution = 'mine' | 'theirs' | 'combined';

interface Props {
  projectId: string;
  path: string;
  kind: GitConflictKind;
  busy: boolean;
  onResolve: (choice: 'mine' | 'theirs' | 'custom', content?: string) => void | Promise<void>;
}

type AiState =
  | { step: 'idle' }
  | { step: 'combining' }
  | { step: 'preview'; content: string }
  | { step: 'editing'; content: string };

export function ConflictFileCard({ projectId, path, kind, busy, onResolve }: Props) {
  const [versions, setVersions] = useState<GitConflictVersionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiState>({ step: 'idle' });

  useEffect(() => {
    setVersions(null);
    setError(null);
    setAi({ step: 'idle' });
    let cancelled = false;
    void api
      .getProjectGitConflictVersions(projectId, path)
      .then((v) => {
        if (!cancelled) setVersions(v);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  const combine = async () => {
    setAi({ step: 'combining' });
    try {
      const res = await api.aiResolveProjectGitConflict(projectId, path);
      setAi({ step: 'preview', content: res.merged });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAi({ step: 'idle' });
    }
  };

  if (error) {
    return <p className="error gh-conflict-error">{error}</p>;
  }
  if (!versions) {
    return <p className="muted gh-conflict-loading">Loading…</p>;
  }

  const aiAvailable =
    !versions.binary &&
    !versions.tooLarge &&
    versions.ours !== undefined &&
    versions.theirs !== undefined;

  if (ai.step === 'combining') {
    return <p className="muted gh-conflict-loading">{GIT_COPY.conflictAiBusy}</p>;
  }

  if (ai.step === 'preview' || ai.step === 'editing') {
    return (
      <div className="gh-conflict-ai-preview">
        <h4>{GIT_COPY.conflictAiPreviewTitle}</h4>
        {ai.step === 'editing' ? (
          <textarea
            className="gh-conflict-ai-editor"
            value={ai.content}
            onChange={(e) => setAi({ step: 'editing', content: e.target.value })}
            aria-label="Edit the combined version"
          />
        ) : (
          <pre className="gh-conflict-content">{ai.content}</pre>
        )}
        <div className="gh-conflict-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void onResolve('custom', ai.content)}
          >
            {GIT_COPY.conflictAiUse}
          </button>
          {ai.step === 'preview' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setAi({ step: 'editing', content: ai.content })}
            >
              {GIT_COPY.conflictAiEdit}
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => setAi({ step: 'idle' })}>
            {GIT_COPY.conflictAiBack}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gh-conflict-file">
      {(versions.binary || versions.tooLarge) && (
        <p className="muted small">
          {versions.binary
            ? "This file isn't text, so it can't be combined — pick one version."
            : 'This file is too large to preview — pick one version.'}
        </p>
      )}
      <section className="gh-conflict-card">
        <header>
          <strong>{GIT_COPY.conflictMineTitle}</strong>
          {kind === 'deleted-by-us' && <span className="muted small">You deleted this file</span>}
        </header>
        {versions.ours !== undefined && !versions.binary && !versions.tooLarge && (
          <pre className="gh-conflict-content">{versions.ours}</pre>
        )}
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void onResolve('mine')}
        >
          {kind === 'deleted-by-us'
            ? 'Keep my version (stays deleted)'
            : GIT_COPY.conflictMineButton}
        </button>
      </section>
      <section className="gh-conflict-card">
        <header>
          <strong>{GIT_COPY.conflictTheirsTitle}</strong>
          {kind === 'deleted-by-them' && (
            <span className="muted small">GitHub deleted this file</span>
          )}
        </header>
        {versions.theirs !== undefined && !versions.binary && !versions.tooLarge && (
          <pre className="gh-conflict-content">{versions.theirs}</pre>
        )}
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void onResolve('theirs')}
        >
          {kind === 'deleted-by-them'
            ? "Keep GitHub's version (deletes it)"
            : GIT_COPY.conflictTheirsButton}
        </button>
      </section>
      {aiAvailable && (
        <div className="gh-conflict-ai-cta">
          <button type="button" className="gh-conflict-ai-button" disabled={busy} onClick={combine}>
            ✨ {GIT_COPY.conflictAiButton}
          </button>
        </div>
      )}
    </div>
  );
}
