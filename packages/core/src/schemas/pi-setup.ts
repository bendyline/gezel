import { z } from 'zod';
import {
  LocalHarnessModelOptionSchema,
  LocalHarnessSetupStateSchema,
  LocalHarnessStatusBaseSchema,
} from './local-harness.js';

/** A gezel or raw local model that can safely sit behind pi's tool loop. */
export const PiSetupModelOptionSchema = LocalHarnessModelOptionSchema;
export type PiSetupModelOption = z.infer<typeof PiSetupModelOptionSchema>;

export const PiSetupStateSchema = LocalHarnessSetupStateSchema;
export type PiSetupState = z.infer<typeof PiSetupStateSchema>;

export const PiSetupExtensionStateSchema = z.enum([
  'not-installed',
  'installed',
  /** Installed and Gezel-owned, but its contents no longer match this install. */
  'stale',
  /** A file of the same name exists that this Gezel install did not write. */
  'conflict',
  /** pi is not installed here, so there is nowhere to put the extension. */
  'unsupported',
]);
export type PiSetupExtensionState = z.infer<typeof PiSetupExtensionStateSchema>;

/**
 * The optional copy of Gezel's extension inside pi's own agent directory, so a
 * bare `pi` offers the crew without the launch command. It is the one artifact
 * Gezel places outside its own home, so it carries an ownership marker and is
 * never overwritten or deleted unless this install wrote it.
 */
export const PiSetupExtensionSchema = z.object({
  state: PiSetupExtensionStateSchema,
  /** Where the installed copy lives, or would live. */
  path: z.string().min(1).optional(),
  /**
   * pi's resolved agent directory and how Gezel found it. Surfaced because a
   * `PI_CODING_AGENT_DIR` exported only in the user's login shell is invisible
   * to the daemon, and an install into the wrong root fails silently.
   */
  agentDir: z.string().min(1).optional(),
  agentDirSource: z.enum(['override', 'env', 'default']).optional(),
  canInstall: z.boolean(),
  canRemove: z.boolean(),
  /** Whether a foreign file may be backed up and replaced. */
  canReplace: z.boolean(),
  message: z.string().optional(),
});
export type PiSetupExtension = z.infer<typeof PiSetupExtensionSchema>;

/**
 * First-party Settings status for the Gezel-owned pi extension, its model
 * roster, and the authenticated loopback inference bridge behind them. Secrets
 * are intentionally absent — the extension reads the credential by path.
 */
export const PiSetupStatusResponseSchema = LocalHarnessStatusBaseSchema.extend({
  piInstalled: z.boolean(),
  piVersion: z.string().optional(),
  piPath: z.string().optional(),
  /** Provider id registered with pi; also the `<provider>/<model>` prefix. */
  providerId: z.string().min(1),
  /** The Gezel-owned model roster the extension reads at run time. */
  configPath: z.string().min(1),
  /** The Gezel-owned extension file the launch command points at. */
  extensionPath: z.string().min(1),
  extension: PiSetupExtensionSchema,
  /**
   * Where a conflicting roster was preserved. Present only on the response of
   * the repairing request that moved it.
   */
  configBackupPath: z.string().min(1).optional(),
  /**
   * Where a conflicting extension file was preserved. Present only on the
   * response of the replacing request that moved it.
   */
  extensionBackupPath: z.string().min(1).optional(),
});
export type PiSetupStatusResponse = z.infer<typeof PiSetupStatusResponseSchema>;

export const ConfigurePiRequestSchema = z.object({
  model: z.string().min(1),
  /**
   * Copy a conflicting managed roster to a `.backup` sibling and replace it.
   * Rejected unless the status reports `canRepair`.
   */
  backupConflictingConfig: z.boolean().optional(),
});
export type ConfigurePiRequest = z.infer<typeof ConfigurePiRequestSchema>;

export const InstallPiExtensionRequestSchema = z.object({
  /**
   * Copy a conflicting extension file to a `.backup` sibling and replace it.
   * Rejected unless the status reports `extension.canReplace`.
   */
  backupConflictingExtension: z.boolean().optional(),
});
export type InstallPiExtensionRequest = z.infer<typeof InstallPiExtensionRequestSchema>;
