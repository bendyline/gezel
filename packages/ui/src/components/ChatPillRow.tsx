import type { GezelSummary, Task, TerminalThreadSummary } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { DropdownMenu } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';
import { formatFolderLabel } from './terminal-folder-label.js';
import { type ThreadPill, useChatThreadPills } from './useChatThreadPills.js';
import { useProjectActiveTasks } from './useProjectActiveTasks.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

const RECENT_TERMINAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function timestampMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The status band across the top of a project chat: one pill per thread
 * that is streaming, failed, or recently active; one per active task; and
 * a "+" that starts a new task from a craftbook.
 *
 * Purely presentational apart from the two data hooks — it owns no dialog
 * and performs no navigation. The parent decides what focusing a thread or
 * a task means, which is what lets the same row serve a surface with no
 * task authority (omit `onNewTask` and the "+" disappears).
 */
export function ChatPillRow({
  projectId,
  gezelId,
  gezels,
  activeSessionId,
  activeTaskRef,
  activeTerminalThreadId,
  onFocusThread,
  onFocusTask,
  onFocusTerminal,
  onNewTask,
  refreshKey,
  terminalRefreshKey,
}: {
  projectId: string;
  /** Narrow the thread list to one gezel. Omit on the project chat. */
  gezelId?: string | undefined;
  /** Roster used for pill avatars and names. */
  gezels: GezelSummary[];
  /** The thread the composer posts into — always keeps its pill. */
  activeSessionId?: string | undefined;
  activeTaskRef?: string | null;
  activeTerminalThreadId?: string | null;
  onFocusThread: (pill: ThreadPill) => void;
  onFocusTask: (task: Task) => void;
  /** Omit on chat-only surfaces; supplying it adds recent terminal windows. */
  onFocusTerminal?: (thread: TerminalThreadSummary) => void;
  /** Omit to hide the "+" on surfaces that can't create project tasks. */
  onNewTask?: (() => void) | undefined;
  refreshKey?: number | undefined;
  terminalRefreshKey?: number | undefined;
}) {
  const { tasks } = useProjectActiveTasks({ projectId, refreshKey });
  // An idle thread for a task that already has its own pill is redundant.
  const taskRefs = useMemo(() => new Set(tasks.map((t) => t.ref)), [tasks]);
  const { pills, overflow } = useChatThreadPills({
    projectId,
    gezelId,
    pinnedSessionId: activeSessionId,
    suppressedTaskRefs: taskRefs,
    refreshKey,
  });
  const [terminalThreads, setTerminalThreads] = useState<TerminalThreadSummary[]>([]);
  const showTerminalThreads = onFocusTerminal !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: terminalRefreshKey is a post-submit bump that deliberately re-reads durable terminal summaries.
  useEffect(() => {
    if (!showTerminalThreads) {
      setTerminalThreads([]);
      return;
    }
    let cancelled = false;
    void api
      .listTerminalThreads(projectId)
      .then((res) => {
        if (cancelled) return;
        const cutoff = Date.now() - RECENT_TERMINAL_WINDOW_MS;
        setTerminalThreads(
          res.threads.filter(
            (thread) => !thread.archived && timestampMs(thread.lastActivityAt) >= cutoff,
          ),
        );
      })
      .catch(() => {
        // Preserve the last good set during a transient service failure.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, showTerminalThreads, terminalRefreshKey]);
  // ProjectChat stays mounted through some project transitions. Never show
  // a prior project's terminal windows during the next project's fetch.
  const visibleTerminalThreads = useMemo(
    () => terminalThreads.filter((thread) => thread.projectId === projectId),
    [terminalThreads, projectId],
  );

  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const nameFor = (id: string): string => {
    const g = gezels.find((x) => x.id === id);
    if (!g) return 'someone';
    return displayName({ name: g.name, roleBasedName: g.roleBasedName }, roleBasedNameOnlyMode);
  };
  const namesFor = (pill: ThreadPill): string =>
    [...new Set(pill.involvedGezelIds.map(nameFor))].join(', ');

  const liveCount = pills.filter((p) => p.state === 'inflight').length;
  const errorCount = pills.filter((p) => p.state === 'errored').length;
  // One live region for the whole row. Announcing per-pill would let five
  // concurrent turns machine-gun a screen reader.
  const announcement = [
    liveCount > 0 ? `${liveCount} ${liveCount === 1 ? 'thread' : 'threads'} working` : '',
    errorCount > 0 ? `${errorCount} needs attention` : '',
  ]
    .filter(Boolean)
    .join(', ');

  const empty = pills.length === 0 && visibleTerminalThreads.length === 0 && tasks.length === 0;

  return (
    <div className="chat-pill-row" role="toolbar" aria-label="Threads, terminal windows, and tasks">
      <output className="sr-only">{announcement}</output>
      <div className="chat-pill-row-scroll">
        {empty && <span className="chat-pill-row-empty muted small">No recent threads</span>}

        {pills.map((pill) => (
          <ThreadPillButton
            key={pill.sessionId}
            pill={pill}
            gezels={gezels}
            gezelNames={namesFor(pill)}
            active={pill.sessionId === activeSessionId}
            onFocus={onFocusThread}
          />
        ))}

        {overflow.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="chat-pill chat-pill-overflow">
              +{overflow.length} more
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="chat-rail-section-tab-menu chat-pill-overflow-menu"
                align="start"
                sideOffset={4}
              >
                {overflow.map((pill) => (
                  <DropdownMenu.Item
                    key={pill.sessionId}
                    onSelect={() => onFocusThread(pill)}
                    className={`chat-pill-overflow-item chat-pill-${pill.state}`}
                  >
                    <ThreadSummaryLines pill={pill} gezelNames={namesFor(pill)} />
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}

        {onFocusTerminal &&
          visibleTerminalThreads.map((thread) => (
            <TerminalPillButton
              key={thread.id}
              thread={thread}
              active={thread.id === activeTerminalThreadId}
              onFocus={onFocusTerminal}
            />
          ))}

        {tasks.map((task) => (
          <TaskPillButton
            key={task.ref}
            task={task}
            active={task.ref === activeTaskRef}
            onFocus={onFocusTask}
          />
        ))}
      </div>

      {onNewTask && (
        <button
          type="button"
          className="chat-pill-new-task"
          onClick={onNewTask}
          aria-label="New task"
          title="New task — pick a craftbook"
        >
          +
        </button>
      )}
    </div>
  );
}

function TerminalPillButton({
  thread,
  active,
  onFocus,
}: {
  thread: TerminalThreadSummary;
  active: boolean;
  onFocus: (thread: TerminalThreadSummary) => void;
}) {
  const folder = formatFolderLabel(thread.workingDir);
  const updated = formatLongRelativeTime(thread.lastActivityAt);
  return (
    <button
      type="button"
      className={`chat-pill chat-pill-thread chat-pill-terminal${active ? ' is-active' : ''}`}
      aria-pressed={active}
      aria-label={`Terminal ${folder}. Updated ${updated}`}
      title={`Terminal · ${folder} · updated ${updated}`}
      onClick={() => onFocus(thread)}
    >
      <span className="chat-pill-thread-line chat-pill-thread-title">Terminal</span>
      <span className="chat-pill-thread-line chat-pill-thread-context">
        <span className="terminal-prompt-sigil" aria-hidden="true">
          &gt;
        </span>
        <span className="chat-pill-message-preview">{folder}</span>
      </span>
      <span className="chat-pill-thread-line chat-pill-thread-update">Updated {updated}</span>
    </button>
  );
}

function ThreadPillButton({
  pill,
  gezels,
  gezelNames,
  active,
  onFocus,
}: {
  pill: ThreadPill;
  gezels: GezelSummary[];
  gezelNames: string;
  active: boolean;
  onFocus: (pill: ThreadPill) => void;
}) {
  const gezel = gezels.find((g) => g.id === pill.gezelId);
  // The dot carries state visually; the accessible name carries it in
  // words, so the decorative element never has to be read out.
  const updated = formatLongRelativeTime(pill.lastActivityAt);
  const status = threadStatusLabel(pill.state);
  const message = messagePreviewFor(pill);
  const title = `${gezelNames} · ${pill.title} · updated ${updated} · ${status}${
    pill.error ? `: ${pill.error}` : ''
  }`;

  return (
    <button
      type="button"
      className={`chat-pill chat-pill-thread chat-pill-${pill.state}${active ? ' is-active' : ''}`}
      aria-pressed={active}
      aria-label={`${gezelNames}: ${pill.title}. ${message}. Updated ${updated}. ${status}`}
      title={title}
      onClick={() => onFocus(pill)}
    >
      <ThreadSummaryLines pill={pill} gezelNames={gezelNames} gezel={gezel} />
    </button>
  );
}

function ThreadSummaryLines({
  pill,
  gezelNames,
  gezel,
}: {
  pill: ThreadPill;
  gezelNames: string;
  gezel?: GezelSummary | undefined;
}) {
  const message = messagePreviewFor(pill);
  return (
    <>
      <span className="chat-pill-thread-line chat-pill-thread-title">
        {truncatePreview(pill.title, 40)}
      </span>
      <span className="chat-pill-thread-line chat-pill-thread-context">
        {gezel && (
          <GezelIcon
            svg={gezel.icon ?? null}
            poppetje={gezel.poppetje}
            iconOverride={gezel.iconOverride}
            name={gezelNames}
            size={14}
          />
        )}
        <span className="chat-pill-participants">{gezelNames}</span>
        <span className="chat-pill-separator" aria-hidden="true">
          ·
        </span>
        <span className="chat-pill-message-preview">{message}</span>
      </span>
      <span className="chat-pill-thread-line chat-pill-thread-update">
        <span>Updated {formatLongRelativeTime(pill.lastActivityAt)}</span>
        <span className="chat-pill-separator" aria-hidden="true">
          ·
        </span>
        <span className="chat-pill-thread-status">
          <span className="chat-pill-dot" aria-hidden="true" />
          {threadStatusLabel(pill.state)}
        </span>
      </span>
    </>
  );
}

function messagePreviewFor(pill: ThreadPill): string {
  return pill.lastMessagePreview
    ? truncatePreview(plainMessagePreview(pill.lastMessagePreview), 30)
    : 'No messages yet';
}

function truncatePreview(value: string, maxCharacters: number): string {
  const characters = Array.from(value.trim());
  if (characters.length <= maxCharacters) return characters.join('');
  return `${characters.slice(0, maxCharacters - 1).join('')}…`;
}

function plainMessagePreview(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function threadStatusLabel(state: ThreadPill['state']): string {
  if (state === 'inflight') return 'Working';
  if (state === 'errored') return 'Needs attention';
  return 'Ready';
}

function formatLongRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.floor(Math.max(0, Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

function TaskPillButton({
  task,
  active,
  onFocus,
}: {
  task: Task;
  active: boolean;
  onFocus: (task: Task) => void;
}) {
  const unassigned = task.assignee.kind === 'user';
  return (
    <button
      type="button"
      className={`chat-pill chat-pill-task${active ? ' is-active' : ''}`}
      aria-pressed={active}
      aria-label={`Task ${task.ref}: ${task.title}`}
      title={
        unassigned ? `${task.ref} · ${task.title} — assigned to you` : `${task.ref} · ${task.title}`
      }
      onClick={() => onFocus(task)}
    >
      <span className="task-status-dot task-status-active" aria-hidden="true" />
      <span className="chat-pill-label">{task.title}</span>
    </button>
  );
}
