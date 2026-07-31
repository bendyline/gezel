import { z } from 'zod';
import { TaskCronOverlapSchema } from './task.js';

/**
 * Suggested Night Work — the normalized view of "recurring craftbook runs
 * this project could be doing", unioned from two sources and surfaced as
 * one toggle list:
 *
 *   - `gezel-template`: a roster gezel resolves (via `templateId`
 *     provenance, or role-name fuzzy match) to a gilde gezel-template
 *     whose `suggestedCraftbooks` recommends work — "your Chief Security
 *     Officer suggests a nightly Security Code Review".
 *   - `project-type`: the adopted project type's `schedules[]`, already
 *     materialized at adoption as consent-gated hosts.
 *
 * Gezel-sourced items are VIRTUAL until enabled — enabling materializes a
 * spawn-host task stamped with the `gezel-suggested-craftbook` origin;
 * disabling pauses it; re-enabling resurrects the same host. Project-type
 * items reflect their existing host's status. The `key` is the stable
 * toggle/dismiss identity and is deliberately independent of the
 * sponsoring gezel — swap one CSO for another from the same template and
 * the decision carries over.
 */

export const SuggestedWorkSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gezel-template'),
    templateId: z.string(),
    /** Roster gezel currently sponsoring this suggestion (resolved server-side). */
    gezelId: z.string().optional(),
    gezelName: z.string().optional(),
    role: z.string().optional(),
  }),
  z.object({
    kind: z.literal('project-type'),
    typeId: z.string(),
    /** Schedule identity within the type — matches `Task.origin.scheduleKey`. */
    scheduleKey: z.string(),
  }),
]);
export type SuggestedWorkSource = z.infer<typeof SuggestedWorkSourceSchema>;

/**
 * - `suggested`: virtual — no host task exists (or it was deleted)
 * - `enabled`:   host task exists and is active
 * - `paused`:    host task exists and is paused (incl. a project-type
 *                'ask' host still awaiting approval — see
 *                `pendingQuestionId`)
 * - `dismissed`: virtual and on the project's dismissal list
 */
export const SuggestedWorkStateSchema = z.enum(['suggested', 'enabled', 'paused', 'dismissed']);
export type SuggestedWorkState = z.infer<typeof SuggestedWorkStateSchema>;

export const SuggestedWorkItemSchema = z.object({
  /**
   * Stable toggle/dismiss/dedup identity:
   * `gezel-template:<templateId>:<craftbookId>[#N]` or
   * `project-type:<typeId>:<scheduleKey>`.
   */
  key: z.string(),
  source: SuggestedWorkSourceSchema,
  craftbookId: z.string(),
  craftbookName: z.string().optional(),
  description: z.string().optional(),
  /** Suggestion author's one-liner for the toggle row. */
  reason: z.string().optional(),
  runMode: z.enum(['night-shift', 'scheduled']),
  /** Present iff runMode === 'scheduled' (night-shift hosts use an internal heartbeat). */
  cron: z.string().optional(),
  overlap: TaskCronOverlapSchema.optional(),
  /** The resolved craftbook's param schema — drives the enable form. */
  paramSchema: z.record(z.string(), z.unknown()).optional(),
  /** Suggestion-supplied param defaults (seed the enable form / children). */
  params: z.record(z.string(), z.string()).optional(),
  state: SuggestedWorkStateSchema,
  /** Set when a host task exists (enabled or paused). */
  taskRef: z.string().optional(),
  /** Pending schedule-approval Question on a project-type 'ask' host. */
  pendingQuestionId: z.string().optional(),
  /**
   * True when the item exists only because an origin-matched host is on
   * disk — its sponsor left the roster (or the project type changed).
   * The off-switch must never disappear.
   */
  orphaned: z.boolean().optional(),
});
export type SuggestedWorkItem = z.infer<typeof SuggestedWorkItemSchema>;

export const SuggestedWorkResponseSchema = z.object({
  items: z.array(SuggestedWorkItemSchema),
});
export type SuggestedWorkResponse = z.infer<typeof SuggestedWorkResponseSchema>;

export const EnableSuggestedWorkRequestSchema = z.object({
  key: z.string(),
  /** Param values captured by the enable form; copied to spawned children. */
  params: z.record(z.string(), z.string()).optional(),
});
export type EnableSuggestedWorkRequest = z.infer<typeof EnableSuggestedWorkRequestSchema>;

export const DisableSuggestedWorkRequestSchema = z.object({ key: z.string() });
export type DisableSuggestedWorkRequest = z.infer<typeof DisableSuggestedWorkRequestSchema>;

export const DismissSuggestedWorkRequestSchema = z.object({
  key: z.string(),
  dismissed: z.boolean(),
});
export type DismissSuggestedWorkRequest = z.infer<typeof DismissSuggestedWorkRequestSchema>;
