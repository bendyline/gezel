import { z } from 'zod';

/**
 * A **lookout** is a person's standing instruction to a project: "keep a
 * lookout for X, then do Y". X is judged by the source (today a camera, whose
 * vision review answers each lookout's question); the lookout engine only
 * admits a yes and runs the actions. A gezel can propose a lookout but never
 * arm, edit, or widen one. Contract: docs/lookouts.md.
 */

export const LOOKOUT_SUBJECTS = ['person', 'cat', 'dog', 'animal', 'vehicle', 'package'] as const;
export const LookoutSubjectSchema = z.enum(LOOKOUT_SUBJECTS);
export type LookoutSubject = z.infer<typeof LookoutSubjectSchema>;

export const LookoutSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('camera'), bindingId: z.string().min(1) }),
]);
export type LookoutSource = z.infer<typeof LookoutSourceSchema>;

export const LookoutConditionSchema = z.discriminatedUnion('kind', [
  /** Anything moving. Needs no vision model. */
  z.object({ kind: z.literal('motion') }),
  /** One of a fixed set of things in view. */
  z.object({ kind: z.literal('subject'), subjects: z.array(LookoutSubjectSchema).min(1).max(6) }),
  /**
   * The person's own yes/no question about the picture. `sure` waits for a
   * yes on two separate frames of the same episode; an unsure answer counts
   * as no either way.
   */
  z.object({
    kind: z.literal('ask'),
    question: z.string().trim().min(3).max(300),
    strictness: z.enum(['normal', 'sure']).default('normal'),
  }),
]);
export type LookoutCondition = z.infer<typeof LookoutConditionSchema>;

export const LookoutSoundClipSchema = z.enum(['chime', 'alarm', 'whistle']);
export type LookoutSoundClip = z.infer<typeof LookoutSoundClipSchema>;

export const LookoutActionSchema = z.discriminatedUnion('kind', [
  /** A desktop notification (or an in-app alert while the window is open). */
  z.object({ kind: z.literal('notify') }),
  /** A short clip played on this computer's speakers. */
  z.object({ kind: z.literal('sound'), clip: LookoutSoundClipSchema.default('chime') }),
  /** A line the person wrote, spoken with on-device speech. */
  z.object({ kind: z.literal('speak'), text: z.string().trim().min(1).max(200) }),
  /** A message to the phone channel configured in Settings (ntfy, Slack, …). */
  z.object({ kind: z.literal('push') }),
  /** Mail through a bound mail connector, only to recipients the person typed. */
  z.object({
    kind: z.literal('email'),
    bindingId: z.string().min(1),
    recipients: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/, 'expected an email address'),
      )
      .min(1)
      .max(5),
  }),
  /** A gezel looks at the frames and acts on the person's instruction. */
  z.object({
    kind: z.literal('ask-gezel'),
    gezelId: z.string().min(1).optional(),
    instruction: z.string().trim().min(1).max(1000),
  }),
  /** Start a craftbook run with the episode's pictures as its input. */
  z.object({
    kind: z.literal('run-craftbook'),
    craftbookId: z.string().min(1),
    params: z.record(z.string(), z.string().max(2000)).optional(),
  }),
]);
export type LookoutAction = z.infer<typeof LookoutActionSchema>;
export type LookoutActionKind = LookoutAction['kind'];

/** Actions that reach outside this computer, counted against the outbound ceiling. */
export const LOOKOUT_OUTBOUND_ACTIONS: ReadonlySet<LookoutActionKind> = new Set(['push', 'email']);
/** Actions that start AI work, counted against the follow-up limits. */
export const LOOKOUT_FOLLOW_UP_ACTIONS: ReadonlySet<LookoutActionKind> = new Set([
  'ask-gezel',
  'run-craftbook',
]);

export const LookoutLimitsSchema = z.object({
  /** Quiet time after a firing before the same lookout may fire again. */
  cooldownMinutes: z.number().int().min(0).max(1440).default(10),
  maxPerDay: z.number().int().min(1).max(200).default(12),
  /** Ask-a-gezel and run-a-craftbook actions per day. */
  followUpsPerDay: z.number().int().min(0).max(50).default(4),
});
export type LookoutLimits = z.infer<typeof LookoutLimitsSchema>;

const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

/** Local-time window; `from` later than `to` wraps past midnight. */
export const LookoutActiveHoursSchema = z.object({
  from: ClockTimeSchema,
  to: ClockTimeSchema,
});
export type LookoutActiveHours = z.infer<typeof LookoutActiveHoursSchema>;

export const LookoutCreatedBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person') }),
  z.object({
    kind: z.literal('gezel'),
    gezelId: z.string(),
    questionId: z.string().optional(),
  }),
]);
export type LookoutCreatedBy = z.infer<typeof LookoutCreatedBySchema>;

export const LookoutStateSchema = z.enum(['proposed', 'armed', 'retired']);
export type LookoutState = z.infer<typeof LookoutStateSchema>;

export const LookoutSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  /** The person's on/off switch. A `proposed` lookout is never enabled. */
  enabled: z.boolean(),
  state: LookoutStateSchema,
  source: LookoutSourceSchema,
  condition: LookoutConditionSchema,
  actions: z.array(LookoutActionSchema).min(1).max(8),
  limits: LookoutLimitsSchema.default({ cooldownMinutes: 10, maxPerDay: 12, followUpsPerDay: 4 }),
  activeHours: LookoutActiveHoursSchema.optional(),
  snoozedUntil: z.string().optional(),
  createdBy: LookoutCreatedBySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lookout = z.infer<typeof LookoutSchema>;

export const LookoutsFileSchema = z.object({
  version: z.literal(1),
  lookouts: z.array(LookoutSchema),
});
export type LookoutsFile = z.infer<typeof LookoutsFileSchema>;

/** Fields a person (or a gezel's proposal) supplies; the rest is the daemon's. */
export const LookoutInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  source: LookoutSourceSchema,
  condition: LookoutConditionSchema,
  actions: z.array(LookoutActionSchema).min(1).max(8),
  limits: LookoutLimitsSchema.partial().optional(),
  activeHours: LookoutActiveHoursSchema.nullable().optional(),
});
export type LookoutInput = z.infer<typeof LookoutInputSchema>;

export const LookoutUpdateSchema = LookoutInputSchema.partial().extend({
  enabled: z.boolean().optional(),
});
export type LookoutUpdate = z.infer<typeof LookoutUpdateSchema>;

export const LookoutActionOutcomeSchema = z.object({
  action: z.string(),
  status: z.enum(['done', 'held', 'failed', 'skipped']),
  /** Plain-language reason for anything other than `done`. */
  reason: z.string().optional(),
});
export type LookoutActionOutcome = z.infer<typeof LookoutActionOutcomeSchema>;

export const LookoutFiringSchema = z.object({
  id: z.string(),
  lookoutId: z.string(),
  lookoutName: z.string(),
  projectId: z.string(),
  bindingId: z.string(),
  episodeId: z.string(),
  at: z.string(),
  /** Fired from the Test key; counts toward no limit. */
  test: z.boolean().optional(),
  /** Artifact-relative keyframe the decision was made on. */
  frame: z.string().optional(),
  /** Sanitized one-line camera summary (untrusted). */
  summary: z.string().optional(),
  outcomes: z.array(LookoutActionOutcomeSchema),
  feedback: z.literal('false-alarm').optional(),
  /** The daemon stopped while this firing's actions were running. */
  interrupted: z.boolean().optional(),
  /** False until every action has settled. */
  settled: z.boolean().default(true),
});
export type LookoutFiring = z.infer<typeof LookoutFiringSchema>;

export const LookoutCounterSchema = z.object({
  /** Local calendar day the counts belong to (`YYYY-MM-DD`). */
  day: z.string(),
  fired: z.number().int().nonnegative().default(0),
  followUps: z.number().int().nonnegative().default(0),
  lastFiredAt: z.string().optional(),
  /** Episodes this lookout already fired for (most recent last). */
  firedEpisodes: z.array(z.string()).default([]),
  /** `sure` lookouts: yes answers seen per episode so far. */
  yesByEpisode: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type LookoutCounter = z.infer<typeof LookoutCounterSchema>;

export const LookoutStateFileSchema = z.object({
  version: z.literal(1),
  counters: z.record(z.string(), LookoutCounterSchema).default({}),
  /** Newest last; trimmed to {@link LOOKOUT_FIRING_LOG_LIMIT}. */
  firings: z.array(LookoutFiringSchema).default([]),
});
export type LookoutStateFile = z.infer<typeof LookoutStateFileSchema>;

export const LOOKOUT_FIRING_LOG_LIMIT = 25;

/** A question the camera's review answers on a lookout's behalf. */
export interface LookoutQuestion {
  /** The lookout id; the review's `answers` are keyed by it. */
  id: string;
  question: string;
}

/** A lookout and its recent firings, as the Lookouts tab shows them. */
export const LookoutWithStatusSchema = LookoutSchema.extend({
  firedToday: z.number().int().nonnegative(),
  lastFiredAt: z.string().optional(),
});
export type LookoutWithStatus = z.infer<typeof LookoutWithStatusSchema>;

export const LookoutListResponseSchema = z.object({
  lookouts: z.array(LookoutWithStatusSchema),
  firings: z.array(LookoutFiringSchema),
  paused: z.boolean(),
});
export type LookoutListResponse = z.infer<typeof LookoutListResponseSchema>;
