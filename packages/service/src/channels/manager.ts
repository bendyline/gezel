import {
  type ChannelName,
  type ChannelStatus,
  type ChannelsConfig,
  createLogger,
} from '@bendyline/gezel';
import type { DebugFlag } from '../debug/flag.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { SecretStore } from '../secrets/types.js';
import type { ChannelProvider, SendResult } from './types.js';
import { WebhookChannel } from './webhook.js';

const log = createLogger('channels');

export interface ChannelManagerOpts {
  store: Store;
  secrets: SecretStore;
  history: HistoryManager;
  debug: DebugFlag;
}

export interface SendOptions {
  channel?: ChannelName;
  metadata?: Record<string, unknown>;
  /** Caller label for history (e.g. "test" / gezel id). Optional. */
  source?: string;
}

/**
 * Owns the live instances of each configured channel, hands out status,
 * routes send() to the right channel, and tears everything down on
 * service stop. Modelled after ChatManager's relationship to its
 * providers.
 */
export class ChannelManager {
  private readonly store: Store;
  private readonly secrets: SecretStore;
  private readonly history: HistoryManager;
  private readonly debug: DebugFlag;
  private readonly channels = new Map<ChannelName, ChannelProvider>();
  private started = false;

  constructor(opts: ChannelManagerOpts) {
    this.store = opts.store;
    this.secrets = opts.secrets;
    this.history = opts.history;
    this.debug = opts.debug;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const config = await this.store.readConfig();
    await this.applyConfig(config.channels);
  }

  async stop(): Promise<void> {
    const pending = [...this.channels.values()].map((ch) =>
      ch.shutdown().catch((err) => {
        log.warn('[channels] shutdown failed:', err instanceof Error ? err.message : err);
      }),
    );
    await Promise.all(pending);
    this.channels.clear();
    this.started = false;
  }

  /**
   * Called by the config PUT handler when `channels.*` changed. Tears
   * down every channel and rebuilds from the new config — cheap while
   * only webhook (stateless) lives here.
   */
  async reconfigure(): Promise<void> {
    await this.stop();
    this.started = true;
    const config = await this.store.readConfig();
    await this.applyConfig(config.channels);
  }

  async list(): Promise<ChannelStatus[]> {
    const config = await this.store.readConfig();
    const cfg = config.channels ?? {};
    const out: ChannelStatus[] = [];
    const webhookCfg = cfg.webhook;
    const webhookInstance = this.channels.get('webhook');
    if (webhookInstance) {
      out.push(await webhookInstance.status());
    } else {
      out.push({ name: 'webhook', configured: Boolean(webhookCfg), ready: false });
    }
    return out;
  }

  async send(
    message: string,
    opts: SendOptions = {},
  ): Promise<SendResult & { channel?: ChannelName }> {
    const target = opts.channel ?? (await this.defaultChannel());
    if (!target) {
      return { ok: false, error: 'no channel configured' };
    }
    const provider = this.channels.get(target);
    if (!provider) {
      return { ok: false, error: `channel "${target}" not configured`, channel: target };
    }
    const start = Date.now();
    const result = await provider.send(message, opts.metadata);
    const duration = Date.now() - start;
    if (result.ok) {
      await this.history.log({
        kind: 'channel.message.sent',
        summary: `Sent message via ${target}`,
        details: {
          channel: target,
          bytes: message.length,
          durationMs: duration,
          source: opts.source,
        },
      });
    } else {
      await this.history.log({
        kind: 'channel.message.failed',
        summary: `Send via ${target} failed: ${result.error}`,
        details: {
          channel: target,
          error: result.error,
          durationMs: duration,
          source: opts.source,
        },
      });
    }
    if (this.debug.isEnabled()) {
      log.info(
        `[channels] send channel=${target} ok=${result.ok} duration=${duration}ms source=${opts.source ?? '(unspecified)'}`,
      );
    }
    return { ...result, channel: target };
  }

  private async defaultChannel(): Promise<ChannelName | undefined> {
    const cfg = (await this.store.readConfig()).channels;
    if (cfg?.default && this.channels.has(cfg.default)) return cfg.default;
    // Fall back to the single configured channel when exactly one exists.
    const configured = [...this.channels.keys()];
    if (configured.length === 1) return configured[0];
    return undefined;
  }

  private async applyConfig(cfg: ChannelsConfig | undefined): Promise<void> {
    if (!cfg) return;
    const pending: Promise<void>[] = [];
    if (cfg.webhook) {
      const channel = new WebhookChannel({ config: cfg.webhook, secrets: this.secrets });
      this.channels.set('webhook', channel);
      pending.push(
        channel.initialize().catch((err) => {
          log.warn(
            '[channels] webhook initialize failed:',
            err instanceof Error ? err.message : err,
          );
        }),
      );
    }
    await Promise.all(pending);
  }
}
