import { z } from 'zod';
import {
  LocalHarnessBridgeSchema,
  LocalHarnessModelOptionSchema,
  LocalHarnessSetupStateSchema,
} from './local-harness.js';

/** A gezel or raw local model that can safely sit behind Codex's tool loop. */
export const CodexSetupModelOptionSchema = LocalHarnessModelOptionSchema;
export type CodexSetupModelOption = z.infer<typeof CodexSetupModelOptionSchema>;

export const CodexSetupStateSchema = LocalHarnessSetupStateSchema;
export type CodexSetupState = z.infer<typeof CodexSetupStateSchema>;

/**
 * First-party Settings status for the Gezel-owned Codex profile and its
 * authenticated loopback inference bridge. Secrets are intentionally absent.
 */
export const CodexSetupStatusResponseSchema = z.object({
  state: CodexSetupStateSchema,
  models: z.array(CodexSetupModelOptionSchema),
  configuredModel: z.string().optional(),
  recommendedModel: z.string().optional(),
  reasons: z.array(z.string()),
  message: z.string().optional(),
  codexInstalled: z.boolean(),
  codexVersion: z.string().optional(),
  codexPath: z.string().optional(),
  endpointsEnabled: z.boolean(),
  profileName: z.string().min(1),
  profilePath: z.string().min(1),
  launchCommand: z.string().min(1),
  bridge: LocalHarnessBridgeSchema,
  canConfigure: z.boolean(),
  /** Whether Gezel-owned credential/state material exists and can be safely removed. */
  canRemove: z.boolean(),
  /**
   * Whether a `conflict` can be resolved by backing the foreign profile up and
   * republishing a managed one. False for a credential conflict, which belongs
   * to another app and is only the user's to revoke.
   */
  canRepair: z.boolean(),
  /**
   * Where a conflicting profile was preserved. Present only on the response of
   * the repairing request that moved it.
   */
  profileBackupPath: z.string().min(1).optional(),
});
export type CodexSetupStatusResponse = z.infer<typeof CodexSetupStatusResponseSchema>;

export const ConfigureCodexRequestSchema = z.object({
  model: z.string().min(1),
  /**
   * Copy a conflicting Codex profile to a `.backup` sibling and replace it with
   * a managed one. Rejected unless the status reports `canRepair`.
   */
  backupConflictingProfile: z.boolean().optional(),
});
export type ConfigureCodexRequest = z.infer<typeof ConfigureCodexRequestSchema>;
