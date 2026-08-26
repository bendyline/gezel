import type {
  ChatSessionSource,
  ChatTurnErrorDetail,
  ProviderName,
  SessionGpuTask,
} from '@bendyline/gezel';
import type { InlineWarning, ToolActivity } from './chat-bubbles.js';

/**
 * One unit of in-flight assistant activity. The streaming bubble
 * renders these in DOM order so tool calls appear inline with the
 * surrounding prose ("here's what I read · here's what I wrote ·
 * now I'm going to write this") instead of all stacked at the top
 * of the bubble. Built by appending each `delta` / `tool` event in
 * arrival order.
 */
export type LiveSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; tool: ToolActivity }
  | { kind: 'intent'; label: string };

/**
 * Live "growing" terminal output bubble. Mirrors `LiveSlot`'s
 * mutable-store shape but is scoped to a terminal `runId` instead
 * of a chat sessionId. One
 * slot per in-flight `runId`; created by `runStarted` SSE events,
 * grown by `outputChunk` events, dropped when the final `message`
 * event arrives carrying the matching `runId`.
 */
export interface TerminalLiveSlot {
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

export interface LiveSlot {
  gezelId: string;
  projectId: string;
  /** User-facing subject for an ephemeral one-shot (for example a file being indexed). */
  activity?: string;
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
  /** External owner for a live read-only thread. */
  sessionSource?: ChatSessionSource;
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

export function liveStatusLabel(
  slot: Pick<LiveSlot, 'activity' | 'thinkingLabel'>,
): string | undefined {
  const activity = slot.activity?.trim();
  const phase = slot.thinkingLabel?.trim();
  if (!activity) return phase || undefined;
  if (!phase || phase === activity) return activity;
  return `${activity} · ${phase}`;
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

/** Whether any text segment carries non-empty content — used to
 *  decide whether the streaming-status line should read "queued"
 *  (queue acknowledged, no tokens yet) vs the regular thinking
 *  state (queue acknowledged AND tokens have arrived). */
export function segmentsHaveText(segments: LiveSegment[]): boolean {
  for (const s of segments) {
    if (s.kind === 'text' && s.content.length > 0) return true;
  }
  return false;
}

/** Count tool segments — replaces the old `toolActivity.length`
 *  shorthand from when tools and text lived in separate fields. */
export function countSegmentTools(segments: LiveSegment[]): number {
  let n = 0;
  for (const s of segments) if (s.kind === 'tool') n++;
  return n;
}
