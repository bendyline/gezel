import { z } from 'zod';

/**
 * Communication channels — user-chosen transports that gezels can send
 * messages over to reach the user outside the app window. Shipped in
 * this round: `webhook` (generic HTTP POST — covers ntfy.sh, Slack
 * incoming webhooks, Discord, self-hosted relays).
 *
 * The MCP tool that lets gezels *invoke* a channel and per-gezel channel
 * overrides are deliberately deferred — this round ships the plumbing.
 * A WhatsApp channel is planned; the enum is scoped so adding a
 * `'whatsapp'` variant later is additive.
 */

export const ChannelNameSchema = z.enum(['webhook']);
export type ChannelName = z.infer<typeof ChannelNameSchema>;

export const WebhookChannelConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(['POST', 'PUT']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyTemplate: z.string().optional(),
  bodyContentType: z.string().optional(),
});
export type WebhookChannelConfig = z.infer<typeof WebhookChannelConfigSchema>;

export const ChannelsConfigSchema = z.object({
  default: ChannelNameSchema.optional(),
  webhook: WebhookChannelConfigSchema.optional(),
});
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const ChannelStatusSchema = z.object({
  name: ChannelNameSchema,
  configured: z.boolean(),
  ready: z.boolean(),
  lastError: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const SendChannelMessageRequestSchema = z.object({
  channel: ChannelNameSchema.optional(),
  message: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SendChannelMessageRequest = z.infer<typeof SendChannelMessageRequestSchema>;

export const SendChannelMessageResponseSchema = z.union([
  z.object({ ok: z.literal(true), id: z.string().optional(), channel: ChannelNameSchema }),
  z.object({ ok: z.literal(false), error: z.string(), channel: ChannelNameSchema.optional() }),
]);
export type SendChannelMessageResponse = z.infer<typeof SendChannelMessageResponseSchema>;
