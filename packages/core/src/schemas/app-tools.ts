import { z } from 'zod';

/**
 * **App tools** — tools a connected app registers with the daemon so its own
 * code runs when a gezel calls them.
 *
 * The shape is a relay, not a server. An app opens a relay, declares its tools
 * against a project, and holds one event stream; the daemon publishes those
 * tools to every matching chat session through an in-process MCP bridge and
 * forwards each call up the stream, waiting for the app's answer. That keeps
 * the app free of an MCP server implementation and keeps one code path for an
 * app that hosts the daemon in-process and one that connects to the user's own
 * Gezel install.
 *
 * Registrations are deliberately **ephemeral**: they live with the event
 * stream (plus a short grace window for a reconnect) and are never written to
 * disk. A tool whose handler is gone is worse than a missing tool — the model
 * calls it, waits, and learns nothing — so the daemon only advertises tools it
 * can currently reach.
 */

/**
 * Tool names share one namespace with gezel's own MCP tools, and the model
 * sees them side by side, so they follow the same snake_case grammar. The
 * daemon rejects names that collide with a built-in rather than silently
 * shadowing one.
 */
export const APP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** Default and maximum time the daemon waits for an app to answer one call. */
export const APP_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
export const APP_TOOL_MAX_TIMEOUT_MS = 300_000;

/**
 * Cap on a single app tool result, matching the MCP bridge's own
 * `MAX_TOOL_OUTPUT_CHARS`. Enforced at the route so an app learns its result
 * was too large, instead of discovering a silent truncation in the transcript.
 */
export const APP_TOOL_MAX_RESULT_CHARS = 80_000;

/** How long a registration survives after its event stream drops. */
export const APP_TOOL_RELAY_GRACE_MS = 15_000;
export const APP_TOOL_RELAY_HEARTBEAT_MS = 5_000;
export const APP_TOOL_MAX_RELAYS_PER_APP = 8;
export const APP_TOOL_MAX_PENDING_CALLS = 32;

export const AppToolDefinitionSchema = z.object({
  name: z.string().regex(APP_TOOL_NAME_RE, 'app tool names are snake_case, 2-64 characters'),
  description: z.string().min(1).max(1_000),
  /**
   * JSON Schema for the call arguments. It must be an object schema: the
   * model-facing tool surface is a named-argument one, and the bridge's
   * argument coercion is written against declared properties.
   */
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => schema.type === 'object', 'inputSchema must declare type "object"'),
  timeoutMs: z.number().int().min(1_000).max(APP_TOOL_MAX_TIMEOUT_MS).optional(),
});
export type AppToolDefinition = z.infer<typeof AppToolDefinitionSchema>;

export const OpenAppToolRelayRequestSchema = z.object({
  /** Human-readable provenance for Settings and logs, e.g. a window title. */
  label: z.string().min(1).max(80).optional(),
});
export type OpenAppToolRelayRequest = z.infer<typeof OpenAppToolRelayRequestSchema>;

export const OpenAppToolRelayResponseSchema = z.object({
  relayId: z.string(),
  appId: z.string(),
  graceMs: z.number().int(),
  heartbeatMs: z.number().int(),
  maxPendingCalls: z.number().int(),
});
export type OpenAppToolRelayResponse = z.infer<typeof OpenAppToolRelayResponseSchema>;

export const RegisterAppToolsRequestSchema = z.object({
  projectId: z.string().min(1),
  /**
   * Limit these tools to specific gezels in the project. Omitted means every
   * gezel chatting in that project sees them.
   */
  gezelIds: z.array(z.string().min(1)).max(32).optional(),
  tools: z.array(AppToolDefinitionSchema).min(1).max(64),
});
export type RegisterAppToolsRequest = z.infer<typeof RegisterAppToolsRequestSchema>;

export const RegisterAppToolsResponseSchema = z.object({
  ok: z.literal(true),
  toolsetId: z.string(),
  registered: z.array(z.string()),
});
export type RegisterAppToolsResponse = z.infer<typeof RegisterAppToolsResponseSchema>;

export const AppToolContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }),
]);
export type AppToolContentBlock = z.infer<typeof AppToolContentBlockSchema>;

export const AppToolCallResultRequestSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    content: z.union([z.string(), z.array(AppToolContentBlockSchema).max(64)]),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(4_000) }),
]);
export type AppToolCallResultRequest = z.infer<typeof AppToolCallResultRequestSchema>;

/** Why the daemon closed a relay. */
export const AppToolRelayCloseReasonSchema = z.enum([
  'app_closed',
  'superseded',
  'grace_expired',
  'daemon_shutdown',
]);
export type AppToolRelayCloseReason = z.infer<typeof AppToolRelayCloseReasonSchema>;

export const AppToolRelayEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    relayId: z.string(),
    graceMs: z.number().int(),
    heartbeatMs: z.number().int(),
  }),
  z.object({
    type: z.literal('tool_call'),
    callId: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    sessionId: z.string(),
    gezelId: z.string(),
    projectId: z.string(),
    timeoutMs: z.number().int(),
    at: z.string(),
  }),
  z.object({
    type: z.literal('tools_replaced'),
    projectId: z.string(),
    tools: z.array(z.string()),
  }),
  z.object({ type: z.literal('closed'), reason: AppToolRelayCloseReasonSchema }),
]);
export type AppToolRelayEvent = z.infer<typeof AppToolRelayEventSchema>;

export const AppToolRelayBindingSummarySchema = z.object({
  projectId: z.string(),
  gezelIds: z.array(z.string()).optional(),
  tools: z.array(z.string()),
});
export type AppToolRelayBindingSummary = z.infer<typeof AppToolRelayBindingSummarySchema>;

export const AppToolRelaySummarySchema = z.object({
  relayId: z.string(),
  appId: z.string(),
  appName: z.string().optional(),
  label: z.string().optional(),
  connected: z.boolean(),
  openedAt: z.string(),
  bindings: z.array(AppToolRelayBindingSummarySchema),
  pendingCalls: z.number().int(),
});
export type AppToolRelaySummary = z.infer<typeof AppToolRelaySummarySchema>;

export const ListAppToolRelaysResponseSchema = z.object({
  relays: z.array(AppToolRelaySummarySchema),
});
export type ListAppToolRelaysResponse = z.infer<typeof ListAppToolRelaysResponseSchema>;

/** The toolset id an app's relay tools are grouped under in the tools block. */
export function appToolsToolsetId(appId: string): string {
  return `app-tools:${appId}`;
}
