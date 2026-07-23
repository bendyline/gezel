import type { ChannelName, ChannelStatus } from '@bendyline/gezel';

/**
 * One pluggable transport that gezels (later) can send messages over.
 * Stateless for webhooks; future implementations may hold long-lived
 * sockets (e.g. WhatsApp via Baileys) and do real work in initialize/
 * shutdown.
 */
export interface ChannelProvider {
  readonly name: ChannelName;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  status(): Promise<ChannelStatus>;
  send(message: string, metadata?: Record<string, unknown>): Promise<SendResult>;
}

export type SendResult = { ok: true; id?: string } | { ok: false; error: string };
