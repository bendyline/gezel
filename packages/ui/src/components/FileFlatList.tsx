import type { ReactNode } from 'react';
import { ContextMenu, DropdownMenu } from '../primitives/index.js';
import { type FileEntry, type FileTreeAction, defaultIconFor } from './FileTree.js';
import { parentDirOf } from './file-view-modes.js';

export interface FileFlatListProps {
  /** Files only (no directories), already sorted by the host. */
  entries: readonly FileEntry[];
  selectedPath?: string;
  onSelect: (entry: FileEntry) => void;
  iconFor?: (entry: FileEntry) => ReactNode;
  /** Read-only per-row status rendered after the label (time, badges, score). */
  trailingForEntry?: (entry: FileEntry) => ReactNode;
  /**
   * Per-row prose rendered *under* the name, turning the row into a card.
   * Distinct from `trailingForEntry`, which shares the name's line and so
   * cannot hold anything long: the trailing slot never shrinks, so a sentence
   * put there squeezes the name out of the row entirely.
   */
  detailForEntry?: (entry: FileEntry) => ReactNode;
  /** Optional host-defined actions exposed through both row menus. */
  actionsForEntry?: (entry: FileEntry) => readonly FileTreeAction[];
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
  detailForEntry,
  actionsForEntry,
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
        const detail = detailForEntry?.(entry);
        const actions = actionsForEntry?.(entry) ?? [];
        const row = (
          <div
            key={entry.path}
            className={`tree-row${selectedPath === entry.path ? ' tree-row-selected' : ''}${
              detail ? ' file-flat-row-card' : ''
            }`}
          >
            <span className="tree-toggle-spacer" />
            <button
              type="button"
              className={`tree-label${detail ? ' file-flat-card' : ''}`}
              onClick={() => onSelect(entry)}
            >
              <span className="file-flat-card-name">
                {iconFor(entry)}
                {entry.name}
                {parent && <span className="file-flat-parent">{parent}</span>}
              </span>
              {detail && <span className="file-flat-card-detail">{detail}</span>}
            </button>
            {trailing && (
              // The badges sit outside the label button, so a click on the
              // issue count landed on dead space — the one part of the row a
              // triage reader aims at. Redundant with the label, so it stays
              // out of the tab order.
              <button
                type="button"
                className="tree-row-trailing tree-row-trailing-select"
                tabIndex={-1}
                onClick={() => onSelect(entry)}
              >
                {trailing}
              </button>
            )}
            {actions.length > 0 && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="tree-actions-trigger"
                    aria-label={`Actions for ${entry.name}`}
                    title={`Actions for ${entry.name}`}
                  >
                    <span aria-hidden="true">⋯</span>
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="app-nav-menu tree-actions-menu"
                    sideOffset={4}
                    align="end"
                  >
                    {actions.map((action) => (
                      <DropdownMenu.Item
                        key={action.label}
                        className="app-nav-menu-item"
                        disabled={action.disabled}
                        onSelect={() => void action.onSelect(entry)}
                      >
                        {action.label}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </div>
        );
        return actions.length > 0 ? (
          <ContextMenu.Root key={entry.path}>
            <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="app-nav-menu tree-actions-menu">
                {actions.map((action) => (
                  <ContextMenu.Item
                    key={action.label}
                    className="app-nav-menu-item"
                    disabled={action.disabled}
                    onSelect={() => void action.onSelect(entry)}
                  >
                    {action.label}
                  </ContextMenu.Item>
                ))}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        ) : (
          row
        );
      })}
    </div>
  );
}
