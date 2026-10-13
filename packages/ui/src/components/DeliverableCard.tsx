import {
  type ReferencedFile,
  type TaskDeliverable,
  deliverableFormatLabel,
  deliverableFormatNoun,
} from '@bendyline/gezel';
import { useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { DeliverableCover, hasTextCover } from './DeliverableCover.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { GezelIcon } from './GezelIcon.js';
import { formatFileSize } from './file-view-modes.js';

/**
 * The one file a task hands its owner, set as a card rather than as one
 * path among many. A PowerPoint run used to end on a bubble whose deck was
 * the fifth backticked path in a list of working files, unlinked because
 * the workspace index had not caught up; the person had to read a task note
 * to find what they asked for.
 *
 * `final` is the finished work (a wrap-up, a completed task); `draft` is the
 * latest copy of a task still running, so the tracker can point at the
 * product before the last step signs it off.
 */
export interface DeliverableCardProps {
  deliverable: TaskDeliverable;
  projectId: string;
  state?: 'final' | 'draft';
  /** One line instead of the full card — for step receipts inside a turn. */
  compact?: boolean;
  /** Open the file in the app. Absent → the card offers no Open key. */
  onOpen?: (file: ReferencedFile) => void;
  /**
   * The finished-work card closing a task's wrap-up: the gezel who made it,
   * credited by face, a cover of the document's first page, and a way to ask
   * for changes. The end of a first request used to be a file tile.
   */
  maker?: {
    name: string;
    icon?: string | null;
    poppetje?: import('@bendyline/gezel').Poppetje | null;
    iconOverride?: boolean;
  };
  /** Talk to the maker about changes. */
  onMakeChanges?: () => void;
  /** The project's name, for a deliverable that is its Output page. */
  projectName?: string;
}

/** The desktop shell's reveal / save-a-copy bridges share this shape. */
type BridgeAction = (request: {
  projectId: string;
  kind: 'artifact' | 'document' | 'workspace';
  path: string;
}) => Promise<{ ok: true } | { ok: false; error: string }>;

export function DeliverableCard({
  deliverable,
  projectId,
  state = 'final',
  compact = false,
  onOpen,
  maker,
  onMakeChanges,
  projectName,
}: DeliverableCardProps) {
  const board = deliverable.view === 'output-page';
  const [error, setError] = useState<string | null>(null);
  const name = deliverable.path.slice(deliverable.path.lastIndexOf('/') + 1) || deliverable.path;
  const folder = deliverable.path.includes('/')
    ? deliverable.path.slice(0, deliverable.path.lastIndexOf('/'))
    : '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '';
  const eyebrow = board
    ? state === 'final'
      ? 'Ready to look at'
      : 'Board · in progress'
    : state === 'final'
      ? `Your ${deliverableFormatNoun(deliverable.path)}`
      : `${deliverableFormatLabel(deliverable.path)} · in progress`;
  const where = board
    ? "The project's Output page"
    : deliverable.kind === 'workspace'
      ? 'In the project folder'
      : 'In the artifacts drawer';
  const shownName = board ? (projectName ?? 'The project board') : name;
  const covered = !board && state === 'final' && Boolean(maker) && hasTextCover(deliverable.path);
  const bridge = typeof window === 'undefined' ? undefined : window.__GEZEL__;
  const file: ReferencedFile = { kind: deliverable.kind, path: deliverable.path };
  const open = onOpen ? () => onOpen(file) : undefined;

  const runBridge = async (action: BridgeAction | undefined) => {
    if (!action) return;
    setError(null);
    try {
      const result = await action({ projectId, kind: deliverable.kind, path: deliverable.path });
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        className="deliverable-card-compact"
        onClick={open}
        disabled={!open}
        title={`Open ${deliverable.path}`}
      >
        <FileTypeIcon name={name} className="deliverable-card-compact-icon" />
        <span className="deliverable-card-compact-eyebrow">{eyebrow}</span>
        <span className="deliverable-card-compact-name">{name}</span>
      </button>
    );
  }

  return (
    <section
      className={`deliverable-card deliverable-card--${state}${maker ? ' deliverable-card--completion' : ''}`}
      aria-label={eyebrow}
      data-testid="deliverable-card"
    >
      {maker && (
        <p className="deliverable-card-maker">
          <GezelIcon
            svg={maker.icon ?? null}
            poppetje={maker.poppetje ?? null}
            iconOverride={maker.iconOverride === true}
            name={maker.name}
            size={24}
          />
          <span>
            <strong>{maker.name}</strong> made this for you
          </span>
        </p>
      )}
      {covered && (
        // A larger target for the pointer only: the face below opens the same
        // file with a proper name. Focusable, this was a second, unnamed tab
        // stop, and an invisible one while the cover was loading or empty.
        <button
          type="button"
          className="deliverable-card-cover-button"
          onClick={open}
          disabled={!open}
          tabIndex={-1}
          aria-hidden="true"
          title={open ? `Open ${deliverable.path}` : deliverable.path}
        >
          <DeliverableCover deliverable={deliverable} projectId={projectId} />
        </button>
      )}
      <button
        type="button"
        className="deliverable-card-face"
        onClick={open}
        disabled={!open}
        title={open ? `Open ${board ? shownName : deliverable.path}` : deliverable.path}
      >
        <span className="deliverable-card-tile" aria-hidden="true">
          <FileTypeIcon name={board ? 'board.html' : name} className="deliverable-card-tile-icon" />
          {!board && ext && ext.length <= 5 && (
            <span className="deliverable-card-tile-ext">{ext}</span>
          )}
        </span>
        <span className="deliverable-card-text">
          <span className="deliverable-card-eyebrow">{eyebrow}</span>
          <span className="deliverable-card-name">{shownName}</span>
          <span className="deliverable-card-meta">
            {where}
            {!board && folder && (
              <>
                {' · '}
                <span className="deliverable-card-folder">{folder}</span>
              </>
            )}
            {!board && deliverable.bytes !== undefined && ` · ${formatFileSize(deliverable.bytes)}`}
            {deliverable.modifiedAt && (
              <>
                {' · '}
                <time
                  dateTime={deliverable.modifiedAt}
                  title={formatAbsoluteTime(deliverable.modifiedAt)}
                >
                  {formatRelativeTime(deliverable.modifiedAt)}
                </time>
              </>
            )}
          </span>
        </span>
      </button>
      {(open || onMakeChanges || bridge?.showReferenceInFolder || bridge?.saveReferenceCopy) && (
        <div className="deliverable-card-actions" role="toolbar" aria-label={`Actions for ${name}`}>
          {open && (
            <button type="button" className="deliverable-card-open" onClick={open}>
              Open
            </button>
          )}
          {onMakeChanges && (
            <button
              type="button"
              className="secondary deliverable-card-action"
              onClick={onMakeChanges}
            >
              <span className="deliverable-card-action-label">Make changes</span>
            </button>
          )}
          {!board && bridge?.showReferenceInFolder && (
            <button
              type="button"
              className="secondary deliverable-card-action"
              title="Show in folder"
              aria-label="Show in folder"
              onClick={() => void runBridge(bridge.showReferenceInFolder)}
            >
              <span
                className="fa-solid fa-folder-open deliverable-card-action-icon"
                aria-hidden="true"
              />
              <span className="deliverable-card-action-label">Show in folder</span>
            </button>
          )}
          {!board && bridge?.saveReferenceCopy && (
            <button
              type="button"
              className="secondary deliverable-card-action"
              title="Save a copy…"
              aria-label="Save a copy…"
              onClick={() => void runBridge(bridge.saveReferenceCopy)}
            >
              <span
                className="fa-solid fa-download deliverable-card-action-icon"
                aria-hidden="true"
              />
              <span className="deliverable-card-action-label">Save a copy…</span>
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error small deliverable-card-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
