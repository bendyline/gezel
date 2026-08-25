import type { Diffpack, DiffpackFile } from '@bendyline/gezel';
import { formatDiffpackRef } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { formatAbsoluteTime } from '../../relative-time.js';
import { MarkdownField } from '../MarkdownField.js';
import { GitDiffView } from '../github/GitDiffView.js';
import { plural } from '../github/gitCopy.js';
import { DiffpackConfirmApply } from './DiffpackConfirmApply.js';
import { useDiffpacks } from './useDiffpacks.js';

/**
 * The Proposals tab: change sets a gezel drafted but did not apply.
 *
 * A proposal is a decision, not a document, so the pane is built around
 * deciding: the notes explain the reasoning, each file shows its diff, and
 * the tray under the content applies, exports, or dismisses. Nothing reaches
 * the project until a click here — which is what lets this work on a folder
 * gezels hold no write grant for.
 */

const noop = () => {};

function statusLabel(pack: Diffpack): string {
  switch (pack.status) {
    case 'drafting':
      return 'Being written';
    case 'ready':
      return 'Ready to review';
    case 'applied':
      return 'Applied';
    case 'partially-applied':
      return 'Partly applied';
    case 'dismissed':
      return 'Dismissed';
    case 'failed':
      return 'Didn’t work out';
  }
}

function changeLabel(file: DiffpackFile): string {
  if (file.change === 'add') return 'New file';
  if (file.change === 'delete') return 'Delete';
  return 'Edit';
}

export function DiffpackReviewView({ projectId }: { projectId: string }) {
  const { diffpacks, loaded, busy, apply, dismiss } = useDiffpacks(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ packId: string; text: string } | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ paths: string[]; subset?: string[] } | null>(null);

  const selected = useMemo(
    () => diffpacks.find((p) => p.packId === selectedId) ?? diffpacks[0] ?? null,
    [diffpacks, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setNotes(null);
    setDiffs({});
    void api
      .getDiffpack(projectId, selected.packId)
      .then((res) => {
        if (!cancelled) setNotes({ packId: selected.packId, text: res.notes });
      })
      .catch(() => {
        if (!cancelled) setNotes({ packId: selected.packId, text: '' });
      });
    for (const file of selected.files) {
      if (!file.diffArtifact) continue;
      void api
        .readProjectArtifact(projectId, file.diffArtifact)
        .then((res) => {
          if (!cancelled) setDiffs((prior) => ({ ...prior, [file.path]: res.content }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, selected]);

  const runApply = async (opts: { paths?: string[]; allowDrifted?: boolean } = {}) => {
    if (!selected) return;
    const outcome = await apply(selected.packId, opts);
    if (!outcome.ok && outcome.drifted.length > 0 && !opts.allowDrifted) {
      setConfirm({ paths: outcome.drifted, ...(opts.paths ? { subset: opts.paths } : {}) });
      return;
    }
    setToast(outcome.message);
  };

  const exportPack = async () => {
    if (!selected) return;
    try {
      const blob = await api.exportDiffpack(projectId, selected.packId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${formatDiffpackRef(selected.packId)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    }
  };

  if (loaded && diffpacks.length === 0) {
    return (
      <div className="dp-empty">
        <p className="placeholder">
          No change proposals yet. When a gezel fixes something here, the change lands as a proposal
          you read and apply — your files aren’t touched until you say so.
        </p>
      </div>
    );
  }

  return (
    <div className="dp-layout">
      <div className="dp-list">
        {diffpacks.map((pack) => (
          <button
            key={pack.packId}
            type="button"
            className={`dp-list-item${pack.packId === selected?.packId ? ' dp-list-item-active' : ''}`}
            onClick={() => setSelectedId(pack.packId)}
          >
            <span className="dp-list-head">
              <code className="dp-ref">{formatDiffpackRef(pack.packId)}</code>
              <span className={`dp-status dp-status-${pack.status}`}>{statusLabel(pack)}</span>
            </span>
            <span className="dp-list-title">{pack.title}</span>
            <span className="muted small">
              {plural(pack.files.length, 'file')} · +{pack.additions} −{pack.deletions}
              {pack.origin.kind === 'boekwachter-issue'
                ? ` · ${pack.origin.issueRefs.join(', ')}`
                : ''}
            </span>
            {(pack.drifted.length > 0 || pack.overlaps.length > 0) && (
              <span className="dp-list-flags">
                {pack.drifted.length > 0 && (
                  <span className="dp-flag dp-flag-drift">Out of date</span>
                )}
                {pack.overlaps.length > 0 && (
                  <span className="dp-flag">
                    Overlaps{' '}
                    {[...new Set(pack.overlaps.flatMap((o) => o.packIds))]
                      .map(formatDiffpackRef)
                      .join(', ')}
                  </span>
                )}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="dp-detail">
        {!selected ? (
          <p className="placeholder">Pick a proposal to read it.</p>
        ) : (
          <>
            <div className="dp-detail-head">
              <h3>{selected.title}</h3>
              <p className="muted small">
                {selected.gezelName ? `Drafted by ${selected.gezelName}` : 'Drafted'}
                {selected.sealedAt ? ` · ${formatAbsoluteTime(selected.sealedAt)}` : ''}
              </p>
            </div>

            {selected.drifted.length > 0 && (
              <output className="dp-notice">
                {selected.drifted.join(', ')} changed since this was written, so the proposal may no
                longer fit. Read the diff before applying.
              </output>
            )}
            {selected.overlaps.length > 0 && (
              <output className="dp-notice">
                Another proposal touches{' '}
                {[...new Set(selected.overlaps.map((o) => o.path))].join(', ')}. Applying one will
                put the other out of date.
              </output>
            )}

            {notes?.packId === selected.packId && notes.text ? (
              <MarkdownField key={selected.packId} value={notes.text} readOnly onCommit={noop} />
            ) : selected.status === 'drafting' ? (
              <p className="muted">Still being written…</p>
            ) : null}

            <div className="dp-files">
              {selected.files.map((file) => (
                <section key={file.path} className="dp-file">
                  <header className="dp-file-head">
                    <code className="dp-file-path" title={file.path}>
                      {file.path}
                    </code>
                    <span className="muted small">
                      {changeLabel(file)} · +{file.additions} −{file.deletions}
                    </span>
                    {selected.status === 'ready' && file.change !== 'delete' && (
                      <button
                        type="button"
                        className="small"
                        disabled={busy === selected.packId}
                        onClick={() => void runApply({ paths: [file.path] })}
                      >
                        Apply this file
                      </button>
                    )}
                  </header>
                  {file.change === 'delete' ? (
                    <p className="git-diff-placeholder muted">
                      This proposal suggests deleting the file.
                    </p>
                  ) : (
                    <GitDiffView diff={diffs[file.path]} />
                  )}
                </section>
              ))}
            </div>

            {toast && <output className="dp-toast">{toast}</output>}

            <div
              className="gz-tray dp-actions"
              role="toolbar"
              aria-label={`Actions for ${formatDiffpackRef(selected.packId)}`}
            >
              <button
                type="button"
                className="gz-key dp-key-apply"
                disabled={selected.status !== 'ready' || busy === selected.packId}
                onClick={() => void runApply()}
              >
                {busy === selected.packId ? 'Applying…' : 'Apply all'}
              </button>
              <button type="button" className="gz-key" onClick={() => void exportPack()}>
                Export
              </button>
              <button
                type="button"
                className="gz-key"
                disabled={busy === selected.packId}
                onClick={() => {
                  void dismiss(selected.packId).then((err) => err && setToast(err));
                }}
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>

      {confirm && selected && (
        <DiffpackConfirmApply
          paths={confirm.paths}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const subset = confirm.subset;
            setConfirm(null);
            void runApply({ allowDrifted: true, ...(subset ? { paths: subset } : {}) });
          }}
        />
      )}
    </div>
  );
}
