import { z } from 'zod';

/**
 * Shapes shared by Gezel's managed agent-harness integrations (Codex,
 * OpenCode). Each harness owns its own tools, sandbox, approvals, and
 * conversation loop; Gezel supplies inference over an authenticated loopback
 * bridge, plus a managed config file it alone writes.
 *
 * The per-harness modules re-export these under their own names so the
 * published API of each integration stays independently documented.
 */

/** A gezel or raw local model that can safely sit behind a harness tool loop. */
export const LocalHarnessModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(['gezel', 'model']).default('model'),
  provider: z.string().min(1),
  /** Stable gezel id for persona-backed entries. Absent on raw-model entries. */
  gezelId: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  /** Human-readable name of the effective inference model behind a gezel. */
  modelLabel: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
});
export type LocalHarnessModelOption = z.infer<typeof LocalHarnessModelOptionSchema>;

export const LocalHarnessSetupStateSchema = z.enum([
  'not-configured',
  'configured',
  'update-needed',
  'conflict',
  'unavailable',
]);
export type LocalHarnessSetupState = z.infer<typeof LocalHarnessSetupStateSchema>;

/** Address of the authenticated plain-HTTP loopback listener a harness uses. */
export const LocalHarnessBridgeSchema = z.object({
  baseUrl: z.string().url(),
  listening: z.boolean(),
  port: z.number().int().nonnegative(),
});
export type LocalHarnessBridge = z.infer<typeof LocalHarnessBridgeSchema>;
