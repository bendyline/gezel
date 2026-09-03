import type { PromptDraftSummary } from '@bendyline/gezel';
import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { DropdownMenu } from '../primitives/index.js';
import { formatRelativeTime } from '../relative-time.js';

/**
 * The drafts belonging to the thread that is currently open, plus the two
 * actions that only make sense once you have more than one: start another,
 * and throw one away. Recently sent drafts sit under a separator with "Use
 * again", which is the point of keeping them at all.
 *
 * A menu rather than a tray: these are actions on one subject, not modes to
 * latch. Refusals are written into the item that cannot act, because a
 * disabled control with no explanation is just a dead end.
 */

export interface PromptDraftsMenuProps {
  projectId: string;
  gezelId: string;
  sessionId: string | undefined;
  activeDraftId: string | undefined;
  /** Open drafts on the active thread. */
  drafts: PromptDraftSummary[];
  onDraftSelect?: (draftId: string | undefined) => void;
  /** Ask the parent to re-read its lists after a create or delete. */
  onChanged?: () => void;
  taskRef?: string;
  craftbookRef?: string;
  draftScope?: string;
}

const RECENT_SENT_LIMIT = 5;

export function PromptDraftsMenu({
  projectId,
  gezelId,
  sessionId,
  activeDraftId,
  drafts,
  onDraftSelect,
  onChanged,
  taskRef,
  craftbookRef,
  draftScope,
}: PromptDraftsMenuProps) {
  const [sent, setSent] = useState<PromptDraftSummary[]>([]);
  const [busy, setBusy] = useState(false);

  // Sent drafts are only fetched when the menu opens: they are a recovery
  // affordance, not something worth a request on every thread switch.
  const loadSent = useCallback(async () => {
    if (!sessionId) return;
    try {
      const { drafts: found } = await api.listPromptDrafts(projectId, {
        gezelId,
        sessionId,
        status: 'sent',
      });
      setSent(found.slice(0, RECENT_SENT_LIMIT));
    } catch {
      setSent([]);
    }
  }, [projectId, gezelId, sessionId]);

  const createAnother = useCallback(async () => {
    setBusy(true);
    try {
      const created = await api.createPromptDraft(projectId, {
        gezelId,
        sessionId: sessionId ?? null,
        ...(taskRef ? { taskRef } : {}),
        ...(craftbookRef ? { craftbookRef } : {}),
        ...(draftScope ? { scope: draftScope } : {}),
      });
      onDraftSelect?.(created.id);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }, [projectId, gezelId, sessionId, taskRef, craftbookRef, draftScope, onDraftSelect, onChanged]);

  const deleteActive = useCallback(async () => {
    if (!activeDraftId) return;
    setBusy(true);
    try {
      await api.deletePromptDraft(projectId, activeDraftId);
      onDraftSelect?.(undefined);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }, [projectId, activeDraftId, onDraftSelect, onChanged]);

  const useAgain = useCallback(
    async (draftId: string) => {
      setBusy(true);
      try {
        const copy = await api.duplicatePromptDraft(projectId, draftId, {
          sessionId: sessionId ?? null,
        });
        onDraftSelect?.(copy.id);
        onChanged?.();
      } finally {
        setBusy(false);
      }
    },
    [projectId, sessionId, onDraftSelect, onChanged],
  );

  // With no thread and no draft there is nothing to list — the picker's
  // "+ Draft" is the way in from there.
  if (!sessionId && !activeDraftId) return null;

  const openCount = drafts.length;

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) void loadSent();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="gezel-chat-session-btn"
          disabled={busy}
          aria-label="Drafts for this thread"
          title="Messages you have started in this thread"
        >
          Drafts
          {openCount > 1 && (
            <span className="gezel-chat-session-btn-count">{` · ${openCount}`}</span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="app-nav-menu prompt-drafts-menu"
          align="end"
          sideOffset={4}
        >
          {drafts.map((d) => (
            <DropdownMenu.Item
              key={d.id}
              className={`app-nav-menu-item${d.id === activeDraftId ? ' active' : ''}`}
              onSelect={() => onDraftSelect?.(d.id)}
            >
              <span>{d.title || 'Untitled draft'}</span>
              <small>{formatRelativeTime(d.updatedAt)}</small>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item className="app-nav-menu-item" onSelect={() => void createAnother()}>
            <span>New draft</span>
            <small>Keep this one and start another message</small>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="app-nav-menu-item"
            disabled={!activeDraftId}
            onSelect={() => void deleteActive()}
          >
            <span>Delete draft</span>
            <small>
              {activeDraftId
                ? 'Throws away the message you are writing'
                : 'This composer has no draft yet'}
            </small>
          </DropdownMenu.Item>
          {sent.length > 0 && (
            <>
              <DropdownMenu.Separator className="gz-select-separator" />
              <DropdownMenu.Label className="gz-select-label">Recently sent</DropdownMenu.Label>
              {sent.map((d) => (
                <DropdownMenu.Item
                  key={d.id}
                  className="app-nav-menu-item"
                  onSelect={() => void useAgain(d.id)}
                >
                  <span>{d.title || 'Untitled draft'}</span>
                  <small>{`Use again · sent ${formatRelativeTime(d.sentAt ?? d.updatedAt)}`}</small>
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
