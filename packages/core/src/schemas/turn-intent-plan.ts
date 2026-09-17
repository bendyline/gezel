import { z } from 'zod';

/**
 * A lightweight, inspectable routing decision made before a chat turn runs.
 *
 * The plan names user-facing capabilities (a craftbook or a specialist), not
 * the conversion/runtime machinery hidden behind them. It is shared by the
 * daemon, typed client, and composer so the preview is the same decision the
 * model receives.
 */
export const TurnIntentPlanSchema = z.object({
  schemaVersion: z.literal(1),
  intent: z.enum(['conversation', 'artifact', 'implementation']),
  route: z.enum(['none', 'craftbook', 'specialist']),
  confidence: z.enum(['low', 'medium', 'high']),
  reason: z.enum(['no-strong-signal', 'exact-output-format', 'implementation-request']),
  visible: z.boolean(),
  display: z.object({
    label: z.string().min(1).max(120),
    detail: z.string().min(1).max(240).optional(),
    badges: z.array(z.string().min(1).max(40)).max(4).default([]),
  }),
  output: z
    .object({
      format: z.enum(['pptx', 'docx', 'pdf', 'mp4', 'gif']),
      label: z.string().min(1).max(80),
    })
    .optional(),
  craftbook: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      invocation: z.object({
        description: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    })
    .optional(),
  specialist: z
    .object({
      role: z.string().min(1),
      label: z.string().min(1),
    })
    .optional(),
  /** Model-facing tools the route expects to use on the current turn. */
  requiredTools: z.array(z.string().min(1)).max(4),
});
export type TurnIntentPlan = z.infer<typeof TurnIntentPlanSchema>;

export const TurnIntentPreviewRequestSchema = z.object({
  message: z.string().min(1).max(120_000),
  gezelId: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});
export type TurnIntentPreviewRequest = z.infer<typeof TurnIntentPreviewRequestSchema>;
