import type { RecentTab } from '@bendyline/gezel';
import { type KeyboardEvent, type MouseEvent, useState } from 'react';
import { DropdownChevron, DropdownMenu } from '../../primitives/index.js';
import { useViewHistory } from './ViewHistoryContext.js';
import { entryDetail, entryLabel, entryTitle } from './history-titles.js';
import { isMacPlatform } from './useHistoryShortcuts.js';

/**
 * Back, Forward and the trail of views visited, at the left of the titlebar
 * beside the brand. One tray of three keys (docs/ux.md, "Back and forward"):
 * the two arrows name where they lead, and the narrow key opens the trail,
 * newest first, with the current view marked. Right-clicking an arrow opens
 * the same trail, as a browser's does.
 */

function kindLabel(selection: RecentTab | null): string | undefined {
  switch (selection?.kind) {
    case 'project':
      return 'Project';
    case 'gezel':
      return 'Gezel';
    case 'task':
      return 'Task';
    case 'document':
      return 'Document';
    case 'script':
      return 'Script';
    case 'craftbook':
      return 'Craftbook';
    case 'craftbook-script':
      return 'Craftbook script';
    default:
      return undefined;
  }
}

/** Arrow keys move between the tray's keys, as in every other toolbar. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const keys = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  ];
  const at = keys.indexOf(document.activeElement as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  const next = keys[(at + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
  next?.focus();
}

export function HistoryKeys() {
  const history = useViewHistory();
  const [open, setOpen] = useState(false);
  if (!history) return null;
  const { entries, index } = history.history;
  const backEntry = entries[index - 1];
  const forwardEntry = entries[index + 1];
  const mac = isMacPlatform();
  const backShortcut = mac ? '⌘[' : 'Alt+Left';
  const forwardShortcut = mac ? '⌘]' : 'Alt+Right';
  const backLabel = backEntry ? `Back to ${entryLabel(backEntry)}` : 'Back';
  const forwardLabel = forwardEntry ? `Forward to ${entryLabel(forwardEntry)}` : 'Forward';
  const openTrail = (event: MouseEvent) => {
    event.preventDefault();
    if (entries.length > 1) setOpen(true);
  };
  const order = entries.map((_, i) => entries.length - 1 - i);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <div
        className="app-header-history"
        role="toolbar"
        aria-label="Back and forward"
        onKeyDown={moveFocus}
      >
        <button
          type="button"
          className="app-history-key"
          onClick={history.back}
          onContextMenu={openTrail}
          disabled={!history.canGoBack}
          aria-label={backLabel}
          title={`${backLabel} (${backShortcut})`}
          data-testid="history-back"
        >
          <HistoryArrow direction="back" />
        </button>
        <button
          type="button"
          className="app-history-key"
          onClick={history.forward}
          onContextMenu={openTrail}
          disabled={!history.canGoForward}
          aria-label={forwardLabel}
          title={`${forwardLabel} (${forwardShortcut})`}
          data-testid="history-forward"
        >
          <HistoryArrow direction="forward" />
        </button>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="app-history-key app-history-trail"
            disabled={entries.length < 2}
            aria-label="Views you have visited"
            title="Views you have visited"
            data-testid="history-trail"
          >
            <DropdownChevron />
          </button>
        </DropdownMenu.Trigger>
      </div>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="app-nav-menu view-history-menu"
          align="start"
          sideOffset={4}
          aria-label="Views you have visited"
        >
          {order.map((i) => {
            const entry = entries[i]!;
            const current = i === index;
            const hint = entryDetail(entry) || kindLabel(entry.selection);
            return (
              <DropdownMenu.Item
                key={entry.id}
                className={`app-nav-menu-item view-history-menu-item${current ? ' active' : ''}`}
                aria-current={current ? 'page' : undefined}
                onSelect={() => history.go(i)}
              >
                <span className="view-history-menu-mark" aria-hidden="true">
                  {current && <CurrentMark />}
                </span>
                <span className="view-history-menu-text">
                  <span className="view-history-menu-title">{entryTitle(entry)}</span>
                  {hint && <span className="view-history-menu-hint">{hint}</span>}
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The rail's caret, turned to point the way it leads. */
function HistoryArrow({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points={direction === 'back' ? '15 6 9 12 15 18' : '9 6 15 12 9 18'} />
    </svg>
  );
}

function CurrentMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}
