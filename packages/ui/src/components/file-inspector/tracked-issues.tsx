import {
  type BoekwachterIssue,
  type BoekwachterIssueDismissalReason,
  type BoekwachterIssueStatus,
  ISSUE_VERDICT_LABELS,
  type IssueVerdictKind,
  type IssueVerdictReason,
  issueVerdictActorLabel,
} from '@bendyline/gezel';
import { useCallback, useId, useState } from 'react';
import { api } from '../../api.js';
import { onRadioKeyDown } from '../../primitives/radio-keyboard.js';

export interface BoekwachterIssuePatch {
  status?: BoekwachterIssueStatus;
  seen?: boolean;
  dismissalReason?: BoekwachterIssueDismissalReason;
  /** A verdict with its reason and note; sent as a verdict, not a status change. */
  verdict?: { kind: IssueVerdictKind; reason?: IssueVerdictReason; note?: string };
}

/**
 * Send a row's change to the daemon: a verdict through the verdict route (so
 * the note and the kind are kept), anything else as a plain update. Throws
 * the daemon's own words when a verdict is refused.
 */
export async function sendIssuePatch(
  projectId: string,
  issue: BoekwachterIssue,
  patch: BoekwachterIssuePatch,
): Promise<void> {
  const { verdict, ...rest } = patch;
  if (verdict) {
    const res = await api.issueTriage.applyVerdicts(projectId, {
      verdicts: [{ ref: issue.ref, ...verdict }],
    });
    const refused = res.results.find((r) => r.outcome === 'refused');
    if (refused) throw new Error(refused.message);
    if (rest.seen !== undefined) {
      await api.updateBoekwachterIssue(projectId, { ref: issue.ref, seen: rest.seen });
    }
    return;
  }
  await api.updateBoekwachterIssue(projectId, { ref: issue.ref, ...rest });
}

export type UpdateBoekwachterIssue = (
  issue: BoekwachterIssue,
  patch: BoekwachterIssuePatch,
) => void | Promise<void>;

/**
 * Fired on `window` after a Boekwachter issue changes from any surface (an
 * issue row, the Fix dialog), so every open pane showing that file's review
 * refetches instead of showing the old status.
 */
export const BOEKWACHTER_ISSUES_CHANGED_EVENT = 'gezel:boekwachter-issues-changed';

export function announceBoekwachterIssuesChanged(projectId: string): void {
  window.dispatchEvent(
    new CustomEvent(BOEKWACHTER_ISSUES_CHANGED_EVENT, { detail: { projectId } }),
  );
}

/** One action at a time across a review's issue rows, with its error kept for display. */
export function useIssueActions(onUpdateIssue?: UpdateBoekwachterIssue) {
  const [issueAction, setIssueAction] = useState<string | null>(null);
  const [issueActionError, setIssueActionError] = useState<string | null>(null);
  const runIssueAction = useCallback(
    async (issue: BoekwachterIssue, action: string, patch: BoekwachterIssuePatch) => {
      if (!onUpdateIssue || issueAction) return;
      setIssueAction(`${issue.ref}:${action}`);
      setIssueActionError(null);
      try {
        await onUpdateIssue(issue, patch);
      } catch (reason) {
        setIssueActionError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setIssueAction(null);
      }
    },
    [issueAction, onUpdateIssue],
  );
  return { issueAction, issueActionError, runIssueAction };
}

/**
 * A durable Boekwachter issue row (`BW-12`): what it says, where it was, and
 * its lifecycle keys — read/unread, not an issue, resolve, reopen, Fix. A row
 * whose file changed since the review reads "Previously line N" and "Needs
 * recheck" rather than pretending the location is still exact.
 */
export function TrackedIssueItem({
  issue,
  fileName,
  busy,
  onSelectLine,
  onUpdateIssue,
  onFixIssue,
  onOpenTask,
  runIssueAction,
}: {
  issue: BoekwachterIssue;
  fileName: string | null;
  busy: boolean;
  onSelectLine?: (line: number) => void;
  onUpdateIssue?: UpdateBoekwachterIssue;
  onFixIssue?: (issue: BoekwachterIssue) => void;
  onOpenTask?: (taskRef: string) => void;
  runIssueAction: (
    issue: BoekwachterIssue,
    action: string,
    patch: BoekwachterIssuePatch,
  ) => Promise<void>;
}) {
  const [judging, setJudging] = useState(false);
  const line = issue.line;
  const location = line == null ? null : issue.stale ? `Previously line ${line}` : `Line ${line}`;
  const verdict = issue.latestVerdict;
  const content = (
    <>
      <div className="workspace-index-issue-meta">
        {!issue.seen && (
          <span className="workspace-index-issue-unread" title="Unread issue">
            New
          </span>
        )}
        <span className="workspace-index-issue-ref">{issue.ref}</span>
        <span>{issue.severity}</span>
        <span>{issue.category}</span>
        {location && <span>{location}</span>}
        {issue.stale && <span>Needs recheck</span>}
        {issue.status !== 'open' && (
          <span>{issueStatusLabel(issue.status, issue.dismissalReason)}</span>
        )}
      </div>
      <p>{issue.message}</p>
      {verdict && (
        <p className="workspace-index-issue-verdict">
          <span className="workspace-index-issue-verdict-label">
            {ISSUE_VERDICT_LABELS[verdict.kind]}
            {verdict.unverified ? ' (unconfirmed)' : ''} · {issueVerdictActorLabel(verdict.by)}
          </span>
          {verdict.note && <span> — {verdict.note}</span>}
        </p>
      )}
    </>
  );
  return (
    <li data-status={issue.status}>
      {line != null && onSelectLine ? (
        <button
          type="button"
          className="workspace-index-issue-content workspace-index-issue-selectable"
          onClick={() => {
            onSelectLine(line);
            if (!issue.seen) void runIssueAction(issue, 'read', { seen: true });
          }}
          title={`${issue.stale ? 'Reveal the previous line' : 'Select line'} ${line} in ${fileName ?? 'the source file'}`}
        >
          {content}
        </button>
      ) : (
        <div className="workspace-index-issue-content">{content}</div>
      )}
      <div className="workspace-index-issue-actions">
        {issue.taskRef && issue.status === 'in_progress' && (
          <button
            type="button"
            className="link-button workspace-index-issue-task"
            onClick={() => onOpenTask?.(issue.taskRef!)}
          >
            Working · {issue.taskRef}
          </button>
        )}
        {/* The toolbar carries the issue's ref so a screen reader can
            tell one row's icon keys from the next one's, which lets
            the keys themselves keep short action labels. */}
        <div
          className="gz-tray workspace-index-issue-tray"
          role="toolbar"
          aria-label={`Actions for ${issue.ref}`}
        >
          {onUpdateIssue && (
            <IssueActionKey
              icon={issue.seen ? 'fa-envelope' : 'fa-envelope-open'}
              label={issue.seen ? 'Mark unread' : 'Mark read'}
              disabled={busy}
              onClick={() =>
                void runIssueAction(issue, issue.seen ? 'unread' : 'read', {
                  seen: !issue.seen,
                })
              }
            />
          )}
          {onUpdateIssue && issue.status === 'open' && (
            <>
              <IssueActionKey
                icon="fa-scale-balanced"
                label="Give a verdict"
                title="Not a bug, not worth fixing, or confirmed real"
                disabled={busy}
                pressed={judging}
                onClick={() => setJudging((open) => !open)}
              />
              <IssueActionKey
                icon="fa-check"
                label="Mark resolved"
                disabled={busy}
                onClick={() =>
                  void runIssueAction(issue, 'resolve', {
                    status: 'resolved',
                    seen: true,
                  })
                }
              />
            </>
          )}
          {onUpdateIssue && (issue.status === 'resolved' || issue.status === 'dismissed') && (
            <IssueActionKey
              icon="fa-rotate-left"
              label="Reopen"
              disabled={busy}
              onClick={() =>
                void runIssueAction(issue, 'reopen', {
                  status: 'open',
                  seen: true,
                })
              }
            />
          )}
          {onFixIssue && issue.status === 'open' && (
            <IssueActionKey
              icon="fa-wrench"
              label="Fix"
              title={`Create a tracked task for ${issue.ref}`}
              className="workspace-index-issue-fix"
              onClick={() => onFixIssue(issue)}
            />
          )}
        </div>
      </div>
      {judging && issue.status === 'open' && (
        <IssueVerdictForm
          issue={issue}
          busy={busy}
          onCancel={() => setJudging(false)}
          onSave={async (verdict) => {
            await runIssueAction(issue, 'verdict', { verdict, seen: true });
            setJudging(false);
          }}
        />
      )}
    </li>
  );
}

const FORM_VERDICTS: readonly { kind: IssueVerdictKind; label: string }[] = [
  { kind: 'not_a_bug', label: 'Not a bug' },
  { kind: 'nit', label: 'Not worth fixing' },
  { kind: 'confirmed', label: 'Confirmed real' },
  { kind: 'fixed', label: 'Fixed' },
];

const FORM_REASONS: readonly { reason: IssueVerdictReason; label: string }[] = [
  { reason: 'incorrect', label: 'Wrong about the code' },
  { reason: 'handled_elsewhere', label: 'Handled elsewhere' },
  { reason: 'intended', label: 'On purpose' },
];

/** A small radio tray of keys (docs/ux.md → "Controls: keys in trays"). */
function KeyRadios<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="gz-tray" role="radiogroup" aria-label={label} onKeyDown={onRadioKeyDown}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className={`gz-key${value === option.value ? ' gz-key-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What the person concluded about one issue, with an optional note. Telling
 * "not a bug" from "not worth fixing" matters: only the first counts against
 * the reviewer that raised it (docs/issue-triage.md).
 */
function IssueVerdictForm({
  issue,
  busy,
  onSave,
  onCancel,
}: {
  issue: BoekwachterIssue;
  busy: boolean;
  onSave: (verdict: NonNullable<BoekwachterIssuePatch['verdict']>) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<IssueVerdictKind>('not_a_bug');
  const [reason, setReason] = useState<IssueVerdictReason>('incorrect');
  const [note, setNote] = useState('');
  const noteId = useId();
  return (
    <form
      className="workspace-index-issue-verdict-form"
      aria-label={`Verdict for ${issue.ref}`}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          kind,
          ...(kind === 'not_a_bug' ? { reason } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }}
    >
      <KeyRadios
        label="Verdict"
        options={FORM_VERDICTS.map((o) => ({ value: o.kind, label: o.label }))}
        value={kind}
        onChange={setKind}
      />
      {kind === 'not_a_bug' && (
        <KeyRadios
          label="Why it is not a bug"
          options={FORM_REASONS.map((o) => ({ value: o.reason, label: o.label }))}
          value={reason}
          onChange={setReason}
        />
      )}
      <label htmlFor={noteId} className="workspace-index-issue-verdict-note-label">
        Note (optional)
      </label>
      <textarea
        id={noteId}
        rows={2}
        maxLength={2000}
        value={note}
        placeholder="What you checked"
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="workspace-index-issue-verdict-actions">
        <button type="submit" className="primary" disabled={busy}>
          Save verdict
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One key in an issue row's action toolbar. Icon-only, so the label is the
 * accessible name and — unless the action needs a longer explanation — the
 * tooltip too (docs/ux.md → "Controls: keys in trays").
 */
function IssueActionKey({
  icon,
  label,
  title,
  className,
  disabled,
  pressed,
  onClick,
}: {
  icon: string;
  label: string;
  title?: string;
  className?: string;
  disabled?: boolean;
  /** For a key that opens something in place: whether it is open. */
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`gz-key gz-key--icon workspace-index-issue-key${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative icon, not focusable */}
      <i className={`fa-solid ${icon}`} aria-hidden="true" />
    </button>
  );
}

export function issueStatusLabel(
  status: BoekwachterIssueStatus,
  dismissalReason?: BoekwachterIssueDismissalReason,
): string {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    case 'resolved':
      return 'Resolved';
    case 'dismissed':
      return dismissalReason === 'wont_fix'
        ? "Won't fix"
        : dismissalReason === 'duplicate'
          ? 'Duplicate'
          : 'Not an issue';
    default:
      return 'Open';
  }
}

/** Whether a tracked issue still asks for attention (shown unless "Show closed"). */
export function isOpenIssue(issue: BoekwachterIssue): boolean {
  return issue.status === 'open' || issue.status === 'in_progress';
}
