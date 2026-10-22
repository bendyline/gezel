import { z } from 'zod';

/**
 * Gezel's tools in other AI apps: an outside agent harness (Claude Code,
 * Codex, Cursor, Claude Desktop, VS Code) runs `gezel-mcp --harness <client>`,
 * which trades the owner credential for an ephemeral `harness` token bound to
 * the project for the folder the harness is working in. See
 * docs/harness-tools.md and ADR 0023.
 */

export const HARNESS_CLIENT_IDS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'vscode',
] as const;
export const HarnessClientIdSchema = z.enum(HARNESS_CLIENT_IDS);
export type HarnessClientId = z.infer<typeof HarnessClientIdSchema>;

/** How each app is named in Settings → Integrations and in its token's `appName`. */
export const HARNESS_CLIENT_LABELS: Record<HarnessClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

/** How a harness may use memory: not at all, search it, or search and save to the project. */
export const HarnessMemoryModeSchema = z.enum(['off', 'read', 'save']);
export type HarnessMemoryMode = z.infer<typeof HarnessMemoryModeSchema>;

/** Which image engines a harness may run: none, on-device only, or any configured engine. */
export const HarnessImageModeSchema = z.enum(['off', 'local', 'any']);
export type HarnessImageMode = z.infer<typeof HarnessImageModeSchema>;

/**
 * What a harness may do with the night shift's BW issues: nothing, list them,
 * or also report verdicts (fixed, not a bug, ...). See docs/issue-triage.md.
 */
export const HarnessIssueModeSchema = z.enum(['off', 'read', 'triage']);
export type HarnessIssueMode = z.infer<typeof HarnessIssueModeSchema>;

/** Whether a folder Gezel does not know yet becomes a project when a harness starts there. */
export const HarnessNewFolderModeSchema = z.enum(['add', 'existing']);
export type HarnessNewFolderMode = z.infer<typeof HarnessNewFolderModeSchema>;

/** A harness the person stopped for one project ("Stop for this folder"). `none` is the no-project binding. */
export const HarnessBlockSchema = z.object({
  client: HarnessClientIdSchema,
  projectId: z.string().min(1),
});
export type HarnessBlock = z.infer<typeof HarnessBlockSchema>;

/**
 * `config.harnessTools`. Every field is optional and falls back to its
 * default when absent or unreadable, so a value a newer build wrote never
 * makes an older build's config unreadable.
 */
export const HarnessToolsConfigSchema = z.object({
  enabled: z.boolean().optional().catch(undefined),
  memory: HarnessMemoryModeSchema.optional().catch(undefined),
  images: HarnessImageModeSchema.optional().catch(undefined),
  newFolders: HarnessNewFolderModeSchema.optional().catch(undefined),
  issues: HarnessIssueModeSchema.optional().catch(undefined),
  blocked: z.array(HarnessBlockSchema).max(1000).optional().catch(undefined),
});
export type HarnessToolsConfig = z.infer<typeof HarnessToolsConfigSchema>;

export interface ResolvedHarnessToolsConfig {
  enabled: boolean;
  memory: HarnessMemoryMode;
  images: HarnessImageMode;
  newFolders: HarnessNewFolderMode;
  issues: HarnessIssueMode;
  blocked: HarnessBlock[];
}

export const HARNESS_TOOLS_DEFAULTS: ResolvedHarnessToolsConfig = {
  enabled: true,
  memory: 'save',
  images: 'local',
  newFolders: 'add',
  issues: 'triage',
  blocked: [],
};

export function resolveHarnessToolsConfig(
  config: { harnessTools?: HarnessToolsConfig } | null | undefined,
): ResolvedHarnessToolsConfig {
  const raw = config?.harnessTools ?? {};
  return {
    enabled: raw.enabled ?? HARNESS_TOOLS_DEFAULTS.enabled,
    memory: raw.memory ?? HARNESS_TOOLS_DEFAULTS.memory,
    images: raw.images ?? HARNESS_TOOLS_DEFAULTS.images,
    newFolders: raw.newFolders ?? HARNESS_TOOLS_DEFAULTS.newFolders,
    issues: raw.issues ?? HARNESS_TOOLS_DEFAULTS.issues,
    blocked: raw.blocked ?? [],
  };
}

/** The project id a block or token uses for a harness bound to no project. */
export const HARNESS_NO_PROJECT = 'none';

export function isHarnessBlocked(
  config: ResolvedHarnessToolsConfig,
  client: HarnessClientId,
  projectId: string | null,
): boolean {
  const id = projectId ?? HARNESS_NO_PROJECT;
  return config.blocked.some((b) => b.client === client && b.projectId === id);
}

/** `POST /v1/apps/harness-connect`. `projectId` wins over `folder`; neither binds no project. */
export const HarnessConnectRequestSchema = z.object({
  client: HarnessClientIdSchema,
  folder: z.string().min(1).max(4096).optional(),
  projectId: z.string().min(1).max(200).optional(),
});
export type HarnessConnectRequest = z.infer<typeof HarnessConnectRequestSchema>;

/**
 * Why a harness got no project: the folder is one Gezel never owns (a drive
 * root, the home folder), the person chose "Only folders already in Gezel",
 * or the harness named no folder at all (Claude Desktop).
 */
export const HarnessUnboundReasonSchema = z.enum(['forbidden-root', 'not-in-gezel', 'no-folder']);
export type HarnessUnboundReason = z.infer<typeof HarnessUnboundReasonSchema>;

export const HarnessBoundProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  workingDir: z.string().optional(),
  readOnly: z.boolean(),
  created: z.boolean(),
});
export type HarnessBoundProject = z.infer<typeof HarnessBoundProjectSchema>;

export const HarnessConnectResponseSchema = z.object({
  token: z.string().min(1),
  appId: z.string().min(1),
  project: HarnessBoundProjectSchema.nullable(),
  unboundReason: HarnessUnboundReasonSchema.optional(),
  /** The shared library's folder on disk, for turning library hits into absolute paths. */
  libraryDir: z.string().optional(),
  /**
   * The artifacts folder of the project the app's images and artifact hits
   * live in (the bound project, or Default for an unbound app).
   */
  artifactsDir: z.string().optional(),
  memory: HarnessMemoryModeSchema,
  images: HarnessImageModeSchema,
  /** Absent from a daemon that predates issue triage; the app then says to update Gezel. */
  issues: HarnessIssueModeSchema.optional(),
});
export type HarnessConnectResponse = z.infer<typeof HarnessConnectResponseSchema>;

/** Machine-readable refusals from `harness-connect`. The client never retries `harness_disconnected` or `harness_tools_off`. */
export const HARNESS_CONNECT_ERRORS = [
  'harness_tools_off',
  'harness_disconnected',
  'harness_lockdown',
] as const;
export type HarnessConnectError = (typeof HARNESS_CONNECT_ERRORS)[number];

/** The token app id for a harness binding: `harness:<client>:<projectId|none>`. */
export function harnessAppId(client: HarnessClientId, projectId: string | null): string {
  return `harness:${client}:${projectId ?? HARNESS_NO_PROJECT}`;
}

/** Parse a harness token app id back into its client and project, or null. */
export function parseHarnessAppId(
  appId: string,
): { client: HarnessClientId; projectId: string | null } | null {
  if (!appId.startsWith('harness:')) return null;
  const rest = appId.slice('harness:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const client = HarnessClientIdSchema.safeParse(rest.slice(0, sep));
  const projectId = rest.slice(sep + 1);
  if (!client.success || !projectId) return null;
  return { client: client.data, projectId: projectId === HARNESS_NO_PROJECT ? null : projectId };
}

// ── Settings → Integrations: setting the tools up in each app ────────────────

/** The command an app's MCP config runs: Gezel's launcher, under a stable Node. */
export const HarnessLaunchSpecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
});
export type HarnessLaunchSpec = z.infer<typeof HarnessLaunchSpecSchema>;

export const HarnessToolsClientStatusSchema = z.object({
  client: HarnessClientIdSchema,
  label: z.string(),
  state: z.enum(['not-configured', 'configured', 'update-needed', 'conflict', 'unavailable']),
  /** The app's own config file Gezel reads or edits, when there is one. */
  configPath: z.string().optional(),
  /** What to run by hand when Gezel cannot set the app up itself. */
  manualCommand: z.string().optional(),
  /** Plain reasons behind `update-needed`, `conflict` or `unavailable`. */
  reasons: z.array(z.string()),
  canConfigure: z.boolean(),
  canRemove: z.boolean(),
  /** Claude Desktop: the project it is set to work in, when one was chosen. */
  projectId: z.string().optional(),
  /** VS Code: the profile whose `mcp.json` holds the entry. */
  profileId: z.string().optional(),
  /** VS Code: profiles to choose from. */
  profiles: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  /** VS Code: the Gezel extension registers the tools in every workspace by itself. */
  extensionProvidesTools: z.boolean().optional(),
});
export type HarnessToolsClientStatus = z.infer<typeof HarnessToolsClientStatusSchema>;

/** One live harness token, as Settings → Integrations lists it. */
export const HarnessConnectionSchema = z.object({
  appId: z.string(),
  client: HarnessClientIdSchema,
  label: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().optional(),
  folder: z.string().optional(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
});
export type HarnessConnection = z.infer<typeof HarnessConnectionSchema>;

export const HarnessBlockedEntrySchema = HarnessBlockSchema.extend({
  label: z.string(),
  projectName: z.string().optional(),
});
export type HarnessBlockedEntry = z.infer<typeof HarnessBlockedEntrySchema>;

export const HarnessToolsStatusResponseSchema = z.object({
  config: z.object({
    enabled: z.boolean(),
    memory: HarnessMemoryModeSchema,
    images: HarnessImageModeSchema,
    newFolders: HarnessNewFolderModeSchema,
    issues: HarnessIssueModeSchema,
  }),
  /** Why no app can use the tools at all right now (the security level, a missing Node). */
  unavailableReason: z.string().optional(),
  clients: z.array(HarnessToolsClientStatusSchema),
  connections: z.array(HarnessConnectionSchema),
  blocked: z.array(HarnessBlockedEntrySchema),
});
export type HarnessToolsStatusResponse = z.infer<typeof HarnessToolsStatusResponseSchema>;

export const HarnessToolsConfigUpdateSchema = z
  .object({
    enabled: z.boolean(),
    memory: HarnessMemoryModeSchema,
    images: HarnessImageModeSchema,
    newFolders: HarnessNewFolderModeSchema,
    issues: HarnessIssueModeSchema,
  })
  .partial();
export type HarnessToolsConfigUpdate = z.infer<typeof HarnessToolsConfigUpdateSchema>;

export const HarnessToolsSetupRequestSchema = z.object({
  /** Claude Desktop: the project to work in; omit for none. */
  projectId: z.string().min(1).max(200).optional(),
  /** VS Code: the profile to write `mcp.json` into. */
  profileId: z.string().min(1).max(400).optional(),
  /** Replace a `gezel` entry Gezel did not write (a hand-made one is kept as a backup). */
  replaceExisting: z.boolean().optional(),
});
export type HarnessToolsSetupRequest = z.infer<typeof HarnessToolsSetupRequestSchema>;
