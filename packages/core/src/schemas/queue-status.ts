import { z } from 'zod';
import type { DeviceHealthStatusSnapshot } from '../native/device-health.js';
import { ProviderNameSchema } from './gezel.js';
import { QueuedMessageSchema } from './session.js';

/**
 * Wire shapes for `GET /api/queues`. The daemon and the phone runtime both
 * serve this response, and the provider queue's `describe()` returns
 * {@link ProviderQueueDescription} directly, so the scheduler, the routes
 * and the client share one definition. Imported as
 * `@bendyline/gezel/queue-status`; the main barrel does not re-export it.
 */

export const QueueLaneSchema = z.enum(['interactive', 'background']);
export type QueueLane = z.infer<typeof QueueLaneSchema>;

/**
 * Providers that own a local queue. `remote` is excluded: its queue lives
 * on the paired daemon that serves it.
 */
export const QueueProviderNameSchema = ProviderNameSchema.exclude(['remote']);
export type QueueProviderName = z.infer<typeof QueueProviderNameSchema>;

const QueueItemOwnerShape = {
  sessionId: z.string().optional(),
  gezelId: z.string().optional(),
  /** Project that owns this queued work, when it is session-scoped. */
  projectId: z.string().optional(),
  /**
   * Engine the work targets, for a queue that serves several providers
   * (a phone runs one generation at a time across all of them).
   */
  provider: z.string().optional(),
  /** Display owner for service work that is not attached to a persisted gezel. */
  actorLabel: z.string().optional(),
  /**
   * Short, human-readable label describing what this turn is doing
   * — e.g. "atari/3 · plan", "summary", "icon · Maya". Set by the
   * call site; surfaced verbatim in the QueueMeter.
   */
  job: z.string().optional(),
};

export const ProviderQueueActiveItemSchema = z.object({
  ...QueueItemOwnerShape,
  runningForMs: z.number(),
});
export type ProviderQueueActiveItem = z.infer<typeof ProviderQueueActiveItemSchema>;

export const ProviderQueuePendingItemSchema = z.object({
  /**
   * Queue-internal id used to target this entry from the cancel and
   * reorder routes. Stable for the lifetime of the entry; once the
   * entry runs or is cancelled, the id is gone.
   */
  id: z.number(),
  lane: QueueLaneSchema,
  ...QueueItemOwnerShape,
  /** Housekeeping work that yields until the provider is otherwise idle. */
  ambient: z.boolean().optional(),
  waitedMs: z.number(),
});
export type ProviderQueuePendingItem = z.infer<typeof ProviderQueuePendingItemSchema>;

/** What a provider queue reports about itself (`ProviderQueue.describe()`). */
export const ProviderQueueDescriptionSchema = z.object({
  running: z.number(),
  /**
   * In-flight slots split by lane. Chat turns take the `interactive`
   * lane; one-shot housekeeping (index enrichment, memory extraction,
   * digests) takes `background`. Read `runningInteractive` — not
   * `running` — for anything that calls the number a "chat".
   */
  runningInteractive: z.number(),
  runningBackground: z.number(),
  queuedInteractive: z.number(),
  queuedBackground: z.number(),
  /** Ambient jobs currently held until the provider has been quiet long enough. */
  ambientHeld: z.number(),
  concurrency: z.number(),
  /**
   * Cap on how many of the `concurrency` slots can be held by the
   * interactive lane at once. Equal to `concurrency` when no cap is
   * configured (cloud providers). On a local engine it equals
   * `maxConcurrency` — chats may fill every slot the engine owns; it is
   * `backgroundConcurrency` that is held one below, so a live turn can
   * always start.
   */
  interactiveConcurrency: z.number(),
  /**
   * Cap on how many slots the background lane can hold — the dual of
   * `interactiveConcurrency`. `concurrency - backgroundConcurrency` is the
   * headroom reserved for interactive turns under the adaptive batched-
   * inference policy.
   */
  backgroundConcurrency: z.number(),
  active: z.array(ProviderQueueActiveItemSchema),
  pending: z.array(ProviderQueuePendingItemSchema),
});
export type ProviderQueueDescription = z.infer<typeof ProviderQueueDescriptionSchema>;

/**
 * Per-provider queue state on the wire. The lane split and caps are
 * optional because brokers older than the lane split omit them.
 */
export const ProviderQueueStateSchema = ProviderQueueDescriptionSchema.partial({
  runningInteractive: true,
  runningBackground: true,
  ambientHeld: true,
  interactiveConcurrency: true,
  backgroundConcurrency: true,
}).extend({
  /**
   * The engine's slot count: `--parallel N` for llama-cpp,
   * `--max-concurrency N` for MLX, 1 for a cloud or external server whose
   * width we don't control (and for a phone). This is the same number the
   * capacity broker reserved KV for — what we hold memory for is what can
   * generate.
   *
   * The denominator for "in flight"; prefer it over `concurrency`, which
   * carries an extra logical lane so a mid-turn one-shot can enter the
   * queue without deadlocking behind the turn awaiting it.
   */
  maxConcurrency: z.number().optional(),
});
export type ProviderQueueState = z.infer<typeof ProviderQueueStateSchema>;

/** One side of the pending-handoff split. */
export const TaskHandoffBucketSchema = z.object({
  count: z.number(),
  byGezel: z.record(z.string(), z.number()),
});
export type TaskHandoffBucket = z.infer<typeof TaskHandoffBucketSchema>;

export const TaskHandoffHoldReasonSchema = z.enum([
  'engagement-off',
  'engagement-paused',
  'provider-busy',
]);
export type TaskHandoffHoldReason = z.infer<typeof TaskHandoffHoldReasonSchema>;

/**
 * TaskRunner pending-handoff summary — a separate layer from the
 * provider queue (phase handoffs that haven't been dispatched yet).
 */
export const TaskRunnerStateSchema = z.object({
  /** Every queued handoff, whatever is holding it. */
  pendingCount: z.number(),
  pendingByGezel: z.record(z.string(), z.number()),
  pendingByProject: z.record(z.string(), z.number()),
  /**
   * Handoffs waiting on a free provider slot — a real backlog, and the
   * only bucket the header's Tasks chip counts. Optional so a UI newer
   * than its daemon degrades to the `pending*` totals.
   */
  dispatchable: TaskHandoffBucketSchema.optional(),
  /**
   * Handoffs parked until the next Night Shift window. Not a backlog:
   * nobody is waiting on them and there is nothing to act on, so they
   * stay out of the header badge and live in the Night Shift menu.
   */
  scheduled: TaskHandoffBucketSchema.optional(),
  /** Why `dispatchable` work isn't moving. Absent when it is. */
  holdReason: TaskHandoffHoldReasonSchema.optional(),
  /** Night Shift state, for dating the `scheduled` bucket. */
  nightShift: z
    .object({
      active: z.boolean(),
      /** ISO time the next window opens; null when Night Shift is off. */
      opensAt: z.string().nullable(),
      /** True while night work is held by the cloud quota reserve. */
      quotaHold: z.boolean().optional(),
    })
    .optional(),
});
export type TaskRunnerState = z.infer<typeof TaskRunnerStateSchema>;

export const SessionQueueEntrySchema = QueuedMessageSchema.omit({ text: true }).extend({
  /** Queued as a mid-turn nudge — merges with adjacent nudges on drain. */
  nudge: z.boolean().optional(),
});
export type SessionQueueEntry = z.infer<typeof SessionQueueEntrySchema>;

/**
 * Per-session pending messages. Distinct from a provider queue's
 * `pending` — those are at the provider level (rate-limiting across
 * sessions); these serialize messages within a single conversation.
 */
export const SessionQueueStateSchema = z.object({
  sessionId: z.string(),
  /** Session-pinned provider, used to attribute this backlog to an engine. */
  providerName: ProviderNameSchema.optional(),
  depth: z.number(),
  nextPreview: z.string(),
  entries: z.array(SessionQueueEntrySchema),
});
export type SessionQueueState = z.infer<typeof SessionQueueStateSchema>;

export const ProviderCacheStatsResponseSchema = z.object({
  providerName: z.string(),
  totalBytes: z.number(),
  budgetBytes: z.number(),
  /** RAM-aware suggested budget for this machine (override-independent). */
  defaultBudgetBytes: z.number().optional(),
  /** Physical system RAM — upper bound for the Settings budget slider. */
  systemRamBytes: z.number().optional(),
  /** All entries, including reusable `prefix-*` entries; legacy field name. */
  warmSessionCount: z.number(),
  hits: z.number(),
  misses: z.number(),
  recentHitRate: z.number(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      gezelId: z.string().optional(),
      tokenCount: z.number(),
      bytes: z.number(),
      lastUsedAt: z.number(),
      evictionPriority: z.enum(['low', 'normal']),
    }),
  ),
});
export type ProviderCacheStatsResponse = z.infer<typeof ProviderCacheStatsResponseSchema>;

export const ClaudeCliPoolViewSchema = z.object({
  size: z.number(),
  poolSize: z.number(),
  workers: z.array(
    z.object({
      sessionId: z.string(),
      gezelId: z.string(),
      gezelName: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      idle: z.boolean(),
      alive: z.boolean(),
      lastUsedAt: z.number(),
      claudeSessionId: z.string().nullable(),
    }),
  ),
});
export type ClaudeCliPoolView = z.infer<typeof ClaudeCliPoolViewSchema>;

export const QueueStatusResponseSchema = z.object({
  providers: z.partialRecord(QueueProviderNameSchema, ProviderQueueStateSchema),
  taskRunner: TaskRunnerStateSchema,
  /** Per-session queued messages keyed implicitly by `sessionId` inside each entry. */
  sessions: z.array(SessionQueueStateSchema),
  /**
   * Per-provider prompt-cache stats. Empty array when no local provider
   * has been initialized or no controller is wired (always, on a phone).
   * Entries may represent chat-specific state or reusable `prefix-*`
   * state; renderers must use the included session ids when they need to
   * distinguish the two.
   */
  cache: z.array(ProviderCacheStatsResponseSchema),
  /** Latest normalized accelerator health used by the local-engine pill. */
  deviceHealth: z
    .custom<DeviceHealthStatusSnapshot>((value) => typeof value === 'object' && value !== null)
    .optional(),
  /**
   * Claude CLI worker pool snapshot when the `anthropic-cli` provider
   * has been initialized. Drives the header `ClaudeCliPoolPill`.
   */
  anthropicCliPool: ClaudeCliPoolViewSchema.optional(),
  /** Server clock at the time this snapshot was taken (ISO 8601). */
  at: z.string(),
});
export type QueueStatusResponse = z.infer<typeof QueueStatusResponseSchema>;
