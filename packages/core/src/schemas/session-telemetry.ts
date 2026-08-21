import { z } from 'zod';

/**
 * Live per-session progress telemetry. Counters are accumulated in-memory by
 * the service while a session's turns run (streamed content, tool activity,
 * file mutations, GPU work) and reset on daemon restart — this is a runtime
 * signal for stall detection and progress UI, not durable state. The eval
 * harness reads the same shape over HTTP instead of scraping daemon logs.
 */

/**
 * Non-LLM GPU workloads a session can be waiting on. Shared with the
 * `gpu_swap` chat event's `task` field — one enum, so a new workload can't
 * light up the bubble while staying invisible to telemetry.
 */
export const SessionGpuTaskSchema = z.enum([
  'image_generation',
  'video_generation',
  'image_recognition',
]);
export type SessionGpuTask = z.infer<typeof SessionGpuTaskSchema>;

/** Coarse service-side ownership of the currently-running chat turn. */
export const SessionTurnPhaseSchema = z.enum(['preparing', 'recall', 'provider']);
export type SessionTurnPhase = z.infer<typeof SessionTurnPhaseSchema>;

export const SessionTurnTelemetrySchema = z.object({
  /** Epoch ms when the in-flight turn started. */
  startedAt: z.number(),
  phase: SessionTurnPhaseSchema,
  /** Epoch ms when `phase` last changed. */
  phaseStartedAt: z.number(),
  /** Provider requests issued by this user-visible turn, including retries. */
  providerRequestsStarted: z.number().int().nonnegative(),
  streamedContentChars: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  fileMutations: z.number().int().nonnegative(),
});
export type SessionTurnTelemetry = z.infer<typeof SessionTurnTelemetrySchema>;

export const SessionTelemetrySchema = z.object({
  sessionId: z.string(),
  gezelId: z.string(),
  projectId: z.string(),
  /** True while a send is currently running for this session. */
  inflight: z.boolean(),
  turnsStarted: z.number().int().nonnegative(),
  /** Provider requests issued across all turns in this daemon process. */
  providerRequestsStarted: z.number().int().nonnegative(),
  deltaChunks: z.number().int().nonnegative(),
  streamedContentChars: z.number().int().nonnegative(),
  wirePulses: z.number().int().nonnegative(),
  heartbeats: z.number().int().nonnegative(),
  enginePhaseEvents: z.number().int().nonnegative(),
  /**
   * `engine_phase === 'generating'` transitions — roughly one per completion
   * request the engine served (the slot-launch granularity stall logic and
   * the eval chatter threshold were calibrated against).
   */
  generationSpurts: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolArgChars: z.number().int().nonnegative(),
  fileMutations: z.number().int().nonnegative(),
  gpuEvents: z.number().int().nonnegative(),
  gpuTaskActive: SessionGpuTaskSchema.nullable(),
  /** Epoch ms of the last streamed signal (delta / pulse / heartbeat / phase). */
  lastStreamActivityAt: z.number().nullable(),
  lastToolActivityAt: z.number().nullable(),
  lastMutationAt: z.number().nullable(),
  lastGpuActivityAt: z.number().nullable(),
  /** Max of all activity timestamps — "when did ANY progress signal last fire". */
  lastProgressAt: z.number().nullable(),
  /** Counters scoped to the currently-running turn; null between turns. */
  currentTurn: SessionTurnTelemetrySchema.nullable(),
});
export type SessionTelemetry = z.infer<typeof SessionTelemetrySchema>;

export const SessionTelemetryListResponseSchema = z.object({
  /** Bumped when counter semantics change; consumers gate on it. */
  version: z.literal(1),
  capturedAt: z.number(),
  sessions: z.array(SessionTelemetrySchema),
});
export type SessionTelemetryListResponse = z.infer<typeof SessionTelemetryListResponseSchema>;
