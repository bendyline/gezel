import type {
  ChatEventEnvelope,
  ChatTurnErrorDetail,
  GezelSummary,
  ListTimelineResponse,
  Project,
  ProviderName,
  Question,
  SessionGpuTask,
  TerminalTimelineEntry,
  TimelineMessage,
} from '@bendyline/gezel';
import { displayName, resolveGezelFontFamily, resolveGezelFontScale } from '@bendyline/gezel';
import type { SseStreamOptions } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { isUserCancelledTurnError } from '../error-report.js';
import { streamSharedProjectChatEvents } from '../shared-chat-events.js';
import { GezelIcon } from './GezelIcon.js';
import { getReadonlyGezelMediaProvider } from './GezelMediaProvider.js';
import { ReportErrorLink } from './ReportErrorLink.js';
import { TerminalBubble } from './TerminalBubble.js';
import { TerminalStreamingBubble } from './TerminalStreamingBubble.js';
import {
  GhostQueuedBubble,
  type InlineWarning,
  MessageBubble,
  RoleSuffix,
  StreamingBubble,
  StreamingStatusLine,
  type ToolActivity,
  useElapsedSeconds,
} from './chat-bubbles.js';
import {
  type OptimisticUserMessage,
  subscribeOptimisticUserMessages,
} from './chat-optimistic-events.js';
import { consumeFocusSessionError } from './pending-focus-session-error.js';
import { compareTimelineRows, nextTerminalBottomGraceExpiry } from './timeline-row-order.js';
import { buildTimelineThreads } from './timeline-threads.js';
import { useNarrateAssistantReplies } from './useNarrateAssistantReplies.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

const PAGE_SIZE = 100;
// On-device providers. Their model ids (e.g. `qwen3.6-35b-a3b-q4`) are
// long, opaque, and uninteresting at a glance, so we never surface them
// as a drift pill in the bubble header — the model is available on hover
// via the author-name tooltip instead. Cloud providers still show drift.
const LOCAL_PROVIDERS: ReadonlySet<ProviderName> = new Set(['ollama', 'llama-cpp', 'mlx']);
const RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/**
 * Gap past which a reply inside a thread is "late": it keeps its
 * author header and gains a relative timestamp instead of merging into
 * the previous author run. The continuation loop's trailing status
 * iterations (fired minutes after the turn's visible reply) are the
 * canonical case — without the time cue they read as instant replies.
 */
const LATE_REPLY_GAP_MS = 3 * 60 * 1000;
const SCROLL_NEAR_BOTTOM_PX = 80;
const SCROLL_NEAR_TOP_PX = 80;
const SCROLLBAR_IDLE_MS = 700;
/** How long the flash ring stays on a row a navigation jumped to. */
const FOCUS_FLASH_MS = 2000;
/**
 * How long a "jump to this session's failed turn" request keeps retrying
 * across renders while the timeline's first page loads. Past this, the
 * session's rows almost certainly aren't in the loaded window at all.
 */
const FOCUS_RETRY_WINDOW_MS = 8000;

/**
 * Quote a value for use inside a `[attr="…"]` selector. `CSS.escape`
 * isn't available in every environment we render in (jsdom, older
 * webviews), and session ids are opaque strings we don't control.
 */
function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
// A terminal "session" is a run of commands inside one
// `(project, workingDir)` thread with no gap longer than this. The
// gap is measured terminal-to-terminal within the same thread —
// chat messages or other-folder commands landing in between don't
// reset it. Picked at 2h to roughly match a working session: short
// enough that "after lunch" reads as a new thread, long enough that
// stepping away to read docs doesn't fragment one task.
const TERMINAL_SESSION_GAP_MS = 2 * 60 * 60 * 1000;

function mergeTerminalEntries(
  snapshot: TerminalTimelineEntry[] | undefined,
  liveEntries: TerminalTimelineEntry[],
): TerminalTimelineEntry[] {
  const byId = new Map((snapshot ?? []).map((entry) => [entry.messageId, entry]));
  for (const entry of liveEntries) byId.set(entry.messageId, entry);
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Merge a newest-page snapshot into the rows already on screen. Older pages
 * remain intact, while a matching durable user row retires its optimistic
 * counterpart. Shared by completion refreshes and the initial
 * snapshot/subscription handoff reconciliation.
 */
function mergeTimelineMessages(
  existing: TimelineMessage[],
  snapshot: TimelineMessage[],
): TimelineMessage[] {
  const canonicalUsers = snapshot.filter((message) => message.role === 'user');
  const withoutReconciledOptimistic = existing.filter((message) => {
    if (!(message as OptimisticTimelineMessage).optimistic) return true;
    const optimisticAtMs = Date.parse(message.at);
    return !canonicalUsers.some((real) => {
      if (real.sessionId !== message.sessionId || real.content !== message.content) return false;
      const realAtMs = Date.parse(real.at);
      return Number.isFinite(optimisticAtMs) && Number.isFinite(realAtMs)
        ? Math.abs(realAtMs - optimisticAtMs) < 2 * 60_000
        : true;
    });
  });
  const seen = new Set<string>();
  const merged: TimelineMessage[] = [];
  for (const message of [...withoutReconciledOptimistic, ...snapshot]) {
    const key = `${message.sessionId}:${message.at}:${message.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return merged;
}

/**
 * Human labels for the llama-cpp `engine_phase` event. Used by the
 * streaming bubble's status line — the detail string from the
 * stdout classifier gets used verbatim when available (e.g.
 * "Loading model weights (2356.44 MiB)"), otherwise we fall back
 * to the base label.
 *
 * `prefill` is technically "engine is reading the prompt and
 * filling the KV cache before any tokens stream", but the
 * conversational "Thinking it through" reads warmer than the
 * literal phrasing and matches the ambient THINKING tone — and is
 * accurate enough (the model is absorbing the conversation before
 * speaking). The `generating` label takes over the moment the first
 * token arrives.
 */
const PHASE_LABELS: Record<
  'starting' | 'loading_model' | 'prefill' | 'generating' | 'ready',
  string
> = {
  starting: 'Starting engine',
  loading_model: 'Loading model',
  prefill: 'Thinking it through',
  generating: 'Generating',
  ready: 'Ready',
};

/**
 * Render a single-line plain-text preview of a markdown message body.
 * Used by the sticky context-header to show the originating user
 * prompt without leaking raw `@[Name](gezel:id)` mention syntax,
 * `**bold**`, code fences, etc. The full text is available in the
 * sticky's `title` attribute for users who want to read the original.
 *
 * Deliberately regex-based and forgiving — the input is a chat message
 * (typically one short paragraph), not arbitrary CommonMark, so a
 * dedicated parser would be overkill. Order matters: image refs
 * before plain links (the `!` would survive otherwise), mention links
 * before plain links (so `@[Name]` keeps its `@`).
 */
function previewifyMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](src) → alt
    .replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1') // @[Name](gezel:id) → @Name
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** → bold
    .replace(/__([^_]+)__/g, '$1') // __bold__ → bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1') // *italic* → italic
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1') // _italic_ → italic
    .replace(/~~([^~]+)~~/g, '$1') // ~~strike~~ → strike
    .replace(/`+([^`]+)`+/g, '$1') // `code` → code
    .replace(/^\s*#+\s+/gm, '') // # heading → heading
    .replace(/^\s*>\s+/gm, '') // > quote → quote
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered-list markers
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One unit of in-flight assistant activity. The streaming bubble
 * renders these in DOM order so tool calls appear inline with the
 * surrounding prose ("here's what I read · here's what I wrote ·
 * now I'm going to write this") instead of all stacked at the top
 * of the bubble. Built by appending each `delta` / `tool` event in
 * arrival order.
 */
type LiveSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; tool: ToolActivity }
  | { kind: 'intent'; label: string };

type OptimisticTimelineMessage = TimelineMessage & { optimistic?: true };

/**
 * Live "growing" terminal output bubble. Mirrors `LiveSlot`'s
 * shape (kept-in-ref state, `*Bump` counter triggers redraw) but
 * scoped to a terminal `runId` instead of a chat sessionId. One
 * slot per in-flight `runId`; created by `runStarted` SSE events,
 * grown by `outputChunk` events, dropped when the final `message`
 * event arrives carrying the matching `runId`.
 */
interface TerminalLiveSlot {
  projectId: string;
  threadId: string;
  /** Id of the paired command bubble — used to anchor the slot's
   *  position in the row list (slot sorts right after the command). */
  commandMessageId: string;
  /** ISO timestamp the run started; same wall-clock as the
   *  `runStarted` event's `at`. Used for sort tiebreaks. */
  startedAt: string;
  /** Folder-pill display string (project-relative or absolute). */
  cwd: string;
  /** Concatenated `outputChunk` payloads. The streaming bubble
   *  re-renders this complete buffer through `AnsiOutput`. */
  content: string;
  /** Set by `inputRequested` SSE events; cleared by the next
   *  `outputChunk` (which implies the shell got our input and
   *  is making progress again). Drives the inline reply UI. */
  awaitingInput?: { promptLine: string; mode: 'text' | 'password' | 'yes-no' };
}

interface LiveSlot {
  gezelId: string;
  projectId: string;
  /**
   * Ordered timeline of text + tool segments — mutated in place by
   * the SSE handlers as `delta` and `tool` events arrive. Adjacent
   * `delta`s coalesce into one text segment so a normal token
   * stream produces a single markdown render between any two tool
   * boundaries.
   */
  segments: LiveSegment[];
  startedAt: number;
  /**
   * Wall-clock of the last observable signal for this turn — a
   * delta token or a completed tool call. Used by `StreamingBubble`
   * to drive the "Still working" reassurance banner: the banner
   * should only appear during *silent* phases, not just long turns.
   * A turn with visible tool activity shouldn't also say "slow
   * local models can take a few minutes" — the tool call IS the
   * progress signal.
   *
   * Initialized to `startedAt` so a turn that never emits anything
   * does show the banner after the threshold elapses.
   */
  lastActivityAt: number;
  /** True only after this turn emits an actual provider/model progress signal. */
  hasProgress: boolean;
  /**
   * Most-recent `at` we've seen for any message in this session, used to
   * place the streaming row chronologically. Updated when the streaming
   * session has prior messages in the loaded window.
   */
  anchorAt: string;
  /**
   * If we know the session metadata (because the session already has
   * messages in the timeline), keep a snapshot for the divider header.
   * Otherwise the streaming session is brand-new — the divider falls
   * back to the gezel name + "live now".
   */
  sessionTitle?: string;
  sessionCreatedAt?: string;
  /**
   * Session-pinned provider + model — populated when we have at least
   * one persisted message from this session in the loaded window.
   * Drives the drift pill on the streaming bubble. Absent for brand-
   * new sessions that have no prior messages; in that case the session
   * was created with the current defaults, so there's nothing to flag.
   */
  sessionProviderName?: ProviderName;
  sessionModel?: string;
  taskRef?: string;
  /**
   * Set when the turn ended in error (context overflow, provider crash,
   * timeout). The slot isn't deleted in that case — we keep it around
   * so the user can see whatever partial content streamed in before
   * the failure, annotated with why it stopped. Cleared when the next
   * user_message for this session replaces the slot.
   */
  error?: string;
  /** Machine-readable classification of {@link error}, when the daemon knew one. */
  errorDetail?: ChatTurnErrorDetail;
  /**
   * When set, this turn is waiting in the provider queue — not yet
   * streaming. Number is how many turns are ahead of it. Populated
   * from `queued` SSE events; cleared on the first delta.
   */
  queueAhead?: number;
  /**
   * Count of bare framing chunks ("wire pulses") received from the
   * provider since the last visible event (delta / tool /
   * complete). Renders as accumulating dots in the streaming
   * bubble so the user can see "Ollama is still ticking on the
   * wire" during long silent reasoning phases. Reset to 0 on any
   * real activity. Capped in render so a model that pulses
   * forever doesn't grow the bubble unbounded.
   */
  wirePulseCount?: number;
  /**
   * Live private-reasoning text, accumulated from `reasoning_delta`
   * events while the model's think phase streams. Rendered as a distinct
   * dimmed "thinking" block above the reply; discarded when the turn
   * commits (the persisted message carries the same trace on its
   * `reasoning` field, rendered behind the collapsed expander instead).
   */
  liveReasoning?: string;
  /**
   * Live tool-argument stream, accumulated from `tool_args_delta`
   * events while the model generates a structured tool call (most
   * visibly a multi-minute `write_file` whose tokens never arrive as
   * deltas). `chars` is the running total; `tail` keeps only the most
   * recent stretch (capped) for the dimmed live "working" block near
   * the streaming caret. Cleared when the matching `tool` event lands
   * (the real tool row supersedes it) and on `complete`.
   */
  liveToolArgs?: { name: string; chars: number; head: string; tail: string };
  /**
   * Optional short label from a provider heartbeat (e.g. 'thinking'
   * during Copilot's server-side reasoning phases). Drives the
   * streaming bubble's status line so a long silent reasoning stretch
   * reads "Thinking…" instead of a bare spinner.
   */
  thinkingLabel?: string;
  /**
   * 0-1 progress for the current `engine_phase` event when one is
   * available (chunked prefill batches). When set, the streaming
   * bubble renders a progress bar in place of the verbose token
   * counts; `thinkingDetail` carries the original "X / Y tokens · Z
   * tok/s" text into the tooltip.
   */
  thinkingProgress?: number;
  /**
   * Verbose detail string for the current phase (e.g. "4,096 / 7,880
   * tokens · 298 tok/s") — surfaced as the progress bar's tooltip
   * when `thinkingProgress` is set.
   */
  thinkingDetail?: string;
  /**
   * Set when a `gpu_swap` event with `state: 'started'` has arrived
   * for this session and not yet been paired with `state: 'ended'`.
   * Means the GPU is currently held by a non-LLM workload (today:
   * local image generation), so the chat model is paused. Drives
   * a distinct status label and suppresses the "still working —
   * silent for X seconds" reassurance banner, which doesn't apply
   * when something else is the actual GPU tenant.
   */
  gpuSwapTask?: SessionGpuTask;
  /** Free-form detail attached to the active `gpu_swap` event. */
  gpuSwapDetail?: string;
  /** Prompt the model passed to the image generator — shown as narrative under the status. */
  gpuSwapPrompt?: string;
  /** 0–1 progress through the current image-generation request. */
  gpuSwapProgress?: number;
  /** Latest sampling step / total steps reported by sd-server, when known. */
  gpuSwapStep?: number;
  gpuSwapTotalSteps?: number;
  /** Most recent per-step seconds reading; used to render a coarse ETA. */
  gpuSwapSecondsPerStep?: number;
  /**
   * Set when an `awaiting_gezel` event with `state: 'started'` has
   * arrived and not yet been paired with `state: 'ended'`. Means this
   * turn is parked inside a synchronous `ask_gezel`/`ask_specialist`
   * consultation — the model is idle, blocked on a reply from
   * `name`. Drives a passive "Waiting on <name>" status, dims the
   * bubble, and suppresses the "still working — silent for Xs"
   * reassurance banner (the wait is expected, not a stall).
   */
  awaitingGezelName?: string;
  /**
   * Provider-side warnings that arrived mid-turn (Copilot
   * `session.warning`, etc.). Rendered as inline notices on the
   * streaming bubble so the user isn't left guessing why a turn is
   * dragging or why the provider dropped into degraded mode.
   */
  warnings?: InlineWarning[];
}

/**
 * Find clean live slots that survived locally even though the service no
 * longer reports their turns as in flight. Object identity protects slots
 * created or replaced while the reconciliation request was in flight.
 */
export function staleLiveSessionIds(
  current: ReadonlyMap<string, { error?: string }>,
  observed: ReadonlyMap<string, object>,
  inflight: ReadonlySet<string>,
): string[] {
  const stale: string[] = [];
  for (const [sessionId, observedSlot] of observed) {
    const currentSlot = current.get(sessionId);
    if (!currentSlot || currentSlot !== observedSlot) continue;
    if (!currentSlot.error && !inflight.has(sessionId)) stale.push(sessionId);
  }
  return stale;
}

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
  /** Opens a verified terminal workspace-file reference in the right rail. */
  onWorkspaceReference?: (path: string, projectId?: string) => void;
  /**
   * Forwarded from {@link ChatReferences} so the right rail's "Task" tab
   * can surface the work context. The timeline feeds it two ways: every
   * message's own `taskRef` (the session's scoped task → `scoped: true`,
   * pinned) and any `referencedTasks` the parser recognized in a reply
   * body (`scoped: false`). Dedupe + ordering live in the rail.
   */
  onTaskReference?: (ref: string, opts?: { scoped?: boolean }) => void;
  /** Empty-state copy shown above the composer when no messages exist. */
  emptyPlaceholder?: string;
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

/**
 * Shared interleaved chat-timeline rendering. Used by both `ProjectTimeline`
 * (project-scoped) and `GlobalTimeline` (Meester / global-scoped). The
 * differences are entirely in the data source: see props.
 *
 * Fade rule: a message renders at full opacity when (a) its sessionId
 * matches `activeSessionId`, OR (b) the parent session was active in the
 * last 24h, OR (c) it's a live streaming row. Older sessions get the
 * `timeline-msg-faded` class for ~0.55 opacity (hover restores 0.9).
 *
 * Live messages are kept in `liveRef` (a mutable ref, not state) so
 * delta-per-token updates don't trigger O(N) message re-renders. A single
 * `liveBump` counter forces a redraw of just the streaming rows.
 */
export function ChatTimelineView({
  scopeKey,
  activeSessionId,
  onFocusSession,
  onToolActivity,
  onArtifactReference,
  onWorkspaceReference,
  onTaskReference,
  emptyPlaceholder,
  loadTimeline,
  streamUrl,
  terminalStreamUrl,
  terminalRefreshKey,
  terminalSubmission,
  onTerminalWorkingDirChanged,
  showProjectName,
  inflightScope,
  scopedSessionIds,
  onUnknownSession,
}: ChatTimelineViewProps) {
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  // Live refs — the envelope stream effect captures `handleEnvelope`
  // once per scope and does not re-subscribe when the allowlist grows
  // (a handoff session joining it must not tear down the SSE
  // connection mid-turn). Reading through refs keeps the guard current
  // inside that long-lived closure.
  const scopedSessionIdsRef = useRef(scopedSessionIds);
  scopedSessionIdsRef.current = scopedSessionIds;
  const onUnknownSessionRef = useRef(onUnknownSession);
  onUnknownSessionRef.current = onUnknownSession;
  const narrateAssistantReplies = useNarrateAssistantReplies();
  // Live ref so the `complete` event handler reads the current value
  // without the streaming `useEffect` re-subscribing whenever the
  // setting flips. Mirrors the long-lived ref pattern below.
  const narrateRef = useRef(narrateAssistantReplies);
  narrateRef.current = narrateAssistantReplies;
  /**
   * The currently-playing narration audio element. Stopped before the
   * next reply plays so we don't stack overlapping voices when multiple
   * assistants complete in quick succession, or when a slow reply
   * arrives after the user has already moved on. Cleared on cleanup.
   */
  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);
  /** Abort controller for the in-flight narration synth, so a new turn can
   *  cancel a slow prior synth instead of letting them pile up. */
  const narrationAbortRef = useRef<AbortController | null>(null);
  /**
   * Per-session buffer for the most recent non-empty assistant content
   * seen on `complete`. `complete` events fire per iteration of the
   * chat manager's continuation loop (tool-only stall recoveries fire
   * extra iterations after the user-visible reply already landed). We
   * defer narration to `done` so the user only hears the final reply
   * once the chain settles — and the kokoro inference doesn't fight
   * llama for CPU during the continuation iterations themselves.
   */
  const pendingNarrationRef = useRef<
    Map<string, { content: string; gezelId: string; projectId: string }>
  >(new Map());
  // Unmount cleanup — stop any audio in flight so navigating away mid-
  // narration doesn't leave a disembodied gezel talking off-screen.
  useEffect(() => {
    return () => {
      stopNarration(narrationAudioRef, narrationAbortRef);
    };
  }, []);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const messagesRef = useRef<TimelineMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Feed the right rail's "Task" tab. Every message carries its parent
  // session's `taskRef`, so a task surfaces from its very first (seed)
  // message without the model ever re-echoing the ref. The ACTIVE
  // session's own task is pinned (`scoped: true`); a task being worked in
  // another session that's interleaved into this project timeline — e.g.
  // the security-review craftbook the voorman just launched to the CSO —
  // surfaces as a plain mention so it's one glance away too. Without this
  // a just-created task the user can watch being worked never appeared in
  // the rail until some reply body happened to echo its ref. Any ref the
  // server-side parser recognized in a reply body (`referencedTasks`) is
  // also added as a mention. The rail dedupes (and promotes a mention to
  // scoped if it later matches the active session), so re-registering on
  // every change is fine.
  useEffect(() => {
    if (!onTaskReference) return;
    for (const m of messages) {
      if (m.taskRef) {
        const scoped = !!activeSessionId && m.sessionId === activeSessionId;
        onTaskReference(m.taskRef, { scoped });
      }
      if (m.referencedTasks) {
        for (const ref of m.referencedTasks) onTaskReference(ref);
      }
    }
  }, [messages, activeSessionId, onTaskReference]);
  /**
   * Terminal entries delivered alongside chat messages on project-scoped
   * surfaces. Empty on global / per-gezel timelines. Mutated on initial
   * load (from `loadTimeline` response) and on every SSE envelope from
   * the project's terminal channel (deduped by messageId).
   */
  const [terminalEntries, setTerminalEntries] = useState<TerminalTimelineEntry[]>([]);
  // Bumped when a fresh terminal row's five-minute bottom-placement
  // grace period ends. The timer lets ordering return to normal even
  // when no new chat or terminal event arrives to trigger a render.
  const [terminalOrderTick, setTerminalOrderTick] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [oldestAt, setOldestAt] = useState<string | undefined>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: terminalOrderTick re-arms the timer for the next recent terminal row after each expiry.
  useEffect(() => {
    const now = Date.now();
    const nextExpiry = nextTerminalBottomGraceExpiry(terminalEntries, now);
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setTerminalOrderTick((tick) => tick + 1),
      Math.max(0, nextExpiry - Date.now() + 1),
    );
    return () => window.clearTimeout(timer);
  }, [terminalEntries, terminalOrderTick]);

  // Phase 4 — warm-on-open. When the user focuses a session, ask the
  // daemon to pre-warm its prompt cache so the first message returns
  // near-instantly. Fire-and-forget; the daemon's `prewarmSession`
  // is no-op for cloud providers and best-effort for local ones,
  // so opening any chat is safe regardless of provider. Only fires
  // for the *actively-viewed* session — we don't pre-warm every
  // open chat (that's an opt-in operator setting for later).
  useEffect(() => {
    if (!activeSessionId) return;
    void api.warmSessionCache(activeSessionId).catch(() => {
      // Best-effort. Engine may not be ready, may not support warming,
      // or session may have no prior history. None of those are
      // worth surfacing to the user.
    });
  }, [activeSessionId]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gezels, setGezels] = useState<Map<string, GezelSummary>>(new Map());
  const [projects, setProjects] = useState<Map<string, Project>>(new Map());
  /**
   * Pending-question lookup keyed by question id. Built by fetching every
   * project's questions once on mount; refreshed when a `question_asked`
   * or `question_answered` SSE envelope arrives. The lookup is shared
   * across all messages so a single fetch covers cross-project surfaces.
   */
  const [questionsById, setQuestionsById] = useState<Map<string, Question>>(new Map());
  const [liveBump, setLiveBump] = useState(0);
  const liveRef = useRef<Map<string, LiveSlot>>(new Map());
  /**
   * In-flight terminal runs. Same shape rationale as `liveRef`:
   * mutated in place by SSE event handlers, redraws driven by
   * `terminalLiveBump`. Separate from `liveRef` so chat streaming
   * frame cost doesn't pull terminal redraws (and vice versa).
   */
  const [terminalLiveBump, setTerminalLiveBump] = useState(0);
  const terminalLiveRef = useRef<Map<string, TerminalLiveSlot>>(new Map());
  /**
   * Per-session ordered list of queued messages — the ghost bubbles
   * we render under each session's streaming bubble. Keyed by
   * sessionId; entries are the queue entries (with id, preview,
   * enqueuedAt) in FIFO order. Mutated by `queue_enqueued` /
   * `queue_removed` SSE events; seeded from `/api/queues` on mount
   * and on scope change.
   */
  const queuedRef = useRef<
    Map<string, Array<{ id: string; preview: string; enqueuedAt: string; nudge?: boolean }>>
  >(new Map());
  /**
   * Per-session context-window status — sticky once set, shown as a
   * banner above the timeline when the session is the active one.
   * `kind: 'warning'` → accumulated conversation crossed the model-context
   * threshold; `kind: 'compacted'` → the service collapsed
   * older messages. The banner stays
   * visible even after the originating turn completes; only a fresh
   * (different) session clears it. Mutated by `context_warning` and
   * `context_compacted` SSE events.
   */
  const contextStatusRef = useRef<
    Map<
      string,
      {
        kind: 'warning' | 'compacted';
        estimatedTokens?: number;
        numCtx?: number;
        model: string;
        removedCount?: number;
        at: number;
      }
    >
  >(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollbarIdleTimerRef = useRef<number | null>(null);
  /**
   * "Pinned to bottom" mode: when true, any new row auto-scrolls the
   * viewport to the bottom, so the timeline acts like a terminal that
   * follows output. Toggled three ways:
   *   - Implicit: scrolling away from the bottom unpins; scrolling back
   *     within `SCROLL_NEAR_BOTTOM_PX` re-pins.
   *   - Explicit: the floating pin button in the lower-right flips it
   *     directly and (when pinning) snaps to the bottom immediately.
   *   - On scope change: reset to `true` so a fresh timeline lands at
   *     the newest messages instead of scrollTop=0.
   * Kept in state (not a ref) so the button can render the live state.
   */
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  /**
   * A prompt submitted from the composer attached to this timeline. It is
   * deliberately separate from ordinary row growth: background messages
   * preserve the reader's scroll position, while the user's own send always
   * lands in view with a small response runway beneath it.
   */
  const [submissionAnchor, setSubmissionAnchor] = useState<
    | {
        kind: 'chat';
        key: string;
        sessionId: string;
        content: string;
        at: string;
      }
    | {
        kind: 'terminal';
        key: string;
        runId: string;
        threadId: string;
        input: string;
      }
    | null
  >(null);
  const [alignedSubmissionKey, setAlignedSubmissionKey] = useState<string | null>(null);
  const paginatingRef = useRef(false);
  /**
   * Sticky context header — surfaces the user message + assistant
   * bubble header for whatever's currently scrolled past the top of
   * the viewport. Recomputed on scroll (rAF-throttled) and after
   * the row list changes. `null` when nothing's scrolled past
   * (top of timeline) or no data attrs found.
   */
  const [stickyHeader, setStickyHeader] = useState<{
    userMessageId: string;
    assistantMessageId: string;
  } | null>(null);
  // rAF token for the scroll handler — coalesces bursty scroll
  // events into one recompute per frame.
  const stickyRecomputeRafRef = useRef<number | null>(null);
  // Last measured height of the rendered sticky header. Cached so
  // `recomputeStickyHeader` can use the same threshold on every
  // frame — using "0 when not visible / H when visible" causes a
  // flip-flop right at the edge of the trigger band. ~60px is a
  // reasonable starting point when nothing's been measured yet.
  const stickyHeightRef = useRef<number>(60);
  /**
   * Last rendered `rows.length`. The auto-scroll effect only anchors
   * to the bottom when the list actually grew — so that unrelated
   * re-renders (SSE events that mutate an existing row in place,
   * prompt reloads, etc.) don't re-scroll a user who was reading. The
   * scope-reset effect also writes this to 0 so a freshly-loaded
   * timeline counts as "grew" on its first render and lands at the
   * newest messages instead of scrollTop=0.
   */
  const lastRowCountRef = useRef(0);
  /**
   * Last observed `scrollHeight` of the timeline scroll container. Used
   * alongside `lastRowCountRef` to drive auto-scroll: a streaming bubble
   * doesn't change the row count but it does grow the scrollHeight as
   * tokens append, so we re-anchor whenever EITHER metric grew. Without
   * this, "pinned to bottom" silently breaks the moment a long streaming
   * response gets taller than the viewport.
   */
  const lastScrollHeightRef = useRef(0);

  // Reload from scratch whenever the scope changes (project switch, Meester
  // chat, etc.). Clears live state too — no point carrying over a streaming
  // session from a project the user navigated away from.
  //
  // Depend on the primitive fields of `inflightScope`, not the object
  // reference — otherwise a caller that constructs the prop inline
  // (`<ChatTimelineView inflightScope={{ projectId }} />`) trips this
  // reload on every parent re-render. The App-level 10s usage poll
  // re-renders the whole tree, so an unstable reference here would
  // make the chat surface flicker every 10s.
  const inflightProjectId = inflightScope?.projectId;
  const inflightGezelId = inflightScope?.gezelId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset/reload trigger — body reads derived pieces but scope swap must re-fire.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessages([]);
    setTerminalEntries([]);
    setHasMore(false);
    setOldestAt(undefined);
    liveRef.current.clear();
    queuedRef.current.clear();
    contextStatusRef.current.clear();
    // Reset the stick-to-bottom state too. Otherwise, if the user
    // was scrolled up reading older history in the previous scope,
    // `pinnedToBottom === false` would carry that forward — and the
    // fresh timeline load would land at scrollTop=0 (top of file)
    // instead of the newest messages. Same reset for the row-count
    // ref so the first post-reload render counts as "grew" and
    // triggers the anchor-to-bottom.
    setPinnedToBottom(true);
    setSubmissionAnchor(null);
    setAlignedSubmissionKey(null);
    lastRowCountRef.current = 0;
    lastScrollHeightRef.current = 0;
    void (async () => {
      try {
        const res = await loadTimeline({ limit: PAGE_SIZE });
        if (cancelled) return;
        setMessages(res.messages);
        setHasMore(res.hasMore);
        setOldestAt(res.nextCursor);
        // Project-scoped responses populate `terminalEntries`; other
        // surfaces leave it undefined. Merge instead of replacing: the
        // terminal SSE can append a command while this initial disk read is
        // still in flight, and an older snapshot must not erase that live row
        // when it finally resolves.
        setTerminalEntries((liveEntries) => mergeTerminalEntries(res.terminalEntries, liveEntries));
        // Re-seed thinking-dots for sessions already mid-turn. The
        // accumulated partial text usually comes back on its own — the
        // service bus replays in-flight history to fresh SSE
        // connections, and the shared fan-out replays its cached
        // envelopes to late subscribers — but a turn that has produced
        // no replayable events yet (silent thinking, cold start) would
        // otherwise leave the user staring at their own message with no
        // indication the model's still working.
        try {
          const inflight = await api.listInflightTurns({
            ...(inflightProjectId !== undefined ? { projectId: inflightProjectId } : {}),
            ...(inflightGezelId !== undefined ? { gezelId: inflightGezelId } : {}),
          });
          if (cancelled) return;
          for (const entry of inflight.inflight) {
            if (liveRef.current.has(entry.sessionId)) continue;
            // Same allowlist as the envelope guard — otherwise a turn
            // running in an unrelated session would seed a thinking-dots
            // bubble into a task-scoped timeline on every mount.
            if (scopedSessionIdsRef.current && !scopedSessionIdsRef.current.has(entry.sessionId)) {
              continue;
            }
            const lastForSession = findLastForSession(res.messages, entry.sessionId);
            liveRef.current.set(entry.sessionId, {
              gezelId: entry.gezelId,
              projectId: entry.projectId,
              segments: [],
              startedAt: entry.startedAt,
              // Seed from the service's real last-progress signal when
              // it has one (telemetry counters), so a turn that was
              // already silent for minutes before we attached reads as
              // stalled immediately instead of "freshly started". Falls
              // back to startedAt for daemons without telemetry.
              lastActivityAt:
                entry.lastProgressAgoMs != null
                  ? Date.now() - entry.lastProgressAgoMs
                  : entry.startedAt,
              hasProgress: entry.lastProgressAgoMs != null,
              anchorAt: lastForSession ? bumpIso(lastForSession.at) : new Date().toISOString(),
              ...(lastForSession
                ? {
                    sessionTitle: lastForSession.sessionTitle,
                    sessionCreatedAt: lastForSession.sessionCreatedAt,
                    sessionProviderName: lastForSession.sessionProviderName,
                    ...(lastForSession.sessionModel
                      ? { sessionModel: lastForSession.sessionModel }
                      : {}),
                    ...(lastForSession.taskRef ? { taskRef: lastForSession.taskRef } : {}),
                  }
                : {}),
            });
          }
          if (inflight.inflight.length > 0) setLiveBump((n) => n + 1);
        } catch {
          /* non-fatal — the thinking bubble just won't reappear, actual
             stream events still arrive via SSE */
        }
        // Seed ghost bubbles for any sessions that currently have
        // queued messages. Without this, a user reloading a page
        // while their own message is queued would see nothing until
        // the queue drained — then the bubble would pop in, read as
        // a delay rather than a pending state.
        try {
          const q = await api.getQueueStatus();
          if (cancelled) return;
          for (const sess of q.sessions) {
            if (scopedSessionIdsRef.current && !scopedSessionIdsRef.current.has(sess.sessionId)) {
              continue;
            }
            queuedRef.current.set(
              sess.sessionId,
              sess.entries.map((e) => ({
                id: e.queueId,
                preview: e.preview,
                enqueuedAt: e.enqueuedAt,
                ...(e.nudge ? { nudge: true } : {}),
              })),
            );
          }
          if (q.sessions.length > 0) setLiveBump((n) => n + 1);
        } catch {
          /* non-fatal */
        }
        // Close the initial snapshot → SSE subscription race. A turn can
        // finish after the first disk read but before this component's stream
        // is attached; in that window it is absent from both `inflight` and
        // the stream replay. A trailing canonical read makes the handoff
        // lossless without requiring the user to switch tabs to remount us.
        try {
          const latest = await loadTimeline({ limit: PAGE_SIZE });
          if (cancelled) return;
          setMessages((current) => mergeTimelineMessages(current, latest.messages));
          setTerminalEntries((liveEntries) =>
            mergeTerminalEntries(latest.terminalEntries, liveEntries),
          );
        } catch {
          /* non-fatal — live SSE remains connected */
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey, loadTimeline, inflightProjectId, inflightGezelId]);

  // Default provider — used to resolve each gezel's effective provider
  // (gezel frontmatter override wins; config default is the fallback).
  // Drives provider-specific banner copy on the StreamingBubble; the
  // "slow local models" text and the "Check Ollama" probe only belong
  // on Ollama sessions. Refetched after a config change since that's
  // also when `resetClient()` fires and existing sessions rebuild.
  const [defaultProvider, setDefaultProvider] = useState<ProviderName>('copilot');
  const [defaultModelByProvider, setDefaultModelByProvider] = useState<
    Partial<Record<ProviderName, string>>
  >({});
  const [debugMode, setDebugMode] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.getConfig();
        if (cancelled) return;
        setDefaultProvider(cfg.provider);
        setDefaultModelByProvider(cfg.defaultModel ?? {});
        setDebugMode(cfg.debugMode === true);
      } catch {
        /* non-fatal — keep the copilot fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const synthesizeUserTimelineMessage = useCallback(
    (
      baseMessages: TimelineMessage[],
      input: OptimisticUserMessage & { from?: { gezelId: string; gezelName: string } },
      optimistic = false,
    ): OptimisticTimelineMessage => {
      const lastForSession = findLastForSession(baseMessages, input.sessionId);
      return {
        sessionId: input.sessionId,
        gezelId: input.gezelId,
        projectId: input.projectId,
        sessionTitle:
          lastForSession?.sessionTitle ?? (input.content.slice(0, 60).trim() || 'New thread'),
        sessionCreatedAt: lastForSession?.sessionCreatedAt ?? input.at,
        sessionLastActivityAt: input.at,
        sessionProviderName: lastForSession?.sessionProviderName ?? defaultProvider,
        ...(lastForSession?.sessionModel ? { sessionModel: lastForSession.sessionModel } : {}),
        ...(lastForSession?.taskRef ? { taskRef: lastForSession.taskRef } : {}),
        ...(lastForSession?.stepId ? { stepId: lastForSession.stepId } : {}),
        role: 'user',
        content: input.content,
        at: input.at,
        ...(input.from ? { from: input.from } : {}),
        ...(optimistic ? { optimistic: true as const } : {}),
      };
    },
    [defaultProvider],
  );
  const providerForGezel = useCallback(
    (gezelId: string): ProviderName => gezels.get(gezelId)?.provider ?? defaultProvider,
    [gezels, defaultProvider],
  );
  // Native-title tooltip for assistant bubbles — hover the author name
  // to see which provider + model this session actually dispatches to.
  // Picks up drift between the user's default and a session that got
  // pinned before they changed it (sessions record their provider at
  // creation time; existing sessions keep theirs even if the default
  // flips).
  const tooltipForGezel = useCallback(
    (gezelId: string): string => {
      const gezel = gezels.get(gezelId);
      const provider = providerForGezel(gezelId);
      const model = gezel?.model;
      return model
        ? `Provider: ${formatProviderLabel(provider)} (${model})`
        : `Provider: ${formatProviderLabel(provider)}`;
    },
    [gezels, providerForGezel],
  );
  // Drift label — only set when this bubble's session is pinned to a
  // provider (or, within the same provider, a different model) than
  // the user's current global default. Returns undefined when the
  // session matches the default; the caller omits the pill in that
  // case. The goal is "presence-of-pill = something surprising" —
  // showing it everywhere would be noise.
  const driftLabelFor = useCallback(
    (sessionProvider: ProviderName, sessionModel: string | undefined): string | undefined => {
      const defaultModel = defaultModelByProvider[defaultProvider];
      const isLocal = LOCAL_PROVIDERS.has(sessionProvider);
      if (sessionProvider !== defaultProvider) {
        // Surface provider drift, but for on-device providers omit the
        // (long, opaque) model id — the model is shown on name-hover.
        return sessionModel && !isLocal
          ? `${formatProviderLabel(sessionProvider)} · ${sessionModel}`
          : formatProviderLabel(sessionProvider);
      }
      // Same provider — only drift when both sides have explicit
      // models and they disagree. No-model-vs-default-model isn't
      // drift in a user-visible sense: the session would dispatch
      // to the same model at turn time. On-device models never show a
      // model pill here (hover the author name to see the model).
      if (!isLocal && sessionModel && defaultModel && sessionModel !== defaultModel) {
        return sessionModel;
      }
      return undefined;
    },
    [defaultProvider, defaultModelByProvider],
  );

  // Gezel roster — used for icons + names per message + per session header.
  const refetchGezelsRef = useRef<Promise<void> | null>(null);
  const refetchGezels = useCallback(() => {
    if (refetchGezelsRef.current) return refetchGezelsRef.current;
    const p = (async () => {
      try {
        const res = await api.listGezels();
        const m = new Map<string, GezelSummary>();
        for (const g of res.gezels) m.set(g.id, g);
        setGezels(m);
      } catch {
        /* non-fatal */
      } finally {
        refetchGezelsRef.current = null;
      }
    })();
    refetchGezelsRef.current = p;
    return p;
  }, []);
  useEffect(() => {
    void refetchGezels();
  }, [refetchGezels]);

  // Keep cached gezels live so identity changes made elsewhere (font,
  // name, model, icon) reflect in already-rendered bubbles without a
  // remount. GezelDetail / GezellenView broadcast the full updated gezel,
  // so merge it straight in — no extra round-trip needed.
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent<GezelSummary>).detail;
      if (!detail?.id) return;
      setGezels((prev) => {
        const next = new Map(prev);
        next.set(detail.id, { ...next.get(detail.id), ...detail });
        return next;
      });
    };
    window.addEventListener('gezel:gezel-updated', onUpdated);
    return () => window.removeEventListener('gezel:gezel-updated', onUpdated);
  }, []);

  // Project list — only loaded when we need to label cross-project rows
  // (the global Meester surface). Cheap one-shot.
  useEffect(() => {
    if (!showProjectName) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listProjects();
        if (cancelled) return;
        const m = new Map<string, Project>();
        for (const p of res.projects) m.set(p.id, p);
        setProjects(m);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showProjectName]);

  // Build the question lookup. We always pull *all* questions (pending +
  // answered) so message-attached cards can collapse to their answered
  // form when the user re-loads the timeline. SSE refreshes the same
  // map below.
  const refreshQuestions = useCallback(async () => {
    try {
      // Pull pending across every project AND a per-project full list
      // for the few projects that actually have any. The pending-only
      // global call is cheap; the per-project full lists fold answered
      // entries in only when there's a corresponding pendingQuestionId
      // referenced from the timeline messages.
      const pendingRes = await api.listQuestions({ pending: true });
      setQuestionsById((prev) => {
        const next = new Map(prev);
        // First, drop pending entries that are no longer pending —
        // they'll be re-added below if still present.
        for (const [id, q] of next) {
          if (!q.answer) next.delete(id);
        }
        for (const q of pendingRes.questions) next.set(q.id, q);
        return next;
      });
    } catch {
      /* non-fatal — bubble cards just won't render */
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset/reload trigger.
  useEffect(() => {
    void refreshQuestions();
  }, [scopeKey, refreshQuestions]);

  // Live SSE — open one connection per scope, abort on scope change /
  // unmount. Updates `liveRef` directly, then bumps a counter to redraw.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset/reload trigger; handleEnvelope is deliberately excluded (captured via refs).
  useEffect(() => {
    const ctrl = new AbortController();
    let stopped = false;
    // Reconnect-with-backoff loop. Two separate failure modes the
    // SSE consumer has to survive:
    //   1. The fetch/network errors out (server restart, transient
    //      blip). The promise rejects with something non-Abort.
    //   2. The socket dies silently — `reader.read()` blocks forever
    //      while events queue up server-side. The new
    //      `SseStreamStaleError` (thrown after `keepaliveTimeoutMs`
    //      with no bytes from the server) catches this case.
    // Either way we tear down + reconnect. The bus's
    // replay-on-subscribe means events that fired during the gap are
    // re-delivered, so the streaming bubble's partial text + tools
    // catch up automatically.
    let backoffMs = 250;
    void (async () => {
      while (!stopped) {
        try {
          // streamProjectChatEvents and streamAllChatEvents share the
          // same envelope shape; the parent's `streamUrl()` decides
          // which scope we connect to.
          const opts: SseStreamOptions = {
            url: streamUrl(),
            headers: api.authHeader(),
            signal: ctrl.signal,
            fetch: api.getFetch(),
          };
          for await (const env of streamSharedProjectChatEvents(opts)) {
            if (stopped) return;
            handleEnvelope(env);
            backoffMs = 250; // Reset backoff on any successful frame.
          }
          // Stream ended cleanly (rare for project-scoped — these are
          // forever-streams). Loop and reconnect.
        } catch (err) {
          if (stopped) return;
          if ((err as Error).name === 'AbortError') return;
          console.warn(
            `[ChatTimelineView] envelope stream error (reconnecting in ${backoffMs}ms):`,
            err,
          );
        }
        if (stopped) return;
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    })();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [scopeKey, streamUrl]);

  // Per-project terminal SSE — separate channel from the chat envelope
  // stream because the terminal envelope shape ({ threadId, workingDir,
  // message }) doesn't carry sessionId/gezelId. Only opens when the
  // caller supplied `terminalStreamUrl`; global / per-gezel timelines
  // skip this effect entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey is the reset/reload trigger.
  useEffect(() => {
    if (!terminalStreamUrl) return;
    const ctrl = new AbortController();
    let stopped = false;
    let backoffMs = 250;
    void (async () => {
      // Lazily import so non-project surfaces don't pay the SSE-helper
      // bundle cost.
      const { streamTerminalEvents } = await import('@bendyline/gezel-client');
      while (!stopped) {
        try {
          for await (const env of streamTerminalEvents({
            url: terminalStreamUrl(),
            headers: api.authHeader(),
            signal: ctrl.signal,
            fetch: api.getFetch(),
          })) {
            if (stopped) return;
            // Envelope is a discriminated union:
            //   - `message`      → persisted row appended to the timeline
            //   - `runStarted`   → mounts a live "growing" output slot
            //   - `outputChunk`  → grows the slot's content
            //   - `workingDirChanged` → updates the parent's folder picker
            if (env.kind === 'workingDirChanged') {
              onTerminalWorkingDirChanged?.(env.threadId, env.newWorkingDir);
              backoffMs = 250;
              continue;
            }
            if (env.kind === 'openFile') {
              onWorkspaceReference?.(env.path, env.projectId);
              backoffMs = 250;
              continue;
            }
            if (env.kind === 'runStarted') {
              terminalLiveRef.current.set(env.runId, {
                projectId: env.projectId,
                threadId: env.threadId,
                commandMessageId: env.commandMessageId,
                startedAt: env.at,
                cwd: env.cwd,
                content: '',
              });
              setTerminalLiveBump((n) => n + 1);
              backoffMs = 250;
              continue;
            }
            if (env.kind === 'outputChunk') {
              const slot = terminalLiveRef.current.get(env.runId);
              if (slot) {
                slot.content += env.chunk;
                // Any output implies the prompt (if any) has been
                // answered — drop the reply UI so it doesn't sit
                // stale.
                if (slot.awaitingInput) delete slot.awaitingInput;
                setTerminalLiveBump((n) => n + 1);
              }
              backoffMs = 250;
              continue;
            }
            if (env.kind === 'inputRequested') {
              const slot = terminalLiveRef.current.get(env.runId);
              if (slot) {
                slot.awaitingInput = { promptLine: env.promptLine, mode: env.mode };
                setTerminalLiveBump((n) => n + 1);
              }
              backoffMs = 250;
              continue;
            }
            // env.kind === 'message': also release the matching
            // live slot if this message terminates a run.
            if (env.runId) {
              terminalLiveRef.current.delete(env.runId);
              setTerminalLiveBump((n) => n + 1);
            }
            setTerminalEntries((prev) => {
              // Dedupe by messageId so SSE replay after a reconnect
              // doesn't double up rows.
              if (prev.some((e) => e.messageId === env.message.id)) return prev;
              const entry: TerminalTimelineEntry = {
                threadId: env.threadId,
                projectId: env.projectId,
                workingDir: env.workingDir,
                threadCreatedAt: env.message.at,
                threadLastActivityAt: env.message.at,
                messageId: env.message.id,
                msgKind: env.message.kind,
                content: env.message.content,
                at: env.message.at,
                ...(env.message.resolvedFrom ? { resolvedFrom: env.message.resolvedFrom } : {}),
                ...(env.message.stdout !== undefined ? { stdout: env.message.stdout } : {}),
                ...(env.message.stderr !== undefined ? { stderr: env.message.stderr } : {}),
                ...(env.message.exitCode !== undefined ? { exitCode: env.message.exitCode } : {}),
                ...(env.message.durationMs !== undefined
                  ? { durationMs: env.message.durationMs }
                  : {}),
                ...(env.message.truncated ? { truncated: true } : {}),
                ...(env.message.errorMessage ? { errorMessage: env.message.errorMessage } : {}),
                ...(env.message.fileReferences
                  ? { fileReferences: env.message.fileReferences }
                  : {}),
                ...(env.message.cwd !== undefined ? { cwd: env.message.cwd } : {}),
              };
              const next = [...prev, entry];
              next.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
              return next;
            });
            backoffMs = 250;
          }
        } catch (err) {
          if (stopped) return;
          if ((err as Error).name === 'AbortError') return;
          console.warn(
            `[ChatTimelineView] terminal stream error (reconnecting in ${backoffMs}ms):`,
            err,
          );
        }
        if (stopped) return;
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    })();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [scopeKey, terminalStreamUrl, onWorkspaceReference]);

  // Reconcile after an acknowledged terminal submission. The service
  // persists the command before returning 202, so this snapshot is the
  // canonical fallback when an otherwise-healthy SSE connection drops a
  // frame under load. Merge by message id to keep the live path flicker-free.
  useEffect(() => {
    if (!terminalRefreshKey) return;
    let cancelled = false;
    void loadTimeline({ limit: PAGE_SIZE })
      .then((res) => {
        if (cancelled) return;
        setTerminalEntries((liveEntries) => mergeTerminalEntries(res.terminalEntries, liveEntries));
      })
      .catch(() => {
        // Non-fatal: the SSE stream remains the primary delivery path.
      });
    return () => {
      cancelled = true;
    };
  }, [terminalRefreshKey, loadTimeline]);

  // A terminal submission can arrive after its SSE command row (the service
  // persists and broadcasts before the POST resolves) or before the fallback
  // snapshot above. Recording the intent independently lets the alignment
  // effect below handle both orderings and retry when rows change.
  useEffect(() => {
    if (!terminalSubmission) return;
    setSubmissionAnchor({
      kind: 'terminal',
      key: `terminal:${terminalSubmission.runId}`,
      runId: terminalSubmission.runId,
      threadId: terminalSubmission.threadId,
      input: terminalSubmission.input,
    });
    setAlignedSubmissionKey(null);
  }, [terminalSubmission]);

  const refreshLatest = useCallback(async () => {
    try {
      const res = await loadTimeline({ limit: PAGE_SIZE });
      // The server returned the most-recent slice. Keep older pages already
      // loaded while merging in the new durable rows.
      setMessages((prev) => mergeTimelineMessages(prev, res.messages));
    } catch {
      /* non-fatal — the SSE complete event already updated the live state */
    }
  }, [loadTimeline]);

  // SSE remains the low-latency path, but a dropped `done` envelope must
  // not leave a permanent thinking/stalled bubble. Reconcile the local
  // slots against the service's authoritative in-flight set.
  useEffect(() => {
    let stopped = false;
    let checking = false;
    const reconcile = async () => {
      if (checking || liveRef.current.size === 0) return;
      checking = true;
      const observed = new Map(liveRef.current);
      try {
        const response = await api.listInflightTurns({
          ...(inflightProjectId !== undefined ? { projectId: inflightProjectId } : {}),
          ...(inflightGezelId !== undefined ? { gezelId: inflightGezelId } : {}),
        });
        if (stopped) return;
        const active = new Set(response.inflight.map((entry) => entry.sessionId));
        const stale = staleLiveSessionIds(liveRef.current, observed, active);
        if (stale.length === 0) return;
        for (const sessionId of stale) {
          liveRef.current.delete(sessionId);
          pendingNarrationRef.current.delete(sessionId);
        }
        setLiveBump((n) => n + 1);
        void refreshLatest();
      } catch {
        // Non-fatal. A later poll or the normal `done` event will converge.
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => {
      void reconcile();
    }, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [inflightProjectId, inflightGezelId, refreshLatest]);

  useEffect(() => {
    return subscribeOptimisticUserMessages((message) => {
      if (inflightProjectId !== undefined && message.projectId !== inflightProjectId) return;
      if (inflightGezelId !== undefined && message.gezelId !== inflightGezelId) return;
      // The composer publishes this only after `sendToChatSession`
      // resolves, so a session it just created has long since reached
      // the allowlist via `onSessionCreated`.
      if (scopedSessionIdsRef.current && !scopedSessionIdsRef.current.has(message.sessionId))
        return;
      const sentAtMs = Date.parse(message.at);
      setMessages((prev) => {
        const alreadyPresent = prev.some((m) => {
          if (m.sessionId !== message.sessionId || m.role !== 'user') return false;
          if (m.content !== message.content) return false;
          const atMs = Date.parse(m.at);
          return Number.isFinite(sentAtMs) && Number.isFinite(atMs)
            ? Math.abs(atMs - sentAtMs) < 2 * 60_000
            : true;
        });
        if (alreadyPresent) return prev;
        const next = [...prev, synthesizeUserTimelineMessage(prev, message, true)];
        next.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        return next;
      });
      if (!liveRef.current.has(message.sessionId)) {
        const lastForSession = findLastForSession(messagesRef.current, message.sessionId);
        const slotStart = Number.isFinite(sentAtMs) ? sentAtMs : Date.now();
        liveRef.current.set(message.sessionId, {
          gezelId: message.gezelId,
          projectId: message.projectId,
          segments: [],
          startedAt: slotStart,
          lastActivityAt: slotStart,
          hasProgress: false,
          anchorAt: bumpIso(message.at),
          ...(lastForSession
            ? { sessionTitle: lastForSession.sessionTitle }
            : { sessionTitle: message.content.slice(0, 60).trim() || 'New thread' }),
          ...(lastForSession
            ? { sessionCreatedAt: lastForSession.sessionCreatedAt }
            : { sessionCreatedAt: message.at }),
          ...(lastForSession
            ? {
                sessionProviderName: lastForSession.sessionProviderName,
                ...(lastForSession.sessionModel
                  ? { sessionModel: lastForSession.sessionModel }
                  : {}),
              }
            : {}),
          ...(lastForSession?.taskRef ? { taskRef: lastForSession.taskRef } : {}),
          ...(lastForSession?.stepId ? { stepId: lastForSession.stepId } : {}),
        });
        setLiveBump((n) => n + 1);
      }
      // This event is published only by the local composer after the send
      // was accepted. Bring that prompt into view even if the reader had
      // intentionally unpinned the timeline while inspecting older rows.
      setSubmissionAnchor({
        kind: 'chat',
        key: `chat:${message.sessionId}:${message.at}`,
        sessionId: message.sessionId,
        content: message.content,
        at: message.at,
      });
      setAlignedSubmissionKey(null);
    });
  }, [inflightProjectId, inflightGezelId, synthesizeUserTimelineMessage]);

  const handleEnvelope = useCallback(
    (env: ChatEventEnvelope) => {
      const { sessionId, gezelId, projectId, event } = env;
      // Drop envelopes outside the configured scope. The SSE stream the
      // parent picks is the *coarser* of the two filters (project, gezel,
      // or global) — when both filters apply (e.g. per-gezel tab pinned
      // to a project), we still need to discard the cross-project events
      // the per-gezel stream would deliver. handleEnvelope is the one
      // place every event flows through, so guarding here covers replay,
      // live, and any future delivery path.
      if (inflightProjectId !== undefined && projectId !== inflightProjectId) return;
      if (inflightGezelId !== undefined && gezelId !== inflightGezelId) return;
      // Session allowlist (task-scoped surfaces). An unknown session is
      // reported up so the owner can refetch — a handoff session created
      // mid-turn is legitimately in scope and just isn't in the set yet.
      // We still drop *this* event: letting it through would leak the
      // unrelated-session case the allowlist exists to prevent. The
      // refetch lands within a round-trip and `refreshLatest` reconciles
      // anything the gap swallowed.
      const allowlist = scopedSessionIdsRef.current;
      if (allowlist && !allowlist.has(sessionId)) {
        onUnknownSessionRef.current?.(sessionId);
        return;
      }
      // If a live event mentions a gezel we haven't seen (newly created
      // mid-session by the Meester, etc.), refetch the roster so the
      // bubble author label and session divider resolve to a real name
      // instead of the generic "Gezel" fallback.
      if (!gezels.has(gezelId)) void refetchGezels();
      if (event.type === 'user_message') {
        // Stop in-flight narration only when this is a real human send
        // (no `from` field). Inter-gezel handoffs (Meester delegating
        // to a voorman via `message_gezel`) also surface as user_message
        // events with `from` set — those are the natural flow continuing,
        // not the user moving on, so we let the previous gezel finish
        // reading their reply before the next one takes over.
        // A `hidden` seed (a project-type page reaction with `hideSeed`,
        // e.g. checkers' "[Checkers page]: …") is machine facilitation: it
        // must not interrupt the user's narration, nor render a bubble. We
        // still fall through to the eager-slot logic below so the gezel's
        // reply (its move + table talk) streams immediately.
        if (!event.message.hidden && !event.message.from) {
          stopNarration(narrationAudioRef, narrationAbortRef);
          // Drop any buffered narration for this session — a fresh send
          // means whatever was queued from the prior chain is stale.
          pendingNarrationRef.current.delete(sessionId);
        }
        // Insert the user's message immediately so the bubble appears
        // before the assistant starts streaming. Brand-new sessions
        // don't have full metadata loaded yet — synthesize best-effort
        // fields; the post-`complete` refreshLatest() overwrites them
        // with the canonical row from disk.
        const lastForSession = findLastForSession(messages, sessionId);
        const synthesized: TimelineMessage = {
          sessionId,
          gezelId,
          projectId,
          sessionTitle:
            lastForSession?.sessionTitle ??
            (event.message.content.slice(0, 60).trim() || 'New thread'),
          sessionCreatedAt: lastForSession?.sessionCreatedAt ?? event.message.at,
          sessionLastActivityAt: event.message.at,
          // For a brand-new session with no loaded messages, we don't
          // yet know the pinned provider; fall back to the current
          // default, which is what the session would have been created
          // with at this moment. The canonical row from the post-
          // `complete` refresh overwrites this.
          sessionProviderName: lastForSession?.sessionProviderName ?? defaultProvider,
          ...(lastForSession?.sessionModel ? { sessionModel: lastForSession.sessionModel } : {}),
          ...(lastForSession?.taskRef ? { taskRef: lastForSession.taskRef } : {}),
          ...(lastForSession?.stepId ? { stepId: lastForSession.stepId } : {}),
          role: event.message.role,
          content: event.message.content,
          at: event.message.at,
          // Preserve the cross-gezel `from` sentinel so the live bubble
          // renders as a "Yusuf → Leo" handoff instead of "You".
          ...(event.message.from ? { from: event.message.from } : {}),
          ...(event.message.nudge ? { nudge: true } : {}),
        };
        const dedupKey = `${sessionId}:${event.message.at}:${event.message.role}`;
        setMessages((prev) => {
          // Hidden facilitation seeds never get a bubble — leave the
          // transcript untouched (there's no optimistic row to reconcile,
          // the user didn't type it).
          if (event.message.hidden) return prev;
          const withoutOptimistic = prev.filter((m) => {
            if (!(m as OptimisticTimelineMessage).optimistic) return true;
            return !(
              m.sessionId === sessionId &&
              m.role === event.message.role &&
              m.content === event.message.content
            );
          });
          if (withoutOptimistic.some((m) => `${m.sessionId}:${m.at}:${m.role}` === dedupKey)) {
            return withoutOptimistic;
          }
          const next = [...withoutOptimistic, synthesized];
          next.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
          return next;
        });
        // Eagerly open a live slot on user_message so the StreamingBubble
        // renders its "thinking" state immediately. Otherwise slow first
        // tokens (Ollama cold-starts, big-model warm-ups) leave the user
        // staring at their own message for 10+ seconds with no signal
        // that anything is happening. Anchored right after the user's
        // message so the bubble sorts below it — we can't rely on
        // `createSlot` here because `setMessages` is still pending and
        // `findLastForSession(messages, …)` would miss the just-added row.
        if (event.message.role === 'user') {
          // A stale errored slot (preserved so the user could read why
          // the previous turn failed) is implicitly acknowledged by
          // sending a new message — clear it before seeding the
          // thinking-dots slot for this turn.
          const existing = liveRef.current.get(sessionId);
          if (existing?.error) liveRef.current.delete(sessionId);
        }
        if (event.message.role === 'user' && !liveRef.current.has(sessionId)) {
          // Use the user message's wall-clock `at` instead of `Date.now()`
          // so a replayed user_message event (e.g. after a tab-away
          // scope reset that cleared liveRef and triggered SSE
          // re-subscribe) seeds the slot with the *original* turn
          // start, not the moment we re-attached. Otherwise the
          // "thinking · :NN" timer resets every time the user
          // navigates away and back during a long turn.
          const parsedAt = Date.parse(event.message.at);
          const slotStart = Number.isFinite(parsedAt) ? parsedAt : Date.now();
          liveRef.current.set(sessionId, {
            gezelId,
            projectId,
            segments: [],
            startedAt: slotStart,
            lastActivityAt: slotStart,
            hasProgress: false,
            anchorAt: bumpIso(event.message.at),
            ...(lastForSession
              ? { sessionTitle: lastForSession.sessionTitle }
              : { sessionTitle: synthesized.sessionTitle }),
            ...(lastForSession
              ? { sessionCreatedAt: lastForSession.sessionCreatedAt }
              : { sessionCreatedAt: synthesized.sessionCreatedAt }),
            ...(lastForSession
              ? {
                  sessionProviderName: lastForSession.sessionProviderName,
                  ...(lastForSession.sessionModel
                    ? { sessionModel: lastForSession.sessionModel }
                    : {}),
                }
              : {}),
            ...(lastForSession?.taskRef ? { taskRef: lastForSession.taskRef } : {}),
          });
          setLiveBump((n) => n + 1);
        }
      } else if (event.type === 'delta') {
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        // Append-or-extend the trailing text segment so the model's
        // token stream collapses into one contiguous markdown block
        // between any two tool boundaries — UNLESS more than
        // `TEXT_BREAK_GAP_MS` has elapsed since the last activity,
        // in which case start a fresh text segment. Long thinking
        // pauses (reasoning models, looping models that produce
        // bursts of repetitive output) get visible paragraph
        // breaks instead of one wall-of-text.
        const TEXT_BREAK_GAP_MS = 5000;
        const tail = slot.segments[slot.segments.length - 1];
        const now = Date.now();
        const recentEnough = now - slot.lastActivityAt < TEXT_BREAK_GAP_MS;
        if (tail?.kind === 'text' && recentEnough) {
          tail.content += event.content;
        } else {
          slot.segments.push({ kind: 'text', content: event.content });
        }
        slot.lastActivityAt = now;
        slot.hasProgress = true;
        // First delta means the provider actually started this turn —
        // drop the "queued" indicator if we had one. Also resets
        // the wire-pulse dot accumulator since we just got real
        // visible activity. Clear the heartbeat label too: once tokens
        // are flowing, the "thinking" phase is over; keeping a stale
        // label would make the status line read "thinking…" while the
        // model is actively producing output.
        delete slot.queueAhead;
        slot.wirePulseCount = 0;
        slot.thinkingLabel = undefined;
        delete slot.thinkingProgress;
        delete slot.thinkingDetail;
        // Visible text resumed — whatever structured call was streaming
        // is over (or was abandoned); drop the live tool-args block.
        delete slot.liveToolArgs;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'reasoning_delta') {
        // Live think-phase tokens (ds4's `reasoning_content` channel).
        // Accumulate into a dimmed "thinking" block rendered above the
        // reply; it collapses into the committed message's reasoning
        // expander once the turn ends and this slot is replaced. Counts as
        // real activity — resets the silence timer and clears the
        // wire-pulse dots, so a streaming think never reads as a stall.
        // `thinkingProgress` (the prefill bar) is definitively done once
        // reasoning tokens flow; drop it. `thinkingLabel` stays — the
        // status line still honestly reads "thinking…".
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.liveReasoning = (slot.liveReasoning ?? '') + event.content;
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        delete slot.queueAhead;
        slot.wirePulseCount = 0;
        delete slot.thinkingProgress;
        delete slot.thinkingDetail;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'tool_args_delta') {
        // Live tool-argument fragments — the model is generating a
        // structured tool call (typically write_file content). Counts as
        // real activity: resets the silence timer so a multi-minute
        // write never trips the "looks stalled" banner. The wire-pulse
        // counter deliberately KEEPS ticking (the provider pulses on the
        // same chunks) — it stays the "things are happening" numerator
        // shown next to the caret. Tail is capped so a 100k-char write
        // doesn't grow the slot unbounded; the running char total keeps
        // the full magnitude visible.
        const TOOL_ARGS_TAIL_CAP = 2000;
        // Head keeps the opening of the args JSON so the bubble can pull
        // out a `"path": …` even after the tail has scrolled past it.
        const TOOL_ARGS_HEAD_CAP = 400;
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        const prev = slot.liveToolArgs;
        const name = event.name.length > 0 ? event.name : (prev?.name ?? '');
        const head = ((prev?.head ?? '') + event.content).slice(0, TOOL_ARGS_HEAD_CAP);
        const tail = ((prev?.tail ?? '') + event.content).slice(-TOOL_ARGS_TAIL_CAP);
        slot.liveToolArgs = {
          name,
          chars: (prev?.chars ?? 0) + event.content.length,
          head,
          tail,
        };
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        delete slot.queueAhead;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'wire_pulse') {
        // Bare framing chunk arrived from the provider — Ollama is
        // alive on the wire but the model isn't producing visible
        // output. Surface as accumulating dots in the streaming
        // bubble so the user can distinguish "Ollama is hung" from
        // "the model is silently thinking." Reset to 0 on real
        // delta / tool / complete (above + below). Wire pulses only
        // come from a provider that's actually processing the turn,
        // so the queue-wait is over — drop any stale `queueAhead`.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.wirePulseCount = (slot.wirePulseCount ?? 0) + 1;
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        delete slot.queueAhead;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'intent') {
        // Copilot announced a phase transition via `report_intent`.
        // Push it as its own segment so the streaming bubble renders
        // an HR divider right here; completed-message rendering pulls
        // the same label out of `ChatMessage.intents` and re-splices
        // at its saved offset. Same activity-reset semantics as deltas
        // — counts as progress, so it clears wire-pulse dots and
        // bumps the activity clock.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.segments.push({ kind: 'intent', label: event.label });
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        slot.wirePulseCount = 0;
        delete slot.queueAhead;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'heartbeat') {
        // Provider told us it's still working — bump the activity
        // clock so the "silent for Xs" banner doesn't climb during
        // legitimate server-side reasoning phases. Also clears the
        // wire-pulse dots (wire pulses and heartbeats express the
        // same "still alive" signal; showing both at once would be
        // noise). Optional `label` surfaces through `thinkingLabel`
        // so the status line can read "thinking…" during Copilot
        // reasoning stretches.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        slot.wirePulseCount = 0;
        slot.thinkingLabel = event.label;
        delete slot.queueAhead;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'warning') {
        // Provider-side warning (rate-limit, degraded mode, etc.) —
        // append to the slot's warnings list so the streaming bubble
        // renders it inline. Not an activity signal on its own (the
        // model isn't making progress just because the SDK raised a
        // warning), so we don't touch lastActivityAt.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.warnings = [...(slot.warnings ?? []), event];
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'queued') {
        // The service only fires `queued` after a >200ms wait, so we
        // can flip the bubble to the queued state immediately without
        // debouncing. Cleared on first delta or on done.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.queueAhead = event.aheadOf;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'queue_enqueued') {
        // Upsert by queueId: a fresh enqueue appends, but a
        // coalesced send re-publishes with the SAME queueId and an
        // updated (longer) preview — update-in-place rather than
        // rendering a duplicate ghost bubble.
        const list = queuedRef.current.get(sessionId) ?? [];
        const entry = {
          id: event.queueId,
          preview: event.preview,
          enqueuedAt: event.enqueuedAt,
          ...(event.nudge ? { nudge: true } : {}),
        };
        const existing = list.findIndex((e) => e.id === event.queueId);
        if (existing >= 0) {
          list[existing] = entry;
        } else {
          list.push(entry);
        }
        queuedRef.current.set(sessionId, list);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'queue_removed') {
        const list = queuedRef.current.get(sessionId);
        if (list) {
          const next = list.filter((e) => e.id !== event.queueId);
          if (next.length === 0) queuedRef.current.delete(sessionId);
          else queuedRef.current.set(sessionId, next);
          setLiveBump((n) => n + 1);
        }
      } else if (event.type === 'tool') {
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        const tool: ToolActivity = {
          name: event.name,
          durationMs: event.durationMs,
          success: event.success,
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          ...(event.path ? { path: event.path } : {}),
          ...(event.argsSummary ? { argsSummary: event.argsSummary } : {}),
          ...(event.argsFull ? { argsFull: event.argsFull } : {}),
          ...(event.resultText ? { resultText: event.resultText } : {}),
          ...(event.resultTruncated ? { resultTruncated: true } : {}),
          ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
          ...(event.diff !== undefined ? { diff: event.diff } : {}),
          ...(event.addedLines !== undefined ? { addedLines: event.addedLines } : {}),
          ...(event.removedLines !== undefined ? { removedLines: event.removedLines } : {}),
          // Tag with the envelope's project so the References pane can
          // resolve the path against the right project on cross-project
          // surfaces (Meester global timeline).
          projectId,
        };
        // Push the tool as its own segment — interleaves it with the
        // surrounding prose in the bubble, and preserves arrival
        // order so the user reads "wrote X · then read Y · then
        // continues writing" instead of all tools stacked at the top.
        slot.segments.push({ kind: 'tool', tool });
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        slot.wirePulseCount = 0;
        // The finished tool row supersedes the live tool-args block.
        delete slot.liveToolArgs;
        // A tool call means the provider picked the turn up off the
        // queue and is actively working — drop any stale `queueAhead`
        // so the bubble stops reading "QUEUED — N AHEAD" after a
        // de-queue without a preceding `delta`. (Tool-first turns are
        // normal for agentic models.)
        delete slot.queueAhead;
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
        onToolActivity?.(tool);
      } else if (event.type === 'complete') {
        // `complete` fires per iteration of the manager's
        // continuation loop, not per user-facing turn. The actual
        // end-of-work signal is `done`. Deleting the slot here
        // (the old behavior) makes the bubble vanish during the
        // gap between iterations — prompt prefill on the next
        // sendAndWait can be 30-90s on a long Ollama context, plus
        // any in-flight compaction one-shot. The user sees Leo
        // "running" in the QueueMeter with no thinking indicator
        // in chat.
        //
        // Instead, KEEP the slot but reset its accumulator so the
        // bubble drops back to thinking-dots while we wait for the
        // next iteration's first delta/tool. The completed message
        // lands as a regular timeline row via `refreshLatest`; the
        // re-cleared slot sorts after it (we bump `anchorAt` to
        // just past the new message's `at`). `done` is the only
        // event that actually retires the slot.
        //
        // PRESERVE `startedAt` — it's the wall-clock since the
        // user's send started, not since the most recent iteration.
        // Resetting it per-complete made the elapsed counter
        // restart each iteration (and got clobbered to ~0 every
        // time the bus replayed a historical `complete` after the
        // user tabbed back into the chat). `lastActivityAt` still
        // resets — that one tracks "time since the last delta /
        // tool" and the slow-banner depends on it ticking from the
        // start of the silent stretch, not from the user's send.
        const existing = liveRef.current.get(sessionId);
        if (existing) {
          existing.segments = [];
          existing.lastActivityAt = Date.now();
          existing.hasProgress = true;
          existing.anchorAt = bumpIso(event.message.at);
          existing.wirePulseCount = 0;
          // Drop the live think-phase block: the just-committed message
          // carries this iteration's reasoning on its `reasoning` field
          // (collapsed expander). Leaving it set would double-render the
          // trace — live block + expander — until the next delta.
          delete existing.liveReasoning;
          delete existing.liveToolArgs;
          delete existing.queueAhead;
          delete existing.error;
          liveRef.current.set(sessionId, existing);
        }
        setLiveBump((n) => n + 1);
        // Refetch the most-recent slice so the completed message
        // lands as a real timeline row. Synthesizing here would
        // miss session metadata (title / createdAt) for brand-new
        // sessions; one round-trip per iteration is the same cost
        // as before this change.
        void refreshLatest();
        // Spoken narration. Opt-in via Settings → Audio → "Narrate
        // assistant replies"; reads each completed assistant message
        // aloud using the speaking gezel's per-character voice (voice
        // resolution lives in /api/audio/synthesize). Fire-and-forget
        // — failures here shouldn't disturb the chat flow.
        // Buffer the latest non-empty content; play it on `done`.
        // `complete` fires per continuation iteration — stalled-tool
        // nudges and tool-only iterations would otherwise trigger
        // narration mid-turn while llama is still grinding the next
        // 15K-token continuation prompt. Waiting for `done` decouples
        // narration from intermediate iterations and keeps the kokoro
        // ONNX run off the critical path of the LLM turn.
        const narrateLen = event.message.content.trim().length;
        console.debug(
          `[narrate] complete event — contentLen=${narrateLen} gezelId=${gezelId} projectId=${projectId} sessionId=${sessionId} (buffering for done)`,
        );
        if (narrateLen > 0) {
          pendingNarrationRef.current.set(sessionId, {
            content: event.message.content,
            gezelId,
            projectId,
          });
        }
      } else if (event.type === 'error') {
        // Preserve the streaming slot — the user was watching tokens
        // come in, and wiping the bubble on error leaves them staring at
        // a blank space wondering whether their question was heard. Tag
        // the slot as failed so the bubble can render a "stopped at
        // <n>s: <reason>" banner with the partial content intact.
        const slot = liveRef.current.get(sessionId);
        if (slot) {
          slot.error = event.error;
          slot.errorDetail = event.errorDetail;
          liveRef.current.set(sessionId, slot);
          setLiveBump((n) => n + 1);
        }
      } else if (event.type === 'cancelled') {
        // A requested stop is ordinary control flow, not a failed turn.
        // Retire the live bubble without attaching an error; the manager
        // emits this event again after it persists any salvaged partial
        // response, so the refresh below converges on the durable row.
        if (liveRef.current.delete(sessionId)) {
          setLiveBump((n) => n + 1);
        }
        void refreshLatest();
      } else if (event.type === 'done') {
        // Only retire the slot if it completed cleanly. An errored slot
        // stays visible until the next user_message replaces it.
        const slot = liveRef.current.get(sessionId);
        if (slot && !slot.error) {
          liveRef.current.delete(sessionId);
          setLiveBump((n) => n + 1);
        }
        // Drain any buffered narration for this session. We waited for
        // `done` so all continuation iterations (tool-only stall
        // recoveries etc.) have settled and llama isn't still grinding
        // a 15K-token prompt that would starve the kokoro inference.
        const pending = pendingNarrationRef.current.get(sessionId);
        if (pending) {
          pendingNarrationRef.current.delete(sessionId);
          if (narrateRef.current) {
            console.debug(
              `[narrate] done event — playing buffered narration chars=${pending.content.length} sessionId=${sessionId}`,
            );
            void playAssistantNarration(
              pending.content,
              pending.gezelId,
              pending.projectId,
              narrationAudioRef,
              narrationAbortRef,
            );
          }
        }
        // `complete` normally performs this refresh, but it is a separate SSE
        // envelope and can be the one frame lost during reconnect/backpressure.
        // `done` is the authoritative end-of-turn fallback: reconcile the
        // durable assistant row even when no live slot remains to retire.
        void refreshLatest();
      } else if (event.type === 'engine_phase') {
        // llama-cpp fires these for supervised-process lifecycle
        // (starting / loading_model — parsed from stdout) and per-
        // turn milestones (prefill / generating). Also mid-turn
        // prompt-processing progress from the stdout classifier.
        // Feed through `thinkingLabel` so the status line reads
        // "Processing prompt (15% · 2,048 tokens)" instead of a
        // bare spinner during the long silent prefill window.
        // Clearing on `ready` lets the default "thinking" come
        // back between turns once the engine is warm.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.lastActivityAt = Date.now();
        slot.hasProgress = true;
        if (event.phase === 'ready') {
          delete slot.thinkingLabel;
          delete slot.thinkingProgress;
          delete slot.thinkingDetail;
        } else {
          // When the phase event carries a `progress` value (chunked
          // prefill batches), surface the friendly base label and
          // tuck the verbose "X / Y tokens · Z tok/s" detail into a
          // tooltip on the progress bar. Without progress, fall back
          // to the original "detail verbatim" rendering used during
          // the long silent windows where progress isn't computable.
          const base = PHASE_LABELS[event.phase];
          if (event.progress !== undefined) {
            slot.thinkingLabel = base;
            slot.thinkingProgress = event.progress;
            if (event.detail) slot.thinkingDetail = event.detail;
            else delete slot.thinkingDetail;
          } else {
            slot.thinkingLabel = event.detail ?? base;
            delete slot.thinkingProgress;
            delete slot.thinkingDetail;
          }
        }
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'gpu_swap') {
        // VRAM-tenancy change: a non-LLM workload (today: local
        // image generation) has taken or released the GPU. While
        // active, the chat model is paused — surface a distinct
        // status label so the bubble stops claiming the model is
        // "thinking", and reset the silence timer so the
        // reassurance banner doesn't fire mid-render.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.lastActivityAt = Date.now();
        if (event.state === 'ended') {
          delete slot.gpuSwapTask;
          delete slot.gpuSwapDetail;
          delete slot.gpuSwapPrompt;
          delete slot.gpuSwapProgress;
          delete slot.gpuSwapStep;
          delete slot.gpuSwapTotalSteps;
          delete slot.gpuSwapSecondsPerStep;
        } else {
          // 'started' AND 'progress' both populate the slot — progress
          // events arrive once per sampling step (sd-server emits ~one
          // every 18s on a busy GPU) and refresh the prompt + bar.
          slot.gpuSwapTask = event.task;
          if (event.detail) slot.gpuSwapDetail = event.detail;
          else if (event.state === 'started') delete slot.gpuSwapDetail;
          if (event.prompt) slot.gpuSwapPrompt = event.prompt;
          if (typeof event.progress === 'number') slot.gpuSwapProgress = event.progress;
          if (typeof event.step === 'number') slot.gpuSwapStep = event.step;
          if (typeof event.totalSteps === 'number') slot.gpuSwapTotalSteps = event.totalSteps;
          if (typeof event.secondsPerStep === 'number')
            slot.gpuSwapSecondsPerStep = event.secondsPerStep;
        }
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'awaiting_gezel') {
        // This turn is parked inside a synchronous ask_gezel /
        // ask_specialist consultation — the asker's model is idle,
        // blocked on a reply from another gezel. Mirror the gpu_swap
        // pairing: 'started' marks the slot so the bubble dims and
        // shows "Waiting on <name>"; 'ended' clears it so the asker's
        // continuation turn resumes its normal thinking labels. Reset
        // the silence timer either way — the wait is expected activity,
        // not a stall, so the "still working" banner shouldn't fire.
        const slot = liveRef.current.get(sessionId) ?? createSlot(gezelId, projectId, sessionId);
        slot.lastActivityAt = Date.now();
        if (event.state === 'ended') {
          delete slot.awaitingGezelName;
        } else {
          slot.awaitingGezelName = event.targetGezelName;
        }
        liveRef.current.set(sessionId, slot);
        setLiveBump((n) => n + 1);
      } else if (event.type === 'context_warning') {
        // Don't downgrade an existing 'compacted' status to a 'warning'
        // — once the system has had to compact, that's the user-facing
        // signal that matters; a subsequent warning event below the
        // compact threshold doesn't add information.
        const existing = contextStatusRef.current.get(sessionId);
        if (existing?.kind !== 'compacted') {
          contextStatusRef.current.set(sessionId, {
            kind: 'warning',
            estimatedTokens: event.estimatedTokens,
            numCtx: event.numCtx,
            model: event.model,
            at: Date.now(),
          });
          setLiveBump((n) => n + 1);
        }
      } else if (event.type === 'context_compacted') {
        contextStatusRef.current.set(sessionId, {
          kind: 'compacted',
          model: event.model,
          removedCount: event.removedCount,
          at: Date.now(),
        });
        // Refetch the timeline — older messages were dropped from disk
        // by the compaction, so the rendered list needs to match.
        void refreshLatest();
        setLiveBump((n) => n + 1);
      } else if (event.type === 'question_asked' || event.type === 'question_answered') {
        // Update the lookup directly (cheaper than re-fetching) and
        // refresh the timeline so the new `pendingQuestionId` stamp on
        // the asking bubble lands.
        setQuestionsById((prev) => {
          const next = new Map(prev);
          if (event.type === 'question_answered' && !event.question.answer) {
            next.delete(event.question.id);
          } else {
            next.set(event.question.id, event.question);
          }
          return next;
        });
        if (event.type === 'question_asked') void refreshLatest();
      }

      function createSlot(gid: string, pid: string, sid: string): LiveSlot {
        // Anchor the streaming bubble after the most-recent message in
        // this session if we have one; otherwise mark it as "now" so it
        // sorts to the bottom of the timeline.
        const lastForSession = findLastForSession(messages, sid);
        const now = Date.now();
        return {
          gezelId: gid,
          projectId: pid,
          segments: [],
          startedAt: now,
          lastActivityAt: now,
          hasProgress: false,
          anchorAt: lastForSession ? bumpIso(lastForSession.at) : nowIso(),
          ...(lastForSession ? { sessionTitle: lastForSession.sessionTitle } : {}),
          ...(lastForSession ? { sessionCreatedAt: lastForSession.sessionCreatedAt } : {}),
          ...(lastForSession?.taskRef ? { taskRef: lastForSession.taskRef } : {}),
        };
      }
    },
    [
      messages,
      onToolActivity,
      refreshLatest,
      gezels,
      refetchGezels,
      defaultProvider,
      inflightProjectId,
      inflightGezelId,
    ],
  );

  // Build the rendered row sequence by interleaving streaming rows with
  // completed messages by their effective `at`. Re-derived whenever
  // messages change OR liveBump bumps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: liveBump + terminalLiveBump are counters that force re-derivation from the mutable refs.
  const rows = useMemo(() => {
    const liveRows: Array<{ kind: 'streaming'; sessionId: string; slot: LiveSlot }> = [];
    for (const [sid, slot] of liveRef.current.entries()) {
      liveRows.push({ kind: 'streaming', sessionId: sid, slot });
    }
    const messageRows = messages.map((m) => ({ kind: 'message' as const, msg: m, at: m.at }));
    const streamingAsRows = liveRows.map((r) => ({
      kind: 'streaming' as const,
      sessionId: r.sessionId,
      slot: r.slot,
      at: r.slot.anchorAt,
    }));
    const terminalRows = terminalEntries.map((e) => ({
      kind: 'terminal' as const,
      entry: e,
      at: e.at,
    }));
    const terminalStreamingRows: Array<{
      kind: 'terminal-streaming';
      runId: string;
      slot: TerminalLiveSlot;
      at: string;
    }> = [];
    for (const [runId, slot] of terminalLiveRef.current.entries()) {
      terminalStreamingRows.push({
        kind: 'terminal-streaming',
        runId,
        slot,
        at: slot.startedAt,
      });
    }
    const all: Array<
      | { kind: 'message'; msg: TimelineMessage; at: string }
      | { kind: 'streaming'; sessionId: string; slot: LiveSlot; at: string }
      | { kind: 'terminal'; entry: TerminalTimelineEntry; at: string }
      | { kind: 'terminal-streaming'; runId: string; slot: TerminalLiveSlot; at: string }
    > = [...messageRows, ...streamingAsRows, ...terminalRows, ...terminalStreamingRows];
    // Active chat rows stay below persisted history. Fresh terminal
    // commands and their output get the final lane for five minutes,
    // so launching a command cannot push it above the pending chat
    // task the user was already watching.
    const now = Date.now();
    all.sort((a, b) => compareTimelineRows(a, b, now));
    return all;
  }, [messages, terminalEntries, liveBump, terminalLiveBump, terminalOrderTick]);

  // Slack-style threading: fold the flat rows into turn-rooted thread
  // groups. Every user message (a human turn or a gezel→gezel handoff)
  // roots a thread; assistant replies and streaming rows attach to
  // their session's most recent root even when other sessions' rows
  // landed in between chronologically — so the continuation loop's
  // trailing status bubbles render under their real trigger instead of
  // floating above whatever message arrived next. Fan-out duplicate
  // user rows (@-mention fan-out persists the same prompt into several
  // sessions) don't render their own root; their sessions' replies
  // merge into the kept root's thread. See `timeline-threads.ts`.
  const threadItems = useMemo(() => buildTimelineThreads(rows), [rows]);

  // Auto-scroll: snapshot whether the user is near the bottom *before*
  // every render, then if so, snap to the bottom *after*. If they were
  // scrolled up reading older history, leave them where they are.
  //
  // Re-anchor when EITHER the row count grew OR the scrollHeight grew.
  // The row-count check catches new messages; the scrollHeight check
  // catches streaming deltas — a long reply makes the live bubble
  // taller without changing the row count, and without this branch the
  // user gets unmoored from the bottom mid-stream and has to scroll
  // manually to follow along. Re-renders that don't grow either
  // dimension (config updates, mention chip refreshes, etc.) leave the
  // scroll position alone so we don't fight the user.
  //
  // Use `behavior: 'instant'` to override `.chat-timeline`'s CSS
  // `scroll-behavior: smooth`, which would otherwise animate every
  // delta-driven snap and feel sluggish on long replies.
  //
  // `lastRowCountRef` / `lastScrollHeightRef` are hoisted to the ref
  // block near the top of the component so the scope-change effect can
  // reset them too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rowsGrew = rows.length > lastRowCountRef.current;
    const heightGrew = el.scrollHeight > lastScrollHeightRef.current;
    lastRowCountRef.current = rows.length;
    lastScrollHeightRef.current = el.scrollHeight;
    if (!rowsGrew && !heightGrew) return;
    if (!pinnedToBottom) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
  }, [rows, pinnedToBottom]);

  /**
   * Align a locally-submitted prompt after its row has rendered. The target
   * may be nested inside a threaded group, so derive its scroll position from
   * viewport rectangles rather than `offsetTop` (whose offset parent would be
   * the thread, not the timeline). The temporary runway rendered below makes
   * room for the first part of the response instead of pinning the prompt
   * against the composer's top edge.
   *
   * This effect follows the ordinary bottom-anchor effect so a local send wins
   * when both react to the same row insertion. It runs only once per accepted
   * submission; streaming deltas can then use normal pinned-follow behavior.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !submissionAnchor || alignedSubmissionKey === submissionAnchor.key) return;

    let target: HTMLElement | null = null;
    if (submissionAnchor.kind === 'chat') {
      const submittedAt = Date.parse(submissionAnchor.at);
      const candidate = messages
        .filter(
          (message) =>
            message.sessionId === submissionAnchor.sessionId &&
            message.role === 'user' &&
            message.content === submissionAnchor.content,
        )
        .sort((a, b) => {
          const aDistance = Math.abs(Date.parse(a.at) - submittedAt);
          const bDistance = Math.abs(Date.parse(b.at) - submittedAt);
          return aDistance - bDistance;
        })[0];
      if (candidate) {
        const id = cssAttrValue(`msg:${candidate.sessionId}:${candidate.at}:${candidate.role}`);
        target = el.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
      }
    } else {
      const candidate = [...terminalEntries]
        .reverse()
        .find(
          (entry) =>
            entry.threadId === submissionAnchor.threadId &&
            entry.msgKind === 'command' &&
            (entry.content === submissionAnchor.input ||
              entry.resolvedFrom === submissionAnchor.input),
        );
      if (candidate) {
        const id = cssAttrValue(candidate.messageId);
        target = el.querySelector<HTMLElement>(`[data-terminal-message-id="${id}"]`);
      }
    }
    if (!target) return;

    const timelineRect = el.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = Math.max(0, el.scrollTop + targetRect.top - timelineRect.top - 12);
    setPinnedToBottom(true);
    el.scrollTo({ top });
    setAlignedSubmissionKey(submissionAnchor.key);
  }, [messages, terminalEntries, submissionAnchor, alignedSubmissionKey]);

  /**
   * Scroll to a session's failed-turn banner (falling back to that
   * session's last rendered bubble when the banner isn't in the DOM —
   * a cleared error, or a session whose rows haven't loaded yet) and
   * flash it. Returns false when there's nothing to land on, so the
   * caller can retry after the next batch of rows renders.
   *
   * Unpins the timeline first: without that, the very next streaming
   * delta or SSE row would yank the viewport back to the bottom and
   * undo the jump the user just asked for.
   */
  const focusSessionError = useCallback(
    (sessionId: string): boolean => {
      const el = scrollRef.current;
      if (!el) return false;
      const escaped = cssAttrValue(sessionId);
      const banner = el.querySelector<HTMLElement>(`[data-session-error="${escaped}"]`);
      const bubbles = el.querySelectorAll<HTMLElement>(`[data-session-id="${escaped}"]`);
      const target = banner ?? bubbles[bubbles.length - 1] ?? null;
      if (!target) return false;
      setPinnedToBottom(false);
      // jsdom (and some webviews) don't implement scrollIntoView — the
      // flash + composer focus below still carry the interaction there.
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
      target.classList.add('timeline-focus-flash');
      window.setTimeout(() => target.classList.remove('timeline-focus-flash'), FOCUS_FLASH_MS);
      // Point the composer at the failed session too, so the user's next
      // message (or the banner's Continue) resumes THAT conversation
      // rather than whichever one the roster happened to select.
      const owner = messagesRef.current.find((m) => m.sessionId === sessionId);
      if (owner) onFocusSession?.(sessionId, owner.gezelId, owner.projectId);
      return true;
    },
    [onFocusSession],
  );

  /**
   * Pending focus request: `{ sessionId, until }`. The timeline loads
   * asynchronously, so the target row usually isn't in the DOM when the
   * request arrives — we retry on each subsequent render until it is, or
   * until the deadline passes (session too old to be in the first page).
   */
  const focusRequestRef = useRef<{ sessionId: string; until: number } | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const requestFocusSessionError = useCallback((sessionId: string) => {
    focusRequestRef.current = { sessionId, until: Date.now() + FOCUS_RETRY_WINDOW_MS };
    setFocusNonce((n) => n + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rows/focusNonce are retry triggers — a fresh render is when the target may finally exist.
  useEffect(() => {
    const req = focusRequestRef.current;
    if (!req) return;
    if (Date.now() > req.until) {
      focusRequestRef.current = null;
      return;
    }
    if (focusSessionError(req.sessionId)) focusRequestRef.current = null;
  }, [rows, focusNonce, focusSessionError]);

  // Live "jump to the failed turn" event — the already-open-project case.
  // Also drains the mailbox so the queued intent can't re-fire later.
  useEffect(() => {
    const onFocusError = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string; sessionId?: string }>).detail;
      if (!detail?.sessionId) return;
      // Only the timeline scoped to that project responds — the global
      // (Meester) timeline shouldn't jump around because a project row
      // was clicked in the sidebar.
      if (detail.projectId !== inflightProjectId) return;
      if (inflightProjectId) consumeFocusSessionError(inflightProjectId);
      requestFocusSessionError(detail.sessionId);
    };
    window.addEventListener('gezel:focus-session-error', onFocusError);
    return () => window.removeEventListener('gezel:focus-session-error', onFocusError);
  }, [inflightProjectId, requestFocusSessionError]);

  // Queued intent — the remount case (the sidebar indicator opened a
  // project whose timeline wasn't mounted yet to hear the live event).
  //
  // Only drop a pending request when the project genuinely changed: this
  // effect runs twice per mount under StrictMode, and clearing
  // unconditionally would throw away the request the first invocation
  // just took out of the (now-empty) mailbox.
  const focusScopeRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focusScopeRef.current !== inflightProjectId) {
      focusScopeRef.current = inflightProjectId;
      focusRequestRef.current = null;
    }
    if (!inflightProjectId) return;
    const intent = consumeFocusSessionError(inflightProjectId);
    if (intent) requestFocusSessionError(intent.sessionId);
  }, [inflightProjectId, requestFocusSessionError]);

  /**
   * Find which message bubble is currently scrolled past the top of
   * the viewport and which user message in the same session is the
   * most recent one above the band — drives the sticky context
   * header. Walks the rendered `[data-msg-id]` children of the
   * scroll container in DOM order. Cheap (~100 elements × one
   * `getBoundingClientRect` per recompute); rAF-throttled by the
   * caller. Returns `null` when nothing is occluding.
   */
  const recomputeStickyHeader = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setStickyHeader((prev) => (prev === null ? prev : null));
      return;
    }
    const containerRect = el.getBoundingClientRect();
    // Publish the timeline's scrollbar gutter for the sticky header's
    // CSS fallback. Once an occluding bubble is found below, its actual
    // rendered bounds replace that fallback so threaded and top-level
    // replies each align to their own column.
    const viewportEl = el.parentElement;
    if (viewportEl) {
      const sbWidth = el.offsetWidth - el.clientWidth;
      viewportEl.style.setProperty('--chat-timeline-sb-width', `${sbWidth}px`);
    }
    // Measure the rendered sticky header (when visible) so the
    // bubble's "still in view" check can account for the band the
    // sticky is about to cover. Falls back to the cached value when
    // the sticky isn't currently mounted.
    const stickyEl = el.parentElement?.querySelector<HTMLElement>('.chat-sticky-header');
    if (stickyEl) {
      const h = stickyEl.getBoundingClientRect().height;
      if (h > 0) stickyHeightRef.current = h;
    }
    const stickyHeight = stickyHeightRef.current;
    // The sticky should appear once the bubble's TOP scrolls off
    // the top of the visible chat area, AND keep showing only while
    // there's still bubble content visible BELOW where the sticky
    // sits. Without the bottom band, the sticky lingered on screen
    // long after the underlying bubble had been fully covered by
    // the sticky itself — burying the last few visible lines under
    // a duplicate header.
    const topLine = containerRect.top;
    const bottomLine = containerRect.top + stickyHeight;

    let occludingAssistantId: string | null = null;
    let occludingAssistantTop = 0;
    let occludingSessionId: string | null = null;
    let occludingAssistantRect: DOMRect | null = null;
    let lastUserIdInSession: string | null = null;

    const nodes = el.querySelectorAll<HTMLElement>('[data-msg-id]');
    for (const node of nodes) {
      const msgId = node.dataset.msgId;
      const sessionId = node.dataset.sessionId;
      if (!msgId) continue;
      const rect = node.getBoundingClientRect();
      // Hide the sticky once the bubble's bottom has scrolled past
      // the band the sticky itself occupies — anything closer to
      // `topLine` would already be hidden under the sticky, so
      // continuing to show it just buries the last visible content.
      const occluding = rect.top < topLine && rect.bottom > bottomLine;
      const isAssistantLike =
        node.classList.contains('msg-assistant') || node.classList.contains('msg-from-gezel');
      if (occluding && isAssistantLike) {
        occludingAssistantId = msgId;
        occludingAssistantTop = rect.top;
        occludingSessionId = sessionId ?? null;
        occludingAssistantRect = rect;
      }
    }

    // The sticky lives outside the scrolling timeline, so CSS alone
    // cannot tell whether the active bubble is in the indented reply
    // column (with a thread rail) or at the timeline root. Mirror the
    // detected bubble's exact border-box instead of guessing from a
    // global indent. This also avoids fractional-pixel drift at the
    // right edge when the 92% max-width resolves differently.
    if (viewportEl && occludingAssistantRect) {
      const viewportRect = viewportEl.getBoundingClientRect();
      const left = occludingAssistantRect.left - viewportRect.left;
      viewportEl.style.setProperty('--chat-sticky-left', `${left}px`);
      viewportEl.style.setProperty('--chat-sticky-width', `${occludingAssistantRect.width}px`);
    }

    // Second pass: find the most-recent user message in the same
    // session whose bottom is above the OCCLUDING ASSISTANT's top.
    // Anchoring against the assistant (rather than a fixed band)
    // means we pick the user turn that directly precedes this
    // specific occluded reply, even if a later user message is
    // also above the old band line (e.g. an `[Answer to: …]`
    // synthetic reply from the question panel).
    if (occludingAssistantId && occludingSessionId) {
      for (const node of nodes) {
        const msgId = node.dataset.msgId;
        const sessionId = node.dataset.sessionId;
        if (!msgId || sessionId !== occludingSessionId) continue;
        if (!node.classList.contains('msg-user')) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= occludingAssistantTop) lastUserIdInSession = msgId;
      }
    }

    const next =
      occludingAssistantId && lastUserIdInSession
        ? { userMessageId: lastUserIdInSession, assistantMessageId: occludingAssistantId }
        : null;
    setStickyHeader((prev) => {
      if (prev === next) return prev;
      if (
        prev &&
        next &&
        prev.userMessageId === next.userMessageId &&
        prev.assistantMessageId === next.assistantMessageId
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const scheduleStickyRecompute = useCallback(() => {
    if (stickyRecomputeRafRef.current !== null) return;
    stickyRecomputeRafRef.current = requestAnimationFrame(() => {
      stickyRecomputeRafRef.current = null;
      recomputeStickyHeader();
    });
  }, [recomputeStickyHeader]);

  // Recompute the sticky header whenever the rendered rows change
  // (new bubbles, scope swap, etc.). The post-render layout might
  // have shifted what's at the top of the viewport even without
  // a scroll event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows change is the trigger — body doesn't read rows but their presence marks "layout may have shifted".
  useEffect(() => {
    scheduleStickyRecompute();
  }, [rows, scheduleStickyRecompute]);

  // Keep the measured sticky bounds current when the chat column
  // changes width (window resize, sidebar drag, or rail toggle) even
  // if the user has not generated a scroll event.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(scheduleStickyRecompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scheduleStickyRecompute]);

  // Drop the rAF on unmount so we don't leave a callback running
  // after the component is gone.
  useEffect(() => {
    return () => {
      if (stickyRecomputeRafRef.current !== null) {
        cancelAnimationFrame(stickyRecomputeRafRef.current);
        stickyRecomputeRafRef.current = null;
      }
      if (scrollbarIdleTimerRef.current !== null) {
        window.clearTimeout(scrollbarIdleTimerRef.current);
        scrollbarIdleTimerRef.current = null;
      }
    };
  }, []);

  const onScroll = useCallback(() => {
    scheduleStickyRecompute();
    const el = scrollRef.current;
    if (!el) return;
    el.classList.add('chat-timeline-scrolling');
    if (scrollbarIdleTimerRef.current !== null) {
      window.clearTimeout(scrollbarIdleTimerRef.current);
    }
    scrollbarIdleTimerRef.current = window.setTimeout(() => {
      scrollRef.current?.classList.remove('chat-timeline-scrolling');
      scrollbarIdleTimerRef.current = null;
    }, SCROLLBAR_IDLE_MS);
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const nearBottom = distFromBottom <= SCROLL_NEAR_BOTTOM_PX;
    // Only flip state when it actually changes — otherwise every
    // scroll event while sitting at the bottom would schedule a
    // no-op re-render, adding noise to the React profiler and
    // defeating the point of memoized children.
    setPinnedToBottom((prev) => (prev === nearBottom ? prev : nearBottom));

    // Pagination upward: when the user nears the top, fetch an older
    // slice and prepend it. Preserve scroll position by snapshotting
    // scrollHeight before the insert.
    if (
      el.scrollTop <= SCROLL_NEAR_TOP_PX &&
      hasMore &&
      !loading &&
      !paginatingRef.current &&
      oldestAt
    ) {
      paginatingRef.current = true;
      const prevHeight = el.scrollHeight;
      const prevTop = el.scrollTop;
      void (async () => {
        try {
          const res = await loadTimeline({ limit: PAGE_SIZE, before: oldestAt });
          setMessages((prev) => [...res.messages, ...prev]);
          setHasMore(res.hasMore);
          setOldestAt(res.nextCursor);
          // After the next paint, restore scroll position. Use an
          // instant scroll — the CSS `scroll-behavior: smooth` on
          // `.chat-timeline` would otherwise animate the correction,
          // which reads as a reverse scroll glitch right after
          // appending older messages at the top.
          requestAnimationFrame(() => {
            const el2 = scrollRef.current;
            if (el2)
              el2.scrollTo({
                top: el2.scrollHeight - prevHeight + prevTop,
                behavior: 'instant' as ScrollBehavior,
              });
            paginatingRef.current = false;
          });
        } catch {
          paginatingRef.current = false;
        }
      })();
    }
  }, [hasMore, loading, oldestAt, loadTimeline, scheduleStickyRecompute]);

  // Explicit toggle from the floating pin button. When the user turns
  // pinning back on, snap to the bottom right away — otherwise they'd
  // have to scroll there themselves and the next auto-scroll would
  // feel random. Turning pinning off is a no-op; we just stop
  // following.
  const togglePinned = useCallback(() => {
    setPinnedToBottom((prev) => {
      const next = !prev;
      if (next) {
        const el = scrollRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
      }
      return next;
    });
  }, []);

  // Resolve the sticky-header payload BEFORE the early returns
  // below — React requires hook calls to fire in the same order on
  // every render. `stickyHeader` carries just the ids; we look up
  // the actual user message + assistant slot / message here so the
  // sticky element re-renders with fresh live status (the streaming
  // bubble's elapsed counter, tool count, wire pulses) on every
  // `liveBump`. Returns null when nothing is occluded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: liveBump is a counter that forces re-derivation from liveRef.current (a mutable map React doesn't track).
  const stickyPayload = useMemo(() => {
    if (!stickyHeader) return null;
    const userMsg = messages.find(
      (m) => `msg:${m.sessionId}:${m.at}:${m.role}` === stickyHeader.userMessageId,
    );
    if (!userMsg) return null;
    let assistantInfo:
      | { kind: 'live'; sessionId: string; slot: LiveSlot }
      | { kind: 'message'; msg: TimelineMessage }
      | null = null;
    if (stickyHeader.assistantMessageId.startsWith('live:')) {
      const sid = stickyHeader.assistantMessageId.slice('live:'.length);
      const slot = liveRef.current.get(sid);
      if (slot) assistantInfo = { kind: 'live', sessionId: sid, slot };
    } else {
      const msg = messages.find(
        (m) => `msg:${m.sessionId}:${m.at}:${m.role}` === stickyHeader.assistantMessageId,
      );
      if (msg) assistantInfo = { kind: 'message', msg };
    }
    if (!assistantInfo) return null;
    return { userMsg, assistantInfo };
  }, [stickyHeader, messages, liveBump]);

  if (loading && messages.length === 0) {
    return (
      <div className="chat-timeline chat-timeline-loading">
        <p className="muted small">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="chat-timeline chat-timeline-error">
        <p className="error">{error}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="chat-timeline" ref={scrollRef} data-testid="chat-timeline">
        {emptyPlaceholder && <p className="placeholder">{emptyPlaceholder}</p>}
      </div>
    );
  }

  // Render: walk the threaded item list. Each chat item is a
  // turn-rooted thread — trigger message on top, replies railed
  // underneath — and a session divider fires whenever the thread's
  // sessionId differs from the previous chat thread's. The fade rule
  // applies to each completed message bubble; streaming rows are
  // always full opacity.
  //
  // At each session boundary, if the PREVIOUS session's last turn
  // errored (persisted on the session record) AND there's no live
  // streaming slot for it now, emit a "last turn failed" banner.
  // Same check after the last item in the list. This gives a user who
  // navigated away during a failing turn a visible breadcrumb on
  // return, instead of just their own message with nothing below.
  let prevSessionId: string | null = null;
  let prevSessionError: string | null = null;
  let prevSessionProjectId: string | null = null;
  // Sessions we've already rendered a divider for in this view. When
  // another session's threads land between two turns of the same
  // session (common on GlobalTimeline: user A asks Florian a question,
  // gezel B does background work in parallel, the answer-followup turn
  // appears below B's thread), the re-entrance to session A used to
  // render as "new conversation with Florian · started 2m ago" — same
  // wording as a fresh session, suggesting to the user that their
  // answer landed in a separate conversation when it actually didn't.
  // The dedicated "continuing" marker tells the user this is the same
  // session they were in.
  const seenSessionIds = new Set<string>();
  // Last terminal entry seen per thread, used to split terminal
  // sessions on >TERMINAL_SESSION_GAP_MS gaps. Tracked per-thread
  // (not globally) so commands in folder A don't reset the gap
  // clock for folder B and vice versa.
  const prevTerminalByThread = new Map<string, TerminalTimelineEntry>();
  // Mid-turn questions (npm-install, command, tool-permission,
  // image-generation approvals) are created BEFORE the assistant
  // message commits — there's nothing in the persisted timeline to
  // stamp `pendingQuestionId` on yet. While the turn is still in
  // flight, surface the question on the live `StreamingBubble` so
  // the user can answer in chat instead of reaching for the dropdown.
  // After the turn commits, end-of-turn stamping (in ChatManager)
  // attaches the question id to the now-persisted assistant message
  // and the regular `MessageBubble` slot takes over rendering.
  //
  // Build a per-session lookup once: most-recent unanswered question
  // per session id. Tiny Map walk; bounded by total pending questions
  // (typically ≤ a handful). Skip ids already claimed by a persisted
  // message — `ask_user_question` stamps the prior assistant bubble
  // synchronously, so without this exclusion the same card would
  // render twice (once on the stamped bubble, once on the streaming
  // bubble of the in-flight follow-up turn).
  const claimedQuestionIds = new Set<string>();
  for (const m of messages) {
    if (m.pendingQuestionId) claimedQuestionIds.add(m.pendingQuestionId);
  }
  const liveQuestionsBySession = new Map<string, Question>();
  for (const q of questionsById.values()) {
    if (q.answer) continue;
    if (claimedQuestionIds.has(q.id)) continue;
    const existing = liveQuestionsBySession.get(q.sessionId);
    if (!existing || q.createdAt > existing.createdAt) {
      liveQuestionsBySession.set(q.sessionId, q);
    }
  }
  const els: React.ReactNode[] = [];
  const emitSessionErrorBanner = (sid: string, error: string, projectId: string | null) => {
    els.push(
      <div
        key={`session-error:${sid}`}
        className="timeline-session-error-banner"
        // Scroll target for the sidebar's failed-turn indicator — see
        // `focusSessionError` above.
        data-session-error={sid}
      >
        ✗ Last turn failed: {error}
        {isModelUnavailableError(error) && (
          <>
            {' '}
            <button
              type="button"
              className="timeline-session-error-link"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('gezel:navigate', {
                    detail: { view: 'settings', section: 'defaults' },
                  }),
                )
              }
            >
              Open Settings →
            </button>
          </>
        )}
        {projectId && (
          <>
            {' '}
            <button
              type="button"
              className="timeline-session-error-link"
              title="Clear the failed-turn state across this project so ambient work resumes"
              onClick={() => {
                // One engine crash poisons several of a project's sessions, so
                // "Continue" clears them all: the project goes active again and
                // every failed-turn banner drops (no separate collapsed state).
                void api
                  .clearProjectErrors(projectId)
                  .then(() => {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.projectId === projectId ? { ...m, sessionLastTurnError: undefined } : m,
                      ),
                    );
                    window.dispatchEvent(
                      new CustomEvent('gezel:session-error-cleared', { detail: { projectId } }),
                    );
                  })
                  .catch(() => {});
              }}
            >
              Continue
            </button>
          </>
        )}{' '}
        {!isUserCancelledTurnError(error) && (
          <ReportErrorLink report={{ surface: 'session-error', message: error }} />
        )}
      </div>,
    );
  };
  /**
   * Render one persisted chat message as a bubble. Shared by thread
   * roots and replies — `opts` carries the thread-position concerns
   * (suppressed repeat-author header, late-reply timestamp, recovered
   * empty-intermediate) so the prop plumbing below stays in one place.
   */
  const renderMessageBubble = (
    m: TimelineMessage,
    opts?: {
      suppressHeader?: boolean;
      timestampLabel?: string;
      recoveredInNextTurn?: boolean;
    },
  ): React.ReactNode => {
    const gezel = gezels.get(m.gezelId);
    const isActive = m.sessionId === activeSessionId;
    const isRecent = withinHours(m.sessionLastActivityAt, RECENT_THRESHOLD_MS);
    const fade = !isActive && !isRecent;
    // Only surface the project context when (a) we're on a
    // cross-project surface (Meester / global timeline) AND (b) the
    // project isn't the implicit `default` bucket — calling out
    // "in Default" everywhere would just be noise.
    const project =
      showProjectName && m.projectId !== 'default' ? projects.get(m.projectId) : undefined;
    // Inter-gezel handoff bubbles take their font from the *sender* so the
    // "Yusuf → Leo" bubble still reads in Yusuf's voice when it lands in
    // Leo's session. Plain assistant bubbles use the session owner's font.
    const fontSourceId = m.from ? m.from.gezelId : m.gezelId;
    const fontSourceFont = gezels.get(fontSourceId)?.font;
    const fontFamily = resolveGezelFontFamily(fontSourceFont);
    const fontScale = resolveGezelFontScale(fontSourceFont);
    return (
      <MessageBubble
        key={`msg:${m.sessionId}:${m.at}:${m.role}`}
        dataMsgId={`msg:${m.sessionId}:${m.at}:${m.role}`}
        dataSessionId={m.sessionId}
        debugMode={debugMode}
        sessionId={m.sessionId}
        messageAt={m.at}
        role={m.role}
        content={m.content}
        authorLabel={
          gezel
            ? displayName(
                { name: gezel.name, roleBasedName: gezel.roleBasedName },
                roleBasedNameOnlyMode,
              )
            : 'Gezel'
        }
        authorIcon={gezel?.icon ?? null}
        {...(gezel?.poppetje ? { authorPoppetje: gezel.poppetje } : {})}
        {...(gezel?.iconOverride ? { authorIconOverride: true } : {})}
        authorTooltip={tooltipForGezel(m.gezelId)}
        {...(() => {
          const drift = driftLabelFor(m.sessionProviderName, m.sessionModel);
          return drift ? { driftLabel: drift } : {};
        })()}
        {...(!roleBasedNameOnlyMode && gezel?.role ? { authorRole: gezel.role } : {})}
        {...(m.from ? { from: m.from } : {})}
        {...(m.nudge ? { nudge: true } : {})}
        receiverLabel={
          gezel
            ? displayName(
                { name: gezel.name, roleBasedName: gezel.roleBasedName },
                roleBasedNameOnlyMode,
              )
            : 'Gezel'
        }
        {...(fontFamily ? { fontFamily } : {})}
        {...(fontScale !== 1 ? { fontScale } : {})}
        {...(project ? { projectLabel: project.name } : {})}
        extraClass={fade ? 'timeline-msg-faded' : undefined}
        mediaProvider={getReadonlyGezelMediaProvider(m.projectId, m.sessionId)}
        {...(m.referencedArtifacts ? { referencedArtifacts: m.referencedArtifacts } : {})}
        {...(m.referencedTasks ? { referencedTasks: m.referencedTasks } : {})}
        {...(m.toolCalls && m.toolCalls.length > 0
          ? { toolCalls: m.toolCalls, projectId: m.projectId }
          : {})}
        {...(m.reasoning ? { reasoning: m.reasoning } : {})}
        {...(m.reasoningDurationMs !== undefined
          ? { reasoningDurationMs: m.reasoningDurationMs }
          : {})}
        {...(m.attemptedToolCalls && m.attemptedToolCalls.length > 0
          ? { attemptedToolCalls: m.attemptedToolCalls }
          : {})}
        {...(opts?.recoveredInNextTurn ? { recoveredInNextTurn: true } : {})}
        {...(opts?.suppressHeader ? { suppressHeader: true } : {})}
        {...(opts?.timestampLabel ? { timestampLabel: opts.timestampLabel } : {})}
        {...(m.intents && m.intents.length > 0 ? { intents: m.intents } : {})}
        {...(m.warnings && m.warnings.length > 0 ? { warnings: m.warnings } : {})}
        {...(m.pendingQuestionId && questionsById.get(m.pendingQuestionId)
          ? {
              question: questionsById.get(m.pendingQuestionId)!,
              onQuestionAnswered: (q) =>
                setQuestionsById((prev) => {
                  const next = new Map(prev);
                  next.set(q.id, q);
                  return next;
                }),
            }
          : {})}
        {...(onArtifactReference
          ? { onArtifactReference: (path: string) => onArtifactReference(path, m.projectId) }
          : {})}
        onTaskReference={(ref) =>
          window.dispatchEvent(new CustomEvent('gezel:open-tab', { detail: { kind: 'task', ref } }))
        }
      />
    );
  };
  /**
   * Render a session's in-flight turn: the streaming bubble plus any
   * ghost bubbles for messages queued behind it. Returned as a list so
   * the thread loop can splice them into the reply column in place.
   */
  const renderStreamingRows = (sessionId: string, slot: LiveSlot): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    const gezel = gezels.get(slot.gezelId);
    const fontFamily = resolveGezelFontFamily(gezel?.font);
    const fontScale = resolveGezelFontScale(gezel?.font);
    nodes.push(
      <StreamingBubble
        key={`live:${sessionId}`}
        dataMsgId={`live:${sessionId}`}
        dataSessionId={sessionId}
        authorLabel={
          gezel
            ? displayName(
                { name: gezel.name, roleBasedName: gezel.roleBasedName },
                roleBasedNameOnlyMode,
              )
            : 'Gezel'
        }
        authorIcon={gezel?.icon ?? null}
        {...(gezel?.poppetje ? { authorPoppetje: gezel.poppetje } : {})}
        {...(gezel?.iconOverride ? { authorIconOverride: true } : {})}
        authorTooltip={tooltipForGezel(slot.gezelId)}
        {...(() => {
          if (!slot.sessionProviderName) return {};
          const drift = driftLabelFor(slot.sessionProviderName, slot.sessionModel);
          return drift ? { driftLabel: drift } : {};
        })()}
        {...(!roleBasedNameOnlyMode && gezel?.role ? { authorRole: gezel.role } : {})}
        segments={slot.segments}
        startedAt={slot.startedAt}
        lastActivityAt={slot.lastActivityAt}
        hasProgress={slot.hasProgress}
        {...(providerForGezel(slot.gezelId) === 'ollama'
          ? { onProbeOllama: () => api.ollamaProbe() }
          : {})}
        {...(providerForGezel(slot.gezelId) === 'ollama'
          ? { localEngine: 'ollama' as const }
          : providerForGezel(slot.gezelId) === 'llama-cpp'
            ? { localEngine: 'llama-cpp' as const }
            : providerForGezel(slot.gezelId) === 'ds4'
              ? { localEngine: 'ds4' as const }
              : {})}
        onCancel={async () => {
          try {
            await api.cancelChatSessionTurn(sessionId);
          } catch (err) {
            console.warn('[timeline] failed to cancel turn:', err);
          }
        }}
        onReEngage={async () => {
          // Cancel first: a wedged turn holds the session lock, so a
          // nudge sent while it runs would queue behind it forever.
          try {
            await api.cancelChatSessionTurn(sessionId);
          } catch (err) {
            console.warn('[timeline] re-engage: cancel failed:', err);
          }
          try {
            await api.sendToChatSession(sessionId, {
              message: 'Please continue where you left off and finish the work you started.',
            });
          } catch (err) {
            console.warn('[timeline] re-engage: send failed:', err);
          }
        }}
        {...(fontFamily ? { fontFamily } : {})}
        {...(fontScale !== 1 ? { fontScale } : {})}
        {...(slot.error ? { error: slot.error } : {})}
        {...(slot.errorDetail ? { errorDetail: slot.errorDetail } : {})}
        {...(slot.queueAhead !== undefined ? { queueAhead: slot.queueAhead } : {})}
        {...(slot.wirePulseCount && slot.wirePulseCount > 0
          ? { wirePulseCount: slot.wirePulseCount }
          : {})}
        {...(slot.thinkingLabel ? { thinkingLabel: slot.thinkingLabel } : {})}
        {...(slot.thinkingProgress !== undefined
          ? { thinkingProgress: slot.thinkingProgress }
          : {})}
        {...(slot.thinkingDetail ? { thinkingDetail: slot.thinkingDetail } : {})}
        {...(slot.liveReasoning ? { liveReasoning: slot.liveReasoning } : {})}
        {...(slot.liveToolArgs ? { liveToolArgs: slot.liveToolArgs } : {})}
        {...(slot.gpuSwapTask ? { gpuSwapTask: slot.gpuSwapTask } : {})}
        {...(slot.gpuSwapDetail ? { gpuSwapDetail: slot.gpuSwapDetail } : {})}
        {...(slot.gpuSwapPrompt ? { gpuSwapPrompt: slot.gpuSwapPrompt } : {})}
        {...(slot.gpuSwapProgress !== undefined ? { gpuSwapProgress: slot.gpuSwapProgress } : {})}
        {...(slot.gpuSwapStep !== undefined ? { gpuSwapStep: slot.gpuSwapStep } : {})}
        {...(slot.gpuSwapTotalSteps !== undefined
          ? { gpuSwapTotalSteps: slot.gpuSwapTotalSteps }
          : {})}
        {...(slot.gpuSwapSecondsPerStep !== undefined
          ? { gpuSwapSecondsPerStep: slot.gpuSwapSecondsPerStep }
          : {})}
        {...(slot.awaitingGezelName ? { awaitingGezelName: slot.awaitingGezelName } : {})}
        {...(slot.warnings && slot.warnings.length > 0 ? { warnings: slot.warnings } : {})}
        {...(liveQuestionsBySession.get(sessionId)
          ? {
              question: liveQuestionsBySession.get(sessionId)!,
              onQuestionAnswered: (q: Question) =>
                setQuestionsById((prev) => {
                  const next = new Map(prev);
                  next.set(q.id, q);
                  return next;
                }),
            }
          : {})}
        debugMode={debugMode}
        sessionId={sessionId}
      />,
    );
    // Render any per-session queued messages as ghost bubbles
    // directly under this session's streaming bubble. They
    // dissolve into real user_message bubbles when the drain
    // fires (see the `queue_removed` handler in handleEnvelope).
    const queued = queuedRef.current.get(sessionId);
    if (queued && queued.length > 0) {
      for (const entry of queued) {
        nodes.push(
          <GhostQueuedBubble
            key={`ghost:${entry.id}`}
            sessionId={sessionId}
            queueId={entry.id}
            preview={entry.preview}
            enqueuedAt={entry.enqueuedAt}
            mediaProvider={getReadonlyGezelMediaProvider(slot.projectId, sessionId)}
            {...(entry.nudge ? { nudge: true } : {})}
            onDiscard={async () => {
              try {
                await api.cancelQueuedMessage(sessionId, entry.id);
              } catch (err) {
                console.warn('[timeline] failed to discard queued message:', err);
              }
            }}
            onCancelCurrent={async () => {
              try {
                await api.cancelChatSessionTurn(sessionId);
              } catch (err) {
                console.warn('[timeline] failed to cancel current turn:', err);
              }
            }}
            onLoadText={async () => {
              // Full-text fetch for attachment rendering and editing — the
              // SSE event only carries a truncated preview. `null` when the
              // entry is gone.
              try {
                const res = await api.listSessionQueue(sessionId);
                return res.entries.find((e) => e.queueId === entry.id)?.text ?? null;
              } catch {
                return null;
              }
            }}
            onSaveEdit={async (text) => {
              try {
                await api.updateQueuedMessage(sessionId, entry.id, { message: text });
                return true;
              } catch (err) {
                // 404 → the entry started or was discarded mid-edit;
                // the ghost is about to vanish via queue_removed.
                if (/not found/i.test((err as Error).message ?? '')) return false;
                throw err;
              }
            }}
          />,
        );
      }
    }
    return nodes;
  };
  for (const item of threadItems) {
    // Terminal rows live outside session-divider logic — they belong
    // to a `(project, workingDir)` thread, not a (gezel, session)
    // pair, and rendering them through the divider code would emit
    // a stale "session header" with the prior session's metadata.
    if (item.kind === 'terminal') {
      const entry = item.entry;
      const prevTerminal = prevTerminalByThread.get(entry.threadId);
      const isFirstInThread = !prevTerminal;
      const gapMs = prevTerminal
        ? Math.max(0, new Date(entry.at).getTime() - new Date(prevTerminal.at).getTime())
        : 0;
      const isNewSession = isFirstInThread || gapMs > TERMINAL_SESSION_GAP_MS;
      if (isNewSession) {
        els.push(
          renderTerminalSessionDivider({
            entry,
            key: `terminal-divider:${entry.threadId}:${entry.messageId}`,
          }),
        );
      }
      els.push(
        <TerminalBubble
          key={`terminal:${entry.threadId}:${entry.messageId}`}
          entry={entry}
          {...(onWorkspaceReference
            ? {
                onOpenWorkspaceFile: (path: string) => onWorkspaceReference(path, entry.projectId),
              }
            : {})}
        />,
      );
      prevTerminalByThread.set(entry.threadId, entry);
      continue;
    }
    if (item.kind === 'terminal-streaming') {
      // Live "growing" output bubble; takes over the row until the
      // final `message` event arrives with the matching runId and
      // the SSE handler deletes the slot.
      const projectId = item.slot.projectId;
      const runId = item.runId;
      els.push(
        <TerminalStreamingBubble
          key={`terminal-streaming:${runId}`}
          content={item.slot.content}
          cwd={item.slot.cwd}
          startedAt={item.slot.startedAt}
          {...(item.slot.awaitingInput ? { awaitingInput: item.slot.awaitingInput } : {})}
          onCancel={() => {
            // Best-effort cancel: server idempotently returns 404
            // if the run already finished, which the client
            // swallows. We don't optimistically drop the live
            // slot — that happens when the final message arrives
            // via SSE carrying the matching runId.
            void api.cancelTerminalRun(projectId, runId).catch(() => {
              /* surfaced via the final message's exit code */
            });
          }}
          onSendInput={(text) => {
            // Optimistically drop the awaitingInput flag — the
            // server's next chunk would do it anyway, but this
            // hides the reply UI immediately so the user knows
            // the click registered. If the shell asks AGAIN
            // (wrong password), a fresh inputRequested event
            // re-sets the flag.
            const slot = terminalLiveRef.current.get(runId);
            if (slot) {
              delete slot.awaitingInput;
              setTerminalLiveBump((n) => n + 1);
            }
            void api.sendTerminalInput(projectId, runId, text).catch((err) => {
              console.warn('[ChatTimelineView] sendTerminalInput failed', err);
            });
          }}
        />,
      );
      continue;
    }
    // Chat thread group. Session dividers + failed-turn banners fire at
    // group boundaries — a thread never straddles two sessions (merged
    // fan-out threads carry the kept root's session for this purpose).
    const sid = item.sessionId;
    const anchorRow = item.root ?? item.replies[0];
    if (!anchorRow) continue;
    if (sid !== prevSessionId) {
      if (prevSessionId && prevSessionError && !liveRef.current.has(prevSessionId)) {
        emitSessionErrorBanner(prevSessionId, prevSessionError, prevSessionProjectId);
      }
      const isContinuing = seenSessionIds.has(sid);
      els.push(
        renderDivider({
          row: anchorRow,
          gezels,
          projects,
          showProjectName,
          activeSessionId,
          onFocusSession,
          continuing: isContinuing,
          key: `divider:${sid}:${item.at}`,
          roleBasedNameOnlyMode,
        }),
      );
      seenSessionIds.add(sid);
      prevSessionId = sid;
      prevSessionError = null;
      prevSessionProjectId = null;
    }
    // Session-level error metadata rides on every message row of the
    // session, so the first message row in the group is as good as any.
    const errorSource = item.root ?? item.replies.find((r) => r.kind === 'message');
    if (errorSource && errorSource.kind === 'message' && errorSource.msg.sessionLastTurnError) {
      prevSessionError = errorSource.msg.sessionLastTurnError;
      prevSessionProjectId = errorSource.msg.projectId;
    }

    const children: React.ReactNode[] = [];
    if (item.root) {
      // Thread roots always show when they happened — with replies
      // pulled up under their trigger, wall-clock adjacency no longer
      // implies recency, so the root carries the time cue.
      children.push(
        renderMessageBubble(item.root.msg, {
          timestampLabel: formatRelativeTime(item.root.at),
        }),
      );
    }
    if (item.replies.length > 0) {
      const replyEls: React.ReactNode[] = [];
      for (let j = 0; j < item.replies.length; j++) {
        const reply = item.replies[j]!;
        if (reply.kind === 'streaming') {
          replyEls.push(...renderStreamingRows(reply.sessionId, reply.slot));
          continue;
        }
        const m = reply.msg;
        const prev = j > 0 ? item.replies[j - 1] : undefined;
        const prevAtIso = prev ? prev.at : item.root?.at;
        const gapMs = prevAtIso ? Math.max(0, Date.parse(m.at) - Date.parse(prevAtIso)) : 0;
        // A reply that lands minutes after the previous one (the
        // continuation loop's trailing status iterations are the
        // canonical case) keeps its header and gains a timestamp, so
        // the gap is visible instead of reading as an instant reply.
        const late = gapMs > LATE_REPLY_GAP_MS;
        // Consecutive replies by the same gezel merge into one
        // author run — the header renders once at the top of the run.
        const sameAuthorRun = prev?.kind === 'message' && prev.msg.gezelId === m.gezelId;
        // Detect "this empty bubble was recovered by the next turn" so
        // the bubble can swap its loud "Ask again" placeholder for a
        // quiet "(continued in the next turn)" stub. The continuation
        // loop in the service produces a fresh assistant message per
        // iteration; an intermediate that ended with tools-but-no-text
        // is a recovery candidate when the next reply in this thread
        // is another assistant message with real content.
        const next = item.replies[j + 1];
        const recovered =
          m.role === 'assistant' &&
          m.content.trim().length === 0 &&
          !!m.toolCalls &&
          m.toolCalls.length > 0 &&
          next !== undefined &&
          next.kind === 'message' &&
          next.msg.sessionId === m.sessionId &&
          next.msg.role === 'assistant' &&
          next.msg.content.trim().length > 0;
        replyEls.push(
          renderMessageBubble(m, {
            ...(sameAuthorRun && !late ? { suppressHeader: true } : {}),
            ...(late ? { timestampLabel: formatRelativeTime(m.at) } : {}),
            ...(recovered ? { recoveredInNextTurn: true } : {}),
          }),
        );
      }
      children.push(
        <div key="replies" className="timeline-thread-replies">
          {replyEls}
        </div>,
      );
    }
    // Full-height rail threads: the connector line only draws when the
    // left gutter is clear top-to-bottom — user roots are right-aligned
    // and rootless threads have no root at all. Handoff roots render as
    // left-aligned stretch bubbles whose translucent fill would let the
    // line show through, so they keep the replies-only border rail.
    const railed = item.replies.length > 0 && (!item.root || !item.root.msg.from);
    els.push(
      <div
        key={`thread:${sid}:${item.at}`}
        className={`timeline-thread${item.root ? '' : ' timeline-thread-rootless'}${
          railed ? ' timeline-thread-railed' : ''
        }`}
      >
        {children}
      </div>,
    );
  }
  // Trailing banner for the final session in the stream.
  if (prevSessionId && prevSessionError && !liveRef.current.has(prevSessionId)) {
    emitSessionErrorBanner(prevSessionId, prevSessionError, prevSessionProjectId);
  }

  // Surface the active session's context-window status (if any) as
  // a sticky banner above the scroll area. Only one banner at a time
  // — keying off `activeSessionId` keeps cross-session timelines
  // (Meester global view) from stacking warnings for every session.
  const activeContextStatus = activeSessionId
    ? contextStatusRef.current.get(activeSessionId)
    : undefined;
  const activeContextPercent =
    activeContextStatus?.kind === 'warning' &&
    typeof activeContextStatus.estimatedTokens === 'number' &&
    typeof activeContextStatus.numCtx === 'number' &&
    activeContextStatus.numCtx > 0
      ? Math.round((100 * activeContextStatus.estimatedTokens) / activeContextStatus.numCtx)
      : null;
  const submissionStillRunning =
    submissionAnchor?.kind === 'chat'
      ? liveRef.current.has(submissionAnchor.sessionId)
      : submissionAnchor?.kind === 'terminal'
        ? terminalLiveRef.current.has(submissionAnchor.runId)
        : false;
  const showResponseRunway =
    submissionAnchor !== null &&
    (alignedSubmissionKey !== submissionAnchor.key || submissionStillRunning);

  return (
    <div className="chat-timeline-viewport">
      {activeContextStatus && (
        <output className={`chat-context-banner chat-context-banner-${activeContextStatus.kind}`}>
          {activeContextStatus.kind === 'warning' ? (
            <>
              <span className="chat-context-banner-icon" aria-hidden>
                ⚠
              </span>
              <span className="chat-context-banner-body">
                <strong>Context window getting full</strong> — this thread{' '}
                {activeContextPercent === null
                  ? 'is approaching'
                  : activeContextPercent > 100
                    ? 'has exceeded'
                    : `has used about ${activeContextPercent}% of`}{' '}
                the model&apos;s available context. Earlier context may become less reliable —
                consider starting fresh for better recall.
              </span>
            </>
          ) : (
            <>
              <span className="chat-context-banner-icon" aria-hidden>
                ✦
              </span>
              <span className="chat-context-banner-body">
                <strong>Compacted older messages</strong> to fit the model context.{' '}
                {activeContextStatus.removedCount ?? 0} earlier turn
                {activeContextStatus.removedCount === 1 ? '' : 's'} were summarized into a single
                bubble; the gezel will continue from the synthesis.
              </span>
            </>
          )}
        </output>
      )}
      {stickyPayload && <ChatStickyHeader payload={stickyPayload} gezels={gezels} />}
      <div
        className="chat-timeline"
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="chat-timeline"
      >
        {hasMore && (
          <div className="timeline-loading-pill muted small">
            {paginatingRef.current ? 'Loading older messages…' : 'Scroll up for older messages'}
          </div>
        )}
        {els}
        {showResponseRunway && <div className="timeline-response-runway" aria-hidden="true" />}
      </div>
      {!pinnedToBottom && (
        <button
          type="button"
          className="chat-timeline-pin-toggle"
          onClick={togglePinned}
          title="Jump to newest and follow"
          aria-label="Jump to newest and follow"
        >
          <svg
            className="chat-timeline-pin-glyph"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            role="img"
            aria-hidden
          >
            <title>Jump to newest</title>
            {/* Arrow shaft + head — pointing down to the underline. */}
            <line x1="12" y1="4" x2="12" y2="15" />
            <polyline points="6 10 12 16 18 10" />
            {/* Underline — the "land here" bar. */}
            <line x1="5" y1="20" x2="19" y2="20" />
          </svg>
        </button>
      )}
    </div>
  );
}

function renderDivider(args: {
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
  const handoff = row.kind === 'message' ? row.msg.handoffFrom : undefined;
  const handoffName = handoff
    ? (() => {
        const hg = gezels.get(handoff.gezelId);
        return hg
          ? displayName({ name: hg.name, roleBasedName: hg.roleBasedName }, roleBasedNameOnlyMode)
          : undefined;
      })()
    : undefined;
  const gezelName = gezel
    ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, roleBasedNameOnlyMode)
    : 'Gezel';

  return (
    <button
      key={key}
      type="button"
      className={`timeline-session-divider${isActive ? ' timeline-session-divider-active' : ''}${
        continuing ? ' timeline-session-divider-continuing' : ''
      }`}
      onClick={() => onFocusSession?.(sessionId, gezelId, projectId)}
      title="Focus this thread — composer will post here"
    >
      <GezelIcon
        svg={gezel?.icon ?? null}
        poppetje={gezel?.poppetje}
        iconOverride={gezel?.iconOverride}
        name={gezelName}
        size={16}
      />
      <span className="timeline-divider-meta">
        {continuing ? (
          <>
            ↩ continuing with {gezelName}
            {project && <> · in {project.name}</>}
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
      {handoff && handoffName && (
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
          handoff from {handoffName}
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
function renderTerminalSessionDivider(args: {
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
      <span className="timeline-divider-meta">
        terminal session · started {formatRelativeTime(entry.at)}
      </span>
    </div>
  );
}

/** Whether any text segment carries non-empty content — used to
 *  decide whether the streaming-status line should read "queued"
 *  (queue acknowledged, no tokens yet) vs the regular thinking
 *  state (queue acknowledged AND tokens have arrived). */
function segmentsHaveText(segments: LiveSegment[]): boolean {
  for (const s of segments) {
    if (s.kind === 'text' && s.content.length > 0) return true;
  }
  return false;
}

/** Count tool segments — replaces the old `toolActivity.length`
 *  shorthand from when tools and text lived in separate fields. */
function countSegmentTools(segments: LiveSegment[]): number {
  let n = 0;
  for (const s of segments) if (s.kind === 'tool') n++;
  return n;
}

function findLastForSession(
  messages: TimelineMessage[],
  sessionId: string,
): TimelineMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.sessionId === sessionId) return messages[i]!;
  }
  return null;
}

function isModelUnavailableError(message: string): boolean {
  return /model\s+.*\bnot available\b/i.test(message) || /\bunknown model\b/i.test(message);
}

function bumpIso(iso: string): string {
  // Make sure the streaming row sorts strictly after the prior message.
  try {
    const t = new Date(iso).getTime();
    return new Date(t + 1).toISOString();
  } catch {
    return iso;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function withinHours(iso: string | undefined, ms: number): boolean {
  if (!iso) return false;
  try {
    const t = new Date(iso).getTime();
    return Date.now() - t <= ms;
  } catch {
    return false;
  }
}

/**
 * Pinned at the top of the chat scroll viewport — surfaces the
 * user prompt + the assistant bubble header for whatever's
 * currently being scrolled past. Keeps the conversation context
 * visible while the user reads through a long response.
 */
function ChatStickyHeader({
  payload,
  gezels,
}: {
  payload: {
    userMsg: TimelineMessage;
    assistantInfo:
      | { kind: 'live'; sessionId: string; slot: LiveSlot }
      | { kind: 'message'; msg: TimelineMessage };
  };
  gezels: Map<string, GezelSummary>;
}): React.ReactNode {
  const { userMsg, assistantInfo } = payload;
  const userPreview = previewifyMarkdown(userMsg.content);
  // For the live-slot case we drive the same `THINKING · Ns · K
  // tools · ····` line the streaming bubble renders. For
  // completed-message case the bubble has no live status — just
  // the author label.
  const isLive = assistantInfo.kind === 'live';
  const slotForLive = isLive ? assistantInfo.slot : null;
  const liveElapsed = useElapsedSeconds(isLive ? (slotForLive?.startedAt ?? null) : null);
  const assistantGezelId = isLive ? assistantInfo.sessionId : assistantInfo.msg.gezelId;
  const assistantGezel = gezels.get(
    isLive ? (slotForLive?.gezelId ?? '') : assistantInfo.msg.gezelId,
  );
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const assistantName = assistantGezel
    ? displayName(
        { name: assistantGezel.name, roleBasedName: assistantGezel.roleBasedName },
        roleBasedNameOnlyMode,
      )
    : 'Gezel';
  return (
    <div className="chat-sticky-header" aria-live="polite">
      <div className="chat-sticky-header-user" title={userMsg.content}>
        <span className="chat-sticky-header-author">YOU</span>
        <span className="chat-sticky-header-preview">{userPreview}</span>
      </div>
      <div className="chat-sticky-header-assistant" key={assistantGezelId}>
        <GezelIcon
          svg={assistantGezel?.icon ?? null}
          poppetje={assistantGezel?.poppetje}
          iconOverride={assistantGezel?.iconOverride}
          name={assistantName}
          size={18}
        />
        <span className="chat-sticky-header-author">{assistantName}</span>
        {!roleBasedNameOnlyMode && assistantGezel?.role && (
          <RoleSuffix role={assistantGezel.role} />
        )}
        {isLive && slotForLive && (
          <StreamingStatusLine
            failed={Boolean(slotForLive.error)}
            queued={slotForLive.queueAhead !== undefined && !segmentsHaveText(slotForLive.segments)}
            queueAhead={slotForLive.queueAhead}
            elapsedSeconds={liveElapsed}
            toolCount={countSegmentTools(slotForLive.segments)}
            wirePulseCount={slotForLive.wirePulseCount}
            {...(slotForLive.thinkingLabel ? { thinkingLabel: slotForLive.thinkingLabel } : {})}
            {...(slotForLive.thinkingProgress !== undefined
              ? { thinkingProgress: slotForLive.thinkingProgress }
              : {})}
            {...(slotForLive.thinkingDetail ? { thinkingDetail: slotForLive.thinkingDetail } : {})}
            {...(slotForLive.awaitingGezelName
              ? { awaitingGezelName: slotForLive.awaitingGezelName }
              : {})}
          />
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

/**
 * Hard cap on the characters fed to kokoro per turn. Long replies +
 * CPU contention from the LLM cascade (Meester → Voorman → Developer
 * handoffs each fire a fresh 16K-token prompt) starve the kokoro
 * inference on the main thread; a 30+ second synth just feels broken.
 * The full text is on screen anyway — narration is meant to be a
 * gist read, not the whole novel.
 */
const NARRATION_MAX_CHARS = 280;

/** Mutable cell for the in-flight synth's abort controller. */
type NarrationController = { current: AbortController | null };

/**
 * Stop the in-flight narration audio (if any) and clear the ref.
 * Safe to call when nothing is playing. Used both as a "new turn
 * starting, cut the old voice off" handler and at unmount.
 */
function stopNarration(
  audioRef: { current: HTMLAudioElement | null },
  abortRef?: NarrationController,
): void {
  // Abort any synth still in flight. Without this, a slow synth from
  // a prior turn would resolve later and start playing over the next
  // gezel's audio.
  if (abortRef?.current) {
    abortRef.current.abort();
    abortRef.current = null;
  }
  const el = audioRef.current;
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* best-effort */
  }
  audioRef.current = null;
}

/**
 * Truncate text at the closest sentence-end boundary at or before
 * {@link NARRATION_MAX_CHARS}. Falls back to a hard char cut when no
 * sentence boundary lands in range so we don't speak a 4-token blurt.
 */
function truncateForNarration(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NARRATION_MAX_CHARS) return trimmed;
  const slice = trimmed.slice(0, NARRATION_MAX_CHARS);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (sentenceEnd >= NARRATION_MAX_CHARS / 2) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }
  return `${slice.trim()}…`;
}

/**
 * Fetch a TTS rendering of `text` for the speaking gezel and start
 * playback. Stops any prior narration so we never stack overlapping
 * voices. The route resolves the voice from the gezel's frontmatter
 * when we pass `gezelId` — no need to look it up here.
 */
async function playAssistantNarration(
  text: string,
  gezelId: string,
  projectId: string,
  audioRef: { current: HTMLAudioElement | null },
  abortRef: NarrationController,
): Promise<void> {
  // Cut any prior playback AND abort any prior synth before kicking
  // off the new one. Prevents stacked audio and pile-up under load.
  stopNarration(audioRef, abortRef);
  const ctrl = new AbortController();
  abortRef.current = ctrl;

  const synthText = truncateForNarration(text);
  console.debug(
    `[narrate] synth start chars=${synthText.length} (of ${text.length}) gezelId=${gezelId}`,
  );
  let res: Awaited<ReturnType<typeof api.synthesizeSpeech>>;
  try {
    res = await api.synthesizeSpeech({
      text: synthText,
      gezelId,
      projectId,
      inline: true,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) {
      console.debug('[narrate] synth aborted (superseded by newer turn)');
      return;
    }
    console.warn('[narrate] synth failed:', err);
    return;
  }
  // If a newer turn aborted us between synth-resolve and play, drop it.
  if (ctrl.signal.aborted) {
    console.debug('[narrate] synth resolved but aborted — dropping');
    return;
  }
  console.debug(`[narrate] synth ok b64Len=${res.b64Wav?.length ?? 0} meta=`, res.meta);
  if (!res.b64Wav) {
    console.warn('[narrate] synth returned no b64Wav — narration skipped');
    return;
  }
  const audio = new Audio(`data:audio/wav;base64,${res.b64Wav}`);
  audioRef.current = audio;
  audio.addEventListener('ended', () => {
    console.debug('[narrate] playback ended');
    if (audioRef.current === audio) audioRef.current = null;
    if (abortRef.current === ctrl) abortRef.current = null;
  });
  try {
    await audio.play();
    console.debug('[narrate] playback started');
  } catch (err) {
    console.warn('[narrate] playback rejected:', err);
    if (audioRef.current === audio) audioRef.current = null;
    if (abortRef.current === ctrl) abortRef.current = null;
  }
}

function formatProviderLabel(p: ProviderName): string {
  switch (p) {
    case 'copilot':
      return 'Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Claude';
    case 'anthropic-cli':
      return 'Claude CLI';
    case 'codex-cli':
      return 'Codex CLI';
    case 'ollama':
      return 'Ollama';
    case 'llama-cpp':
      return 'On-device';
    case 'mlx':
      return 'MLX';
    case 'ds4':
      return 'DwarfStar';
    case 'remote':
      return 'Remote';
  }
}
