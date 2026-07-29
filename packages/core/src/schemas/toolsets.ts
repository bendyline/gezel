import { z } from 'zod';

/**
 * A **toolsets scope** identifies a collection of installed toolset
 * references. One of:
 *   - **gezel**: toolsets only a specific gezel can use
 *   - **project**: toolsets every session scoped to a specific project gets,
 *     regardless of which gezel is chatting. Set up by a custom project type
 *     (see docs/project-types.md) so a type's required toolset doesn't have
 *     to pollute every gezel. Sessions are already (gezel, project) pairs, so
 *     this is the natural home for project-specific tools.
 *   - **shared**: toolsets every gezel inherits (user-managed)
 *   - **system**: toolsets Gezel itself ships with (Playwright, etc.) —
 *     pinned to specific versions by the app release and auto-installed
 *     on first launch. User cannot remove; visible but locked in the UI.
 *
 * A **toolset** is a single entry inside a scope: an MCP server reference,
 * an npm-package reference, etc. See InstalledToolsetSchema in catalog.ts.
 */
export const ToolsetsScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gezel'), gezelId: z.string() }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
  z.object({ kind: z.literal('shared') }),
  z.object({ kind: z.literal('system') }),
]);
export type ToolsetsScope = z.infer<typeof ToolsetsScopeSchema>;

/** Explicit import of a VS Code/Claude-style MCP JSON configuration. */
export const ImportCustomMcpConfigRequestSchema = z.object({
  scope: ToolsetsScopeSchema,
  text: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
  /** Human-readable provenance only, e.g. `mcp.json` or `Pasted JSON`. */
  sourceName: z.string().min(1).max(512).optional(),
});
export type ImportCustomMcpConfigRequest = z.infer<typeof ImportCustomMcpConfigRequestSchema>;

export const CustomMcpImportWarningSchema = z.object({
  serverName: z.string().optional(),
  message: z.string(),
});
export type CustomMcpImportWarning = z.infer<typeof CustomMcpImportWarningSchema>;

export const ImportCustomMcpConfigResponseSchema = z.object({
  ok: z.literal(true),
  imported: z.array(z.string()),
  warnings: z.array(CustomMcpImportWarningSchema).default([]),
});
export type ImportCustomMcpConfigResponse = z.infer<typeof ImportCustomMcpConfigResponseSchema>;
