import type {
  GezelSummary,
  Project,
  TerminalTimelineEntry,
  TimelineMessage,
} from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { GezelIcon } from './GezelIcon.js';
import type { LiveSlot } from './chat-live-slot.js';

export function renderDivider(args: {
  row:
    | { kind: 'message'; msg: TimelineMessage; at: string }
    | { kind: 'streaming'; sessionId: string; slot: LiveSlot; at: string };
  gezels: Map<string, GezelSummary>;
  projects: Map<string, Project>;
  showProjectName?: boolean;
  activeSessionId: string | undefined;
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  /**
   * True when this divider re-introduces a session that already
   * appeared above in the timeline — happens whenever interleaved
   * activity from another session pushed bubbles in between. Switches
   * the wording from "new conversation" to "continuing" so the user
   * doesn't think their reply landed somewhere else.
   */
  continuing: boolean;
  /** Visual nesting level for a session opened by another visible session. */
  depth?: number;
  key: string;
  /**
   * Threaded in from the caller because `renderDivider` is invoked as a
   * plain function (not a React component) — calling
   * `useRoleBasedNameOnlyMode` here would land in the parent's hook
   * sequence inconsistently and crash with React error #310.
   */
  roleBasedNameOnlyMode: boolean;
}): React.ReactNode {
  const {
    row,
    gezels,
    projects,
    showProjectName,
    activeSessionId,
    onFocusSession,
    continuing,
    depth = 0,
    key,
    roleBasedNameOnlyMode,
  } = args;
  const sessionId = row.kind === 'streaming' ? row.sessionId : row.msg.sessionId;
  const gezelId = row.kind === 'streaming' ? row.slot.gezelId : row.msg.gezelId;
  const projectId = row.kind === 'streaming' ? row.slot.projectId : row.msg.projectId;
  const gezel = gezels.get(gezelId);
  // Mirror the message-bubble rule: the implicit 'default' bucket is
  // never worth calling out — "in Default" is just noise on the global
  // and Meester timelines.
  const project = showProjectName && projectId !== 'default' ? projects.get(projectId) : undefined;
  const isActive = sessionId === activeSessionId;
  const createdAt =
    row.kind === 'message'
      ? row.msg.sessionCreatedAt
      : (row.slot.sessionCreatedAt ?? new Date(row.slot.startedAt).toISOString());
  const taskRef = row.kind === 'message' ? row.msg.taskRef : row.slot.taskRef;
  const source = row.kind === 'message' ? row.msg.sessionSource : row.slot.sessionSource;
  const parentSession = row.kind === 'message' ? row.msg.parentSession : undefined;
  const legacyHandoff = row.kind === 'message' ? row.msg.handoffFrom : undefined;
  const parent =
    parentSession ??
    (legacyHandoff ? { ...legacyHandoff, kind: 'task-handoff' as const } : undefined);
  const parentName = parent
    ? (() => {
        const hg = gezels.get(parent.gezelId);
        return hg
          ? displayName({ name: hg.name, roleBasedName: hg.roleBasedName }, roleBasedNameOnlyMode)
          : undefined;
      })()
    : undefined;
  const gezelName = gezel
    ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, roleBasedNameOnlyMode)
    : 'Gezel';

  const isBackgroundActivity = row.kind === 'streaming' && sessionId.startsWith('one-shot:');
  if (isBackgroundActivity) {
    const activity = row.slot.activity?.trim() || 'Background work';
    return (
      <output key={key} className="timeline-session-divider timeline-session-divider-activity">
        <GezelIcon
          svg={gezel?.icon ?? null}
          poppetje={gezel?.poppetje}
          iconOverride={gezel?.iconOverride}
          name={gezelName}
          size={16}
        />
        <span className="timeline-divider-meta" title={formatAbsoluteTime(createdAt)}>
          {gezelName} · {activity}
          {project && <> · in {project.name}</>}
          {' · '}started {formatRelativeTime(createdAt)}
        </span>
      </output>
    );
  }

  return (
    <button
      key={key}
      type="button"
      className={`timeline-session-divider${isActive ? ' timeline-session-divider-active' : ''}${
        continuing ? ' timeline-session-divider-continuing' : ''
      }${
        depth > 0
          ? ` timeline-session-divider-child timeline-session-depth-${Math.min(depth, 4)}`
          : ''
      }`}
      onClick={() => onFocusSession?.(sessionId, gezelId, projectId)}
      title={
        source
          ? `View this read-only thread from ${source.appName}`
          : 'Focus this thread — composer will post here'
      }
    >
      <GezelIcon
        svg={gezel?.icon ?? null}
        poppetje={gezel?.poppetje}
        iconOverride={gezel?.iconOverride}
        name={gezelName}
        size={16}
      />
      <span className="timeline-divider-meta" title={formatAbsoluteTime(createdAt)}>
        {continuing ? (
          <>
            ↩ continuing with {gezelName}
            {project && <> · in {project.name}</>}
            {source && <> · from {source.appName} · read-only</>}
          </>
        ) : source ? (
          <>
            external thread with {gezelName} · from {source.appName} · read-only
            {project && <> · in {project.name}</>}
            {' · '}started {formatRelativeTime(createdAt)}
          </>
        ) : parent ? (
          <>
            {parent.kind === 'consultation'
              ? `consultation with ${gezelName}`
              : parent.kind === 'task-handoff'
                ? `task hand-off to ${gezelName}`
                : `delegated to ${gezelName}`}
            {project && <> · in {project.name}</>}
            {' · '}started {formatRelativeTime(createdAt)}
          </>
        ) : (
          <>
            new thread with {gezelName}
            {project && <> · in {project.name}</>}
            {' · '}started {formatRelativeTime(createdAt)}
          </>
        )}
        {taskRef && <> · task {taskRef}</>}
      </span>
      {parent && parentName && (
        <span className="timeline-divider-handoff">
          <svg
            className="timeline-divider-handoff-icon"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M2.5 4.25v2.1a4.4 4.4 0 0 0 4.4 4.4H13" />
            <path d="m10.5 8.25 2.75 2.5-2.75 2.5" />
          </svg>
          {parent.kind === 'task-handoff' ? 'from' : 'by'} {parentName}
        </span>
      )}
    </button>
  );
}

/**
 * Render a "start of a terminal session" divider inside the project
 * timeline. Emitted when a terminal entry is either the first one
 * seen for its `(project, workingDir)` thread, or follows the
 * previous terminal entry in that thread by more than
 * `TERMINAL_SESSION_GAP_MS`. Mirrors the chat session divider's
 * look (dashed top border, muted small text) so the user sees a
 * consistent "section break" rhythm. Not clickable — there's no
 * underlying session entity to focus on, unlike chat sessions.
 */
export function renderTerminalSessionDivider(args: {
  entry: TerminalTimelineEntry;
  key: string;
}): React.ReactNode {
  const { entry, key } = args;
  const folder = entry.workingDir === '' ? '/' : entry.workingDir;
  return (
    <div key={key} className="timeline-session-divider timeline-terminal-session-divider">
      <span className="terminal-folder-pill" title="Working folder">
        {folder}
      </span>
      <span className="timeline-divider-meta" title={formatAbsoluteTime(entry.at)}>
        terminal session · started {formatRelativeTime(entry.at)}
      </span>
    </div>
  );
}
