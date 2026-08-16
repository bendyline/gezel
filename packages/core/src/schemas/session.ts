import { z } from 'zod';
import { ProjectTypeToolSchema } from './catalog.js';
import { GateCheckSchema, GateScriptRefSchema } from './gate.js';
import {
  ChatMessageSchema,
  ChatMessageToolCallSchema,
  ChatTurnErrorDetailSchema,
  ProviderNameSchema,
} from './gezel.js';
import { TerminalTimelineEntrySchema } from './terminal.js';

/**
 * Shape-of-deliverable hint passed by an asker via `ask_specialist` /
 * `ask_gezel` / `message_gezel`. When `kind: "file"` is set, the
 * specialist's consultation-mode prompt is swapped from "reply in
 * chat" to "write the deliverable to disk via writeFile, reply with
 * the path + a 2-sentence precis." Shared between the session record
 * (where it persists across follow-up turns) and the API request
 * shapes (where it enters the system).
 */
export const ExpectedDeliverableSchema = z.object({
  /**
   * `file` — the asker expects a substantive file on disk; specialist
   * writes it and replies with the path + a short precis.
   * `chat` — the asker expects a short in-chat answer; this is the
   * default for consultations when the field is omitted, but can be
   * passed explicitly to override an asker-side default.
   */
  kind: z.enum(['file', 'chat']),
  /**
   * Asker's preferred path for the file deliverable, relative to the
   * project's workspace root. Optional — specialists may write
   * elsewhere if scenario constraints require, but they must cite the
   * actual path in their chat reply.
   */
  filePath: z.string().optional(),
  /**
   * Optional completion contract for the deliverable — the SAME shape a
   * craftbook step's gate carries, so an ad-hoc handoff is gateable too
   * (the "one completion contract everywhere" goal). When set, the
   * consulted specialist's file is evaluated against these at the end of
   * their turn; on reject they're re-prompted with the verdict, exactly
   * like a craftbook completion gate.
   *
   * `checks` are cheap in-process file facts (minBytes/contains/sniff/…).
   * `scripts` are standard-scope gate scripts (e.g. `checkCitationsResolve`).
   * These are usually auto-populated server-side from the target role's
   * `gateAffinity` (a Researcher's file defaults to citation/grounding
   * gates), but an asker may also set them explicitly.
   */
  checks: z.array(GateCheckSchema).optional(),
  scripts: z.array(GateScriptRefSchema).optional(),
});
export type ExpectedDeliverable = z.infer<typeof ExpectedDeliverableSchema>;

/**
 * A chat session — one persistent thread of conversation between the user
 * and a gezel. Every session lives inside a (gezel, project) pair. The
 * `default` project fills in when the user hasn't picked one.
 *
 * Each session owns:
 *   - a transcript (messages) we maintain locally for the UI
 *   - provider-specific state so the next turn can resume server-side
 *     context (Copilot session id, OpenAI previous_response_id)
 *
 * If the provider can't resume (Copilot session expired, OpenAI response
 * past its 30-day TTL), we fall back to a fresh provider session and
 * surface a warning.
 */
export const ChatSessionSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  gezelId: z.string(),
  projectId: z.string(),
  providerName: ProviderNameSchema,
  model: z.string().optional(),
  /**
   * Why `model` was stamped onto this session. Ordinary session records keep
   * following the install's live default between rebuilds, but a capability-
   * routed task step is an explicit dispatch decision and must stay on the
   * selected model. Optional so pre-routing session files remain valid.
   */
  modelSource: z.enum(['capability-routing']).optional(),
  /** True only when this session was dispatched as deferred Night Shift work. */
  nightShift: z.boolean().optional(),
  /**
   * Pool key the session is sticky-bound to. Format
   * `${provider}:${modelId}:${replicaIdx}`. Set on the first turn for
   * local-engine sessions (llama-cpp / mlx) by the EngineRouter's
   * bind step; absent for cloud sessions and pre-rollout records.
   * When set, subsequent turns route to that specific replica so the
   * session's KV cache lives in one process — moving it would force
   * a full re-prefill. Rebound (and overwritten) only when the
   * targeted replica no longer exists (clone count reduced, etc.).
   */
  engineKey: z.string().optional(),
  reasoningEffort: z.string().optional(),
  title: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean().optional(),
  messages: z.array(ChatMessageSchema),
  providerState: z.object({
    copilotSessionId: z.string().optional(),
    openaiPreviousResponseId: z.string().optional(),
    /**
     * `anthropic-cli`-only: the session id `claude` reports in the first
     * `system` event of its stream-json output. Persisted so the next
     * turn passes `--resume <id>` and continues the same conversation.
     * Cleared when a turn fails to resume; ChatManager sets
     * `resumeFailed` and falls back to a fresh `claude` invocation.
     */
    claudeCliSessionId: z.string().optional(),
    /**
     * `codex-cli`-only: the thread id `codex exec` reports in its first
     * `thread.started` JSON event. Persisted so the next turn runs
     * `codex exec resume <thread_id>` and continues the same
     * conversation. Cleared when a turn fails to resume; ChatManager
     * sets `resumeFailed` and falls back to a fresh thread.
     */
    codexCliThreadId: z.string().optional(),
  }),
  /** Snapshot of the gezel's about.md at session creation, for drift warnings. */
  aboutSnapshot: z.string().optional(),
  /**
   * Per-session override of `config.roleBasedNameOnlyMode` ("boring mode").
   * Stamped at creation when the creating client has a fixed presentation
   * mode — the TUI always renders role-based labels, so it pins the
   * sessions it creates to `true`. This keeps the prompt (what the model
   * is told about other gezels) consistent with what that client shows;
   * without it the TUI displayed `reviewer:` while the system prompt said
   * "the voorman is Tomas", and the model naturally leaked names into
   * prose. Unset = follow the live config flag, which is what desktop
   * sessions do.
   */
  roleBasedNameOnlyMode: z.boolean().optional(),
  /** Set when the last attempted resume failed — UI surfaces a banner. */
  resumeFailed: z.boolean().optional(),
  /**
   * Plateau tracker for the ad-hoc `expectedDeliverable` gate: how many
   * consecutive rejections carried the same failing-check signature, and
   * which escalation stage the session has reached (0 none, 1 targeted-
   * edit nudge, 2 full-rewrite directive, 3 stop-retrying). Persisted so
   * the ladder survives daemon restarts (sessions are written every
   * turn anyway); cleared on approve. The craftbook-step twin lives on
   * `TaskCraftbookStep.gateAttemptHistory`.
   */
  deliverableGatePlateau: z
    .object({
      signatureHash: z.string(),
      count: z.number().int().nonnegative(),
      stage: z.number().int().min(0).max(3),
      at: z.string(),
    })
    .optional(),
  /**
   * Set when the last turn ENDED IN AN ERROR (provider error, context
   * overflow, abort, etc.) and no assistant message was persisted. Lets
   * a user who navigated away while the turn was mid-flight see "the
   * gezel tried to reply and failed" on return — without this, they'd
   * just see their own message with no indication anything happened.
   * Cleared automatically on the next successful turn.
   */
  lastTurnError: z.string().optional(),
  /**
   * Structured classification of {@link lastTurnError}. Written and cleared
   * together with it — a detail that outlives the error it describes would
   * have the UI offering to report a problem that is already fixed.
   */
  lastTurnErrorDetail: ChatTurnErrorDetailSchema.optional(),
  /** Optional task this session is scoped to, in `projectId/num` form. */
  taskRef: z.string().optional(),
  /** Optional specific step within the task. */
  stepId: z.string().optional(),
  /**
   * The most recent successful `generate_image` run in this session,
   * persisted so a follow-up message can continue where the last image
   * left off. Written by the fixed-function image path after each
   * generation; read by the follow-up classifier to thread the previous
   * prompt (and, when the model supports img2img, the previous image)
   * into the next call. Explicit persistence — not re-derived from the
   * transcript — so the contract survives restarts and message edits.
   */
  lastImageGeneration: z
    .object({
      /** The full prompt actually sent to the engine (post-composition). */
      prompt: z.string(),
      negativePrompt: z.string().optional(),
      /** Artifact path of the generated PNG, relative to the project's artifacts root. */
      artifactPath: z.string(),
      /** Engine seed reported for the generation, for composition-stable revisions. */
      seed: z.number().int().optional(),
      model: z.string().optional(),
      at: z.string(),
    })
    .optional(),
  /**
   * Optional craftbook TEMPLATE this session is editing (the explicit
   * Craftbook editor's AI-assist pane). Defaults the unified `craftbook_*`
   * tools to this book and injects its current structure into the system
   * prompt so the voorman edits it in place.
   */
  craftbookRef: z.string().optional(),
  /**
   * Set when this session was spawned by `askGezelAndWait` /
   * `ask_specialist` to answer a single question from another gezel.
   * Triggers: (a) tool-roster stripping (no team-management, no
   * onward `ask_specialist` / `ask_gezel` — a consultation specialist
   * shouldn't fan out further consultations), (b) a focused-question
   * system-prompt addendum that orients the model to "answer the one
   * thing you were invoked for", (c) `bypassQueue` on the consultation
   * turn so the asker's still-held provider slot doesn't deadlock it
   * — sibling of `inflightAsks` detection but persisted so a
   * follow-up turn on the same consultation session keeps the
   * stripped roster.
   */
  consultationMode: z.boolean().optional(),
  /**
   * Optional shape-of-deliverable hint passed by the asker when this
   * session was spawned (or messaged) by another gezel. When
   * `kind: "file"` is set, the system prompt's consultation-mode
   * addendum (chat/manager.ts) swaps its "reply in chat" guidance for
   * a "write the deliverable to disk via writeFile, reply in chat
   * with the path + a 2-sentence precis" framing. Without this hint,
   * the specialist defaults to chat-as-deliverable, which is fine for
   * short consultations but wrong for long-form reports / reviews /
   * analyses (the matrix #2 squisq-review incident).
   *
   * `filePath` is the asker's preferred path for the deliverable;
   * specialists may write elsewhere if scenario constraints require,
   * but their chat reply MUST cite the actual path used so the asker
   * can verify with `read_file`.
   *
   * Persisted on the session so follow-up turns on the same
   * consultation keep the file-deliverable framing (sibling pattern
   * to `consultationMode`).
   */
  expectedDeliverable: ExpectedDeliverableSchema.optional(),
  /**
   * The project-type script tools (e.g. checkers' `make_move`, `get_board`)
   * resolved for this session at build time, persisted so a later session
   * REBUILD can fall back to them when re-resolution from disk + catalog
   * transiently yields nothing.
   *
   * The tool→script binding lives only in the type manifest, so sessions
   * normally re-resolve it from the project's `projectType` provenance on
   * every (re)build. That resolution degrades silently to `[]` on any
   * hiccup (a `project.json` read/parse blip, a catalog fs error), and one
   * unlucky rebuild used to strip a live game's tools for the rest of the
   * session with nothing to repair it (the "make_move not available"
   * incident). This last-known copy is the repair source.
   *
   * Seeded/refreshed on a successful resolve; cleared only when the
   * project's type is genuinely un-applied. Not user-authored — managed by
   * `buildSessionOpts` via {@link reconcileScriptTools}.
   */
  scriptTools: z.array(ProjectTypeToolSchema).optional(),
  /**
   * Ollama-only: the `num_ctx` this session was built with. Captured at
   * session creation from the resolved precedence (frontmatter → config →
   * heuristic) so changing the defaults later doesn't silently retrune
   * the live session.
   */
  numCtx: z.number().int().positive().optional(),
  /**
   * Auto-recall snapshot — set once, at the start of the session's first
   * turn, after the memory search runs. Prevents re-recall on restart.
   */
  recall: z
    .object({
      at: z.string(),
      query: z.string(),
      hits: z.array(
        z.object({
          text: z.string(),
          /** 'workspace' = an index-derived code hit (path:line + snippet)
           *  and 'library' = a shared-document hit — neither is a memory, so
           *  `day` is empty for both. */
          scope: z.enum(['gezel', 'project', 'workspace', 'library']),
          day: z.string(),
          score: z.number(),
          /** Memory kind; absent on hits recalled before kinds existed. */
          kind: z.enum(['fact', 'decision', 'pref', 'status']).optional(),
        }),
      ),
    })
    .optional(),
  /**
   * Auto-summarization stamp. Set when the session has been distilled into
   * project memory. `summarizedUpTo` is `messages.length` at the time of
   * summary so a resurrected session isn't re-summarized until new turns
   * have accrued.
   */
  summarizedAt: z.string().optional(),
  summarizedUpTo: z.number().int().nonnegative().optional(),
  /**
   * `messages.length` at the time the background memory extractor
   * last ran for this session. Used only on locally-hosted stateless
   * providers (Ollama + llama-cpp) to batch extractions into
   * every-N-messages cadence instead of firing after every turn —
   * otherwise a 2B on-device model running extraction on a 14k-token
   * transcript blocks the provider queue for ~60s, which the user
   * feels as "next message is waiting forever". Cloud providers
   * (Copilot / OpenAI) extract every turn (fast + cheap) and leave
   * this field unset.
   *
   * Reset (clamped to current `messages.length`) after
   * `compactInFlight` shrinks the transcript, so the cadence doesn't
   * get stuck "already-ahead" after compaction.
   */
  extractedUpTo: z.number().int().nonnegative().optional(),
  /**
   * Telemetry for the in-flight compaction path (Ollama only). Bumped
   * every time `ChatManager.compactInFlight` collapses older messages
   * into a synthetic `compaction-summary` bubble to keep the prompt
   * under `num_ctx`. Distinct from `summarizedUpTo` (post-session
   * archival to project memory) — that path doesn't mutate
   * `messages`, while compaction does.
   */
  compactionCount: z.number().int().nonnegative().optional(),
  /** ISO timestamp of the last in-flight compaction. Drives banner UX. */
  lastCompactedAt: z.string().optional(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatSessionSummarySchema = ChatSessionSchema.pick({
  id: true,
  gezelId: true,
  projectId: true,
  providerName: true,
  model: true,
  title: true,
  createdAt: true,
  lastActivityAt: true,
  archived: true,
  // Surfaced so callers that only have the summary (e.g. the ambient-nudge
  // scheduler) can tell whether a session's last turn aborted without
  // loading the full record. Set on abort, cleared on the next successful
  // turn.
  lastTurnError: true,
  taskRef: true,
  stepId: true,
}).extend({
  /**
   * `at` of the most recent HUMAN message in the transcript — a
   * `role: 'user'` message without `from` (gezel-injected messages,
   * including the meester's ambient nudges, carry `from`). Computed at
   * list time from `messages`, not persisted on the session record.
   *
   * The ambient-nudge scheduler needs this to tell organic engagement
   * apart from the voorman answering the meester's own nudge: raw
   * `lastActivityAt` is bumped by every turn — nudge replies included —
   * so using it to reset the rapid-nudge backoff counter meant a voorman
   * who dutifully answered every check-in kept the 5-minute cadence
   * alive forever.
   */
  lastHumanActivityAt: z.string().optional(),
  /**
   * Bounded, single-line text from the newest message. Session-list surfaces
   * use this for a glanceable preview without loading the full transcript.
   */
  lastMessagePreview: z.string().max(200).optional(),
  /**
   * Gezels that have spoken in this thread, primary session owner first.
   * Optional for compatibility with older daemons and cached responses.
   */
  involvedGezelIds: z.array(z.string()).optional(),
});
export type ChatSessionSummary = z.infer<typeof ChatSessionSummarySchema>;

export const CreateChatSessionRequestSchema = z.object({
  gezelId: z.string(),
  projectId: z.string().optional(),
  taskRef: z.string().optional(),
  stepId: z.string().optional(),
  craftbookRef: z.string().optional(),
  /**
   * Pin the session's name-rendering mode instead of following
   * `config.roleBasedNameOnlyMode`. Passed by clients whose presentation
   * mode is fixed (the TUI) so prompt-side name rendering matches their
   * labels. See `ChatSessionSchema.roleBasedNameOnlyMode`.
   */
  roleBasedNameOnlyMode: z.boolean().optional(),
});
export type CreateChatSessionRequest = z.infer<typeof CreateChatSessionRequestSchema>;

export const ListChatSessionsResponseSchema = z.object({
  sessions: z.array(ChatSessionSummarySchema),
});
export type ListChatSessionsResponse = z.infer<typeof ListChatSessionsResponseSchema>;

export const SendToSessionRequestSchema = z.object({
  message: z.string().min(1),
  /**
   * Gezel ids to also deliver this message to as verbatim user messages.
   * Drives the composer's `@mention` fan-out: every mentioned gezel's
   * (gezel, same project) session receives an identical user-role bubble
   * — no `from` metadata, no CC preface. Duplicates are silently deduped
   * and the primary gezel is excluded. Capped at 10 to prevent runaway
   * fan-outs from a pathological draft.
   */
  mentions: z.array(z.string().min(1)).max(10).optional(),
  /**
   * Gezel ids to passively notify (transcript-only, no provider call).
   * Drives the project-chat voorman-CC: when a user pivots the
   * composer to a non-voorman gezel via @-mention, the project's
   * voorman id lands here so they still see the message in their
   * session timeline without being engaged. Each id resolves to (or
   * creates) the gezel's session in the same project as the primary;
   * `notifyUserMessage` appends the user-role bubble and emits a
   * `done` event so any timeline thinking-dots slot retires
   * immediately. Capped low because passive CC is a project-chat
   * convenience, not a fan-out mechanism.
   */
  passiveCcGezelIds: z.array(z.string().min(1)).max(5).optional(),
  /**
   * Mid-turn nudge. When a turn is in flight the message queues behind
   * it as usual, but contiguous queued nudges merge into ONE follow-up
   * turn when the turn ends (joined with paragraph breaks) instead of
   * running one turn each. The persisted user message carries
   * `ChatMessage.nudge` so the transcript can mark it. On an idle
   * session the flag is a no-op — the message sends as a normal turn.
   */
  nudge: z.boolean().optional(),
});
export type SendToSessionRequest = z.infer<typeof SendToSessionRequestSchema>;

export const SendToSessionResponseSchema = z.object({
  accepted: z.literal(true),
  sessionId: z.string(),
});
export type SendToSessionResponse = z.infer<typeof SendToSessionResponseSchema>;

/**
 * One pending entry in a session's mid-turn message queue, as returned
 * by `GET /api/sessions/:id/queue`. Unlike the `queue_enqueued` event's
 * 160-char `preview`, `text` is the full message body — the edit
 * affordance on ghost queue bubbles loads it lazily through this shape.
 */
export const QueuedMessageSchema = z.object({
  queueId: z.string(),
  /** Full message text (the SSE event only carries a truncated preview). */
  text: z.string(),
  preview: z.string(),
  /** ISO timestamp of when the entry was enqueued. */
  enqueuedAt: z.string(),
  /** True when the entry was queued as a mid-turn nudge (merges on drain). */
  nudge: z.boolean(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

export const ListSessionQueueResponseSchema = z.object({
  sessionId: z.string(),
  entries: z.array(QueuedMessageSchema),
});
export type ListSessionQueueResponse = z.infer<typeof ListSessionQueueResponseSchema>;

export const UpdateQueuedMessageRequestSchema = z.object({
  message: z.string().min(1),
});
export type UpdateQueuedMessageRequest = z.infer<typeof UpdateQueuedMessageRequestSchema>;

export const UpdateQueuedMessageResponseSchema = z.object({
  updated: z.literal(true),
  entry: QueuedMessageSchema,
});
export type UpdateQueuedMessageResponse = z.infer<typeof UpdateQueuedMessageResponseSchema>;

/**
 * Body for `POST /api/sessions/:id/interrupt` — cancel the in-progress
 * turn (partial reply salvaged exactly like a plain cancel) and send
 * `message` immediately, ahead of any queued entries. Response reuses
 * `SendToSessionResponseSchema` (202 accepted; reply streams over SSE).
 */
export const InterruptSessionRequestSchema = z.object({
  message: z.string().min(1),
});
export type InterruptSessionRequest = z.infer<typeof InterruptSessionRequestSchema>;

/**
 * One row in an interleaved cross-session timeline. Built by flattening
 * every session's `messages[]` and tagging each message with its parent
 * session's identity + metadata. The UI groups consecutive messages by
 * `sessionId` to draw session-boundary headers.
 *
 * `handoffFrom` is set when this message belongs to a session that was
 * spawned via `startHandoffSession` — the (gezelId, sessionId) of the
 * session that initiated the handoff. The Store resolves it by matching
 * the most recent prior session in the same project that shares this
 * session's `taskRef` but has a different `gezelId`.
 */
export const TimelineMessageSchema = z.object({
  sessionId: z.string(),
  gezelId: z.string(),
  projectId: z.string(),
  sessionTitle: z.string(),
  sessionCreatedAt: z.string(),
  sessionLastActivityAt: z.string(),
  sessionArchived: z.boolean().optional(),
  /**
   * Session-pinned provider (from `ChatSession.providerName`). Captured
   * at session creation from the gezel-override-then-config-default
   * precedence, then frozen for the life of the session. The UI compares
   * this to the live `config.provider` + `config.defaultModel` to
   * render a drift pill on bubbles whose session dispatches somewhere
   * other than the global default — without this, existing sessions
   * silently keep their original routing when the user changes defaults
   * and there's no visible cue.
   */
  sessionProviderName: ProviderNameSchema,
  /** Session-pinned model (from `ChatSession.model`). See `sessionProviderName`. */
  sessionModel: z.string().optional(),
  /**
   * Mirrors `ChatSession.lastTurnError` — set when the last turn
   * errored and nothing was persisted as an assistant message. The
   * timeline UI renders a failure banner under the session's last
   * user message so a user who navigated away during the error still
   * sees "the gezel tried to reply and failed" on reload. Populated
   * on every message that shares the session.
   */
  sessionLastTurnError: z.string().optional(),
  taskRef: z.string().optional(),
  stepId: z.string().optional(),
  handoffFrom: z.object({ gezelId: z.string(), sessionId: z.string() }).optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.string(),
  /**
   * Set when the underlying ChatMessage carries `from` — i.e. the message
   * was injected by another gezel via `messageGezel`. The timeline uses
   * this to render an inter-gezel handoff bubble.
   */
  from: z.object({ gezelId: z.string(), gezelName: z.string() }).optional(),
  /**
   * Mirrors `ChatMessage.nudge` — this user message was delivered from
   * the mid-turn queue as a nudge. The bubble renders a small chip.
   */
  nudge: z.boolean().optional(),
  /**
   * Mirrors `ChatMessage.referencedArtifacts` — validated artifact paths
   * the assistant reply mentioned. Populated on write and backfilled on
   * read for older messages that predate the parser.
   */
  referencedArtifacts: z.array(z.string()).optional(),
  /**
   * Mirrors `ChatMessage.referencedTasks` — task refs (`projectId/num`)
   * the assistant reply mentioned. Populated on write, gated on the
   * task existing.
   */
  referencedTasks: z.array(z.string()).optional(),
  /**
   * Mirrors `ChatMessage.toolCalls` — the MCP tool invocations that ran
   * during the turn that produced this assistant reply. Drives the
   * collapsible "tools that ran" expando in the timeline bubble.
   */
  toolCalls: z.array(ChatMessageToolCallSchema).optional(),
  /**
   * Mirrors `ChatMessage.intents` — phase-announcement offsets the UI
   * splices as horizontal dividers when rendering the completed reply.
   */
  intents: z
    .array(
      z.object({
        label: z.string(),
        afterChars: z.number().int().min(0),
      }),
    )
    .optional(),
  /**
   * Mirrors `ChatMessage.pendingQuestionId` — set when this assistant
   * turn called `ask_user_question`. The chat UI uses it to attach the
   * matching `PendingQuestionCard` directly under this bubble.
   */
  pendingQuestionId: z.string().optional(),
  /**
   * Mirrors `ChatMessage.warnings` — persistent banners attached to
   * the assistant turn (fabricated tool-use detection, degraded
   * provider state). The chat bubble renders them as warning banners.
   */
  warnings: z.array(z.string()).optional(),
  /**
   * Mirrors `ChatMessage.reasoning` — chain-of-thought captured from
   * `<think>` / `<reasoning>` tags. The bubble renders it behind a
   * collapsed expander.
   */
  reasoning: z.string().optional(),
  /**
   * Mirrors `ChatMessage.reasoningDurationMs` — the observed span of
   * streamed private-reasoning chunks. Omitted when the provider did
   * not expose enough timing data to measure it honestly.
   */
  reasoningDurationMs: z.number().int().nonnegative().optional(),
  /**
   * Mirrors `ChatMessage.attemptedToolCalls` — tool-call bodies the
   * salvage layer couldn't parse. The bubble renders an "Attempted
   * call" expander when present, and the empty-bubble placeholder
   * derives a "Tried to call X" summary instead of falling back to
   * the generic "No response" copy.
   */
  attemptedToolCalls: z
    .array(z.object({ body: z.string(), reason: z.string().optional() }))
    .optional(),
});
export type TimelineMessage = z.infer<typeof TimelineMessageSchema>;

export const ListTimelineResponseSchema = z.object({
  messages: z.array(TimelineMessageSchema),
  hasMore: z.boolean(),
  /** ISO `at` of the oldest message returned — pass back as `before` to page. */
  nextCursor: z.string().optional(),
  /**
   * Terminal command/output entries from per-(project, workingDir) terminal
   * threads, scoped to the same project filter as `messages`. Only the
   * project timeline endpoint populates this; global and per-gezel
   * timelines leave it absent. The UI interleaves these with `messages`
   * by `at` at render time. Adding as a sibling array (rather than
   * folding into TimelineMessage) keeps chat-only consumers from
   * paying for terminal-shaped optional fields.
   */
  terminalEntries: z.array(TerminalTimelineEntrySchema).optional(),
});
export type ListTimelineResponse = z.infer<typeof ListTimelineResponseSchema>;
