import type { GitWorkingChange } from '@bendyline/gezel';
import { changeKindWord } from './gitCopy.js';

/**
 * Flat changed-files list for the Changes view — GitHub-Desktop-style
 * left rail. Each row: a colored status letter (with a plain-word
 * tooltip), filename with its folder dimmed, +/- counts, and a
 * hover-revealed "undo" affordance.
 */

const KIND_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
};

interface Props {
  changes: GitWorkingChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDiscard: (change: GitWorkingChange) => void;
  disabled?: boolean;
}

export function ChangedFileList({ changes, selectedPath, onSelect, onDiscard, disabled }: Props) {
  return (
    <ul className="gh-changes-list">
      {changes.map((change) => {
        const segments = change.path.split('/');
        const name = segments.pop() ?? change.path;
        const dir = segments.join('/');
        return (
          <li key={change.path} className={change.path === selectedPath ? 'is-selected' : ''}>
            <button
              type="button"
              className="gh-changes-row"
              onClick={() => onSelect(change.path)}
              disabled={disabled}
            >
              <span
                className={`gh-change-kind gh-change-kind-${change.kind}`}
                title={changeKindWord(change.kind)}
                aria-label={changeKindWord(change.kind)}
              >
                {KIND_LETTER[change.kind] ?? 'M'}
              </span>
              <span className="gh-change-name" title={change.path}>
                {name}
                {dir && <span className="gh-change-dir">{dir}</span>}
              </span>
              {change.binary ? (
                <span className="gh-change-counts muted small">binary</span>
              ) : (
                (change.additions !== undefined || change.deletions !== undefined) && (
                  <span className="gh-change-counts small">
                    {(change.additions ?? 0) > 0 && (
                      <span className="gh-change-add">+{change.additions}</span>
                    )}
                    {(change.deletions ?? 0) > 0 && (
                      <span className="gh-change-rem">−{change.deletions}</span>
                    )}
                  </span>
                )
              )}
            </button>
            <button
              type="button"
              className="gh-change-discard"
              title={`Undo changes to ${name}`}
              aria-label={`Undo changes to ${name}`}
              onClick={() => onDiscard(change)}
              disabled={disabled}
            >
              ↩
            </button>
          </li>
        );
      })}
    </ul>
  );
}
