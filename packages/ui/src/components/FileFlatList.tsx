import type { ReactNode } from 'react';
import { type FileEntry, defaultIconFor } from './FileTree.js';
import { parentDirOf } from './file-view-modes.js';

export interface FileFlatListProps {
  /** Files only (no directories), already sorted by the host. */
  entries: readonly FileEntry[];
  selectedPath?: string;
  onSelect: (entry: FileEntry) => void;
  iconFor?: (entry: FileEntry) => ReactNode;
  /** Read-only per-row status rendered after the label (time, badges, score). */
  trailingForEntry?: (entry: FileEntry) => ReactNode;
  emptyMessage?: ReactNode;
}

/**
 * Flat cross-folder file list — the "flat" counterpart of `FileTree`,
 * sharing its row classes so the two present identically. Each row shows
 * the file name with its parent folder muted alongside, so files pulled
 * out of their tree context stay locatable.
 */
export function FileFlatList({
  entries,
  selectedPath,
  onSelect,
  iconFor = defaultIconFor,
  trailingForEntry,
  emptyMessage,
}: FileFlatListProps) {
  if (entries.length === 0) {
    return emptyMessage ? <div className="file-flat-empty muted">{emptyMessage}</div> : null;
  }
  return (
    <div className="file-flat-list">
      {entries.map((entry) => {
        const parent = parentDirOf(entry.path);
        const trailing = trailingForEntry?.(entry);
        return (
          <div
            key={entry.path}
            className={`tree-row${selectedPath === entry.path ? ' tree-row-selected' : ''}`}
          >
            <span className="tree-toggle-spacer" />
            <button type="button" className="tree-label" onClick={() => onSelect(entry)}>
              {iconFor(entry)}
              {entry.name}
              {parent && <span className="file-flat-parent">{parent}</span>}
            </button>
            {trailing && <span className="tree-row-trailing">{trailing}</span>}
          </div>
        );
      })}
    </div>
  );
}
