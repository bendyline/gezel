import type { GezelSummary, Task } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useMemo } from 'react';
import { DropdownMenu } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';
import { formatRelativeTime } from './session-labels.js';
import { type ThreadPill, useChatThreadPills } from './useChatThreadPills.js';
import { useProjectActiveTasks } from './useProjectActiveTasks.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

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
  onFocusThread,
  onFocusTask,
  onNewTask,
  refreshKey,
}: {
  projectId: string;
  /** Narrow the thread list to one gezel. Omit on the project chat. */
  gezelId?: string | undefined;
  /** Roster used for pill avatars and names. */
  gezels: GezelSummary[];
  /** The thread the composer posts into — always keeps its pill. */
  activeSessionId?: string | undefined;
  activeTaskRef?: string | null;
  onFocusThread: (pill: ThreadPill) => void;
  onFocusTask: (task: Task) => void;
  /** Omit to hide the "+" on surfaces that can't create project tasks. */
  onNewTask?: (() => void) | undefined;
  refreshKey?: number | undefined;
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

  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const nameFor = (id: string): string => {
    const g = gezels.find((x) => x.id === id);
    if (!g) return 'someone';
    return displayName({ name: g.name, roleBasedName: g.roleBasedName }, roleBasedNameOnlyMode);
  };

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

  const empty = pills.length === 0 && tasks.length === 0;

  return (
    <div className="chat-pill-row" role="toolbar" aria-label="Threads and tasks">
      <output className="sr-only">{announcement}</output>
      <div className="chat-pill-row-scroll">
        {empty && <span className="chat-pill-row-empty muted small">No recent threads</span>}

        {pills.map((pill) => (
          <ThreadPillButton
            key={pill.sessionId}
            pill={pill}
            gezels={gezels}
            gezelName={nameFor(pill.gezelId)}
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
                    className="chat-pill-overflow-item"
                  >
                    <span className="chat-pill-overflow-title">{pill.title}</span>
                    <span className="muted small">
                      {nameFor(pill.gezelId)} · {formatRelativeTime(pill.lastActivityAt)}
                    </span>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}

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

function ThreadPillButton({
  pill,
  gezels,
  gezelName,
  active,
  onFocus,
}: {
  pill: ThreadPill;
  gezels: GezelSummary[];
  gezelName: string;
  active: boolean;
  onFocus: (pill: ThreadPill) => void;
}) {
  const gezel = gezels.find((g) => g.id === pill.gezelId);
  // The dot carries state visually; the accessible name carries it in
  // words, so the decorative element never has to be read out.
  const stateWord =
    pill.state === 'inflight' ? ' — working' : pill.state === 'errored' ? ' — failed' : '';
  const title =
    pill.state === 'errored' && pill.error
      ? `${gezelName} · ${pill.title} · last turn failed: ${pill.error}`
      : `${gezelName} · ${pill.title} · ${formatRelativeTime(pill.lastActivityAt)}`;

  return (
    <button
      type="button"
      className={`chat-pill chat-pill-thread chat-pill-${pill.state}${active ? ' is-active' : ''}`}
      aria-pressed={active}
      aria-label={`${gezelName}: ${pill.title}${stateWord}`}
      title={title}
      onClick={() => onFocus(pill)}
    >
      <GezelIcon
        svg={gezel?.icon ?? null}
        poppetje={gezel?.poppetje}
        iconOverride={gezel?.iconOverride}
        name={gezelName}
        size={14}
      />
      <span className="chat-pill-label">{gezelName}</span>
      {pill.state !== 'idle' && <span className="chat-pill-dot" aria-hidden="true" />}
    </button>
  );
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
