import type { ReactNode } from 'react';
import '../styles/empty-place.css';

/**
 * What an empty place says: what it is for, in one sentence, and the one
 * thing to do about it, worded as what the person gets ("Give the crew a
 * task", not "New task"). A new owner met "Pick a project on the left to
 * view it here" over a blank page and "No one-time tasks have been created
 * yet" in the middle of another, and neither said what the place was for or
 * how to start. No illustration: docs/ux.md holds those for the branding pass.
 */
export function EmptyPlace({
  purpose,
  action,
  note,
  className,
}: {
  purpose: string;
  action?: { label: string; onClick: () => void; disabled?: boolean } | undefined;
  /** A quieter line under the key, such as the other way in. */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-place${className ? ` ${className}` : ''}`}>
      <p className="empty-place-purpose">{purpose}</p>
      {action && (
        <button
          type="button"
          className="empty-place-action"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </button>
      )}
      {note && <p className="empty-place-note">{note}</p>}
    </div>
  );
}
