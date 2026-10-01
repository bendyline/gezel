import { z } from 'zod';

/**
 * Responsiveness telemetry — the wire shapes for `GET /api/system/perf`
 * (what the daemon's main thread has been doing) and
 * `POST /api/system/perf/client` (what the renderer measured on its side).
 *
 * Local-only diagnostics: nothing here leaves the machine, and none of it is
 * part of the privacy-bounded `/api/system/diagnostics` report.
 */

/** A slice of daemon work — an HTTP request or a named background job. */
export const PerfWorkSchema = z.object({
  label: z.string(),
  durationMs: z.number().nonnegative(),
});
export type PerfWork = z.infer<typeof PerfWorkSchema>;

/** One observed block of the daemon's main thread. */
export const PerfStallSchema = z.object({
  /** ISO time the main thread last showed signs of life before the block. */
  at: z.string(),
  durationMs: z.number().nonnegative(),
  /**
   * Work that was running while the thread was blocked, longest first. A
   * suspect list, not a verdict: a request waiting on the blocked thread
   * shows up here too. The CPU profile is the verdict.
   */
  during: z.array(PerfWorkSchema),
  /** File name under `logs/perf/` when a CPU profile of the block was saved. */
  profile: z.string().optional(),
});
export type PerfStall = z.infer<typeof PerfStallSchema>;

export const PerfSlowRequestSchema = z.object({
  at: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number().int(),
  durationMs: z.number().nonnegative(),
});
export type PerfSlowRequest = z.infer<typeof PerfSlowRequestSchema>;

export const ClientPerfRequestSchema = z.object({
  method: z.string().max(16),
  path: z.string().max(300),
  /** Time until response headers, as the renderer saw it. */
  ms: z.number().nonnegative(),
  /** The daemon's own handling time from `Server-Timing`, when it sent one. */
  serverMs: z.number().nonnegative().optional(),
});
export type ClientPerfRequest = z.infer<typeof ClientPerfRequestSchema>;

export const ClientLongTasksSchema = z.object({
  count: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});
export type ClientLongTasks = z.infer<typeof ClientLongTasksSchema>;

/**
 * What the renderer measured. `navigation`: one move between views, from the
 * click to the moment the new view stopped fetching. `long-task`: a renderer
 * main-thread block outside any navigation.
 */
export const ClientPerfReportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('navigation'),
    view: z.string().max(200),
    /** Click to first frame of the new view (chunk load + first render). */
    firstFrameMs: z.number().nonnegative(),
    /** Click to the last API response the new view waited on. */
    settledMs: z.number().nonnegative(),
    /** True when the view was still fetching when measurement gave up. */
    unsettled: z.boolean().optional(),
    requests: z.number().int().nonnegative(),
    slowest: z.array(ClientPerfRequestSchema).max(5),
    longTasks: ClientLongTasksSchema,
  }),
  z.object({
    kind: z.literal('long-task'),
    view: z.string().max(200),
    durationMs: z.number().nonnegative(),
    /** The script Chromium blamed for the frame, when it named one. */
    source: z.string().max(300).optional(),
  }),
]);
export type ClientPerfReport = z.infer<typeof ClientPerfReportSchema>;

export const PerfSnapshotSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  /** Whether a CPU profile is being recorded so the next stall can be explained. */
  profiling: z.boolean(),
  /** Event-loop delay over the current sampling window (reset every few minutes). */
  eventLoopDelay: z
    .object({
      windowStartedAt: z.string(),
      p50Ms: z.number(),
      p99Ms: z.number(),
      maxMs: z.number(),
    })
    .nullable(),
  stalls: z.array(PerfStallSchema),
  slowRequests: z.array(PerfSlowRequestSchema),
  inflight: z.array(PerfWorkSchema),
  clientReports: z.array(z.object({ receivedAt: z.string(), report: ClientPerfReportSchema })),
});
export type PerfSnapshot = z.infer<typeof PerfSnapshotSchema>;
