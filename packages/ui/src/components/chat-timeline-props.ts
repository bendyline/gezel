import type { ListTimelineResponse } from '@bendyline/gezel';
import type { ToolActivity } from './chat-bubbles.js';
import type { OpenChatReference } from './chat-open-command.js';
import type { QueuedTaskEntry } from './queued-task-entries.js';

export interface ChatTimelineViewProps {
  /** Stable cache key — changing it clears all state and re-loads. */
  scopeKey: string;
  /** Currently focused session — its messages render at full opacity. */
  activeSessionId: string | undefined;
  /** Click on a session divider focuses that session in the parent. */
  onFocusSession?: (sessionId: string, gezelId: string, projectId: string) => void;
  /** Forwarded for the References pane. */
  onToolActivity?: (tool: ToolActivity) => void;
  /**
   * Forwarded to each `MessageBubble` so the chip row + inline
   * `#artifact:` link clicks can route back to the References pane.
   * The second argument is the message's originating `projectId` —
   * required on cross-project surfaces like the Meester's global
   * timeline so the artifact is looked up in the right project.
   */
  onArtifactReference?: (path: string, projectId?: string) => void;
  /** Passively remembers parsed artifact mentions for `/open` MRU suggestions. */
  onArtifactSeen?: (path: string, projectId?: string) => void;
  /**
   * Opens a verified workspace-file reference in the right rail — from a
   * terminal `openFile` event, or from a `#workspace:` chip/link the
   * reference parser recognized in a reply body.
   */
  onWorkspaceReference?: (path: string, projectId?: string) => void;
  /** Passively remembers parsed + tool-touched workspace paths for `/open` MRU suggestions. */
  onWorkspaceSeen?: (path: string, projectId?: string) => void;
  /** Opens a file path rendered inside a tool row in the References viewer. */
  onOpenReference?: (reference: OpenChatReference) => void;
  /**
   * Forwarded from {@link ChatReferences} so the right rail's "Task" tab
   * can surface the work context. The timeline feeds it two ways: every
   * message's own `taskRef` (the session's scoped task → `scoped: true`,
   * pinned) and any `referencedTasks` the parser recognized in a reply
   * body (`scoped: false`). Dedupe + ordering live in the rail.
   */
  onTaskReference?: (
    ref: string,
    opts?: { scoped?: boolean; focus?: boolean; wrappedUp?: boolean },
  ) => void;
  /**
   * Tasks the TaskRunner is holding, paired with the queue state that
   * explains the hold. Rendered as receipt cards in the final lane —
   * accepted work that hasn't spoken yet, so a busy machine reads as
   * "coming up" instead of as a dropped request. Any entry whose task
   * is already streaming a turn here is dropped: the live bubble IS its
   * representation. Omitted by surfaces with no task authority.
   */
  queuedTasks?: QueuedTaskEntry[];
  /** Empty-state copy shown above the composer when no messages exist. */
  emptyPlaceholder?: string;
  /**
   * Rich empty state, rendered instead of {@link emptyPlaceholder} when the
   * conversation has no messages. The meester's workshop uses it to introduce
   * itself rather than opening as a blank panel.
   */
  emptyContent?: import('react').ReactNode;
  /**
   * Shown after the last message of a conversation that has any, where the
   * pinned scroll keeps it in view above the composer. An empty conversation
   * has {@link emptyContent} instead.
   */
  trailingContent?: import('react').ReactNode;
  /**
   * Hold {@link trailingContent} until the conversation holds a finished
   * task's wrap-up: the meester's folder invitation follows the first thing
   * the crew made, not the first thing the person said.
   */
  trailingContentAfterWrapUp?: boolean;
  /**
   * Fold the sessions a turn launched (a task's workers, a consultation)
   * into one Working notes line under it, so the person reads the ask and
   * the result rather than the crew's transcript. On by default in every
   * conversation; debug mode shows the full tree. A fold holding a question
   * the person has not answered opens itself.
   */
  foldWorkingNotes?: boolean;
  /**
   * Drop live events from scheduled runs (`ChatEventEnvelope.scheduledRun`).
   * Home's loader already leaves those sessions out; this keeps a run that
   * starts while Home is open from streaming in.
   */
  hideScheduledRuns?: boolean;
  /**
   * What in this conversation is waiting on the person: a failed turn whose
   * card is showing, and when the latest reply arrived. Home keeps its
   * greeting band out of the way while either needs them.
   */
  onAttentionChange?: (attention: { failedTurn: boolean; latestReplyAt: string | null }) => void;
  /**
   * Backend fetcher — `ProjectTimeline` calls `listProjectTimeline`,
   * `GlobalTimeline` calls `listGlobalTimeline`.
   */
  loadTimeline: (opts: {
    limit: number;
    before?: string;
  }) => Promise<ListTimelineResponse>;
  /**
   * SSE stream factory — returns the URL for `streamProjectChatEvents` /
   * `streamAllChatEvents`.
   */
  streamUrl: () => string;
  /**
   * Per-project terminal SSE stream URL (one per project page). Only
   * the project-scoped timeline supplies this; global / per-gezel
   * timelines leave it undefined. When set, terminal command +
   * output entries flow into the same row stream as chat messages,
   * interleaved by `at`.
   */
  terminalStreamUrl?: () => string;
  /**
   * Changes after a terminal command POST has been acknowledged. SSE is
   * still the fast path, but the matching timeline snapshot is merged as
   * an acknowledgement fallback so a transient stream write cannot leave
   * a persisted command invisible until the project is reopened.
   */
  terminalRefreshKey?: number;
  /**
   * The most recent terminal command submitted from the composer beside
   * this timeline. Unlike background terminal activity, a local submission
   * should always bring its own command row into view, even when the user
   * had scrolled up to read older history. `runId` makes repeated identical
   * commands distinct; the row itself is resolved by thread + input because
   * persisted terminal entries intentionally do not expose run ids.
   */
  terminalSubmission?: {
    runId: string;
    threadId: string;
    input: string;
  };
  /**
   * Requests navigation to the newest rendered row for a terminal thread.
   * `requestKey` makes repeated clicks on the same task-bar chip distinct.
   */
  terminalFocusRequest?: { threadId: string; requestKey: number };
  /**
   * Requests navigation to a chat session's newest rendered row (its
   * failed-turn banner when it has one). `requestKey` makes repeated
   * clicks on the same task-bar chip distinct.
   *
   * Separate from `activeSessionId`: pointing the composer at a thread and
   * moving the viewport to it are different intents — a session divider
   * click already lands the user on the rows they clicked, and scrolling
   * then would be a jump they didn't ask for.
   */
  sessionFocusRequest?: {
    sessionId: string;
    requestKey: number;
    /**
     * 1-based index into the session's messages — a transcript-search hit's
     * location. When set the viewport lands on that message instead of the
     * session's last bubble (clamped; approximate when the timeline elides
     * empty messages, which is close enough for the flash to orient).
     */
    messageIndex?: number;
  };
  /**
   * Fired when the terminal SSE channel reports a `workingDirChanged`
   * event — i.e. the shell behind a thread cd'd to a new path. The
   * parent (ProjectChat) updates its `terminalWorkingDir` display
   * state so the folder picker reflects where the shell actually is.
   * Subsequent commands still POST with the *original* threadId so
   * the persistent shell session stays alive. Only fires on
   * project-scoped surfaces where `terminalStreamUrl` is wired.
   */
  onTerminalWorkingDirChanged?: (threadId: string, newWorkingDir: string) => void;
  /** When true, session dividers also include the project name. */
  showProjectName?: boolean;
  /**
   * Scope for the inflight-turns query issued on mount. The timeline
   * view reseeds `liveRef` with one slot per in-flight session so the
   * assistant's thinking-dots bubble re-renders if the user tabbed
   * away during a slow turn and came back before the next delta.
   * Leaving this unset matches every in-flight turn install-wide
   * (GlobalTimeline); setting `{ projectId }` filters to that project
   * (ProjectTimeline).
   */
  inflightScope?: { projectId?: string; gezelId?: string };
  /**
   * Session allowlist. When set, only rows and live turns belonging to
   * one of these sessions render.
   *
   * Needed because the SSE channel a caller subscribes to is always the
   * *coarser* scope (project or gezel) and chat envelopes carry no
   * `taskRef` — so a task-scoped timeline whose initial fetch was
   * filtered server-side would still have unrelated sessions stream in
   * live. `inflightScope` can't express this: the filter is a property
   * of the session, not of the (project, gezel) pair.
   */
  scopedSessionIds?: ReadonlySet<string>;
  /**
   * Fired when `scopedSessionIds` is set and an event arrives for a
   * session that isn't in it. The owner refetches the scope's session
   * list — this is how a handoff session spawned mid-turn (by
   * `advance_task_step`, under the same task but a different gezel)
   * joins the allowlist without a reload.
   */
  onUnknownSession?: (sessionId: string) => void;
}
