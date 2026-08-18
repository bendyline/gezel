import { z } from 'zod';

/**
 * Shapes shared by Gezel's managed agent-harness integrations (Codex,
 * VS Code, OpenCode, pi). Each harness owns its own tools, sandbox, approvals, and
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

/**
 * The status spine every harness card renders. Each integration `.extend()`s it
 * with its own binary-detection fields and the identity of the artifact it
 * publishes — those stay per-harness because they are what the card's copy and
 * the client's method names are about.
 */
export const LocalHarnessStatusBaseSchema = z.object({
  state: LocalHarnessSetupStateSchema,
  models: z.array(LocalHarnessModelOptionSchema),
  configuredModel: z.string().optional(),
  recommendedModel: z.string().optional(),
  reasons: z.array(z.string()),
  message: z.string().optional(),
  endpointsEnabled: z.boolean(),
  launchCommand: z.string().min(1),
  bridge: LocalHarnessBridgeSchema,
  canConfigure: z.boolean(),
  /** Whether Gezel-owned credential/state material exists and can be safely removed. */
  canRemove: z.boolean(),
  /**
   * Whether a `conflict` can be resolved by backing the foreign artifact up and
   * republishing a managed one. False for a credential conflict, which belongs
   * to another app and is only the user's to revoke.
   */
  canRepair: z.boolean(),
});
