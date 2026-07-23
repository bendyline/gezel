import type { ChannelStatus, WebhookChannelConfig } from '@bendyline/gezel';
import type { SecretStore } from '../secrets/types.js';
import type { ChannelProvider, SendResult } from './types.js';

export interface WebhookChannelOpts {
  config: WebhookChannelConfig;
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_TEMPLATE = '{"message":{{message}}}';

/**
 * Stateless HTTP channel. The user gives us a URL (plus optional
 * headers, method, body template, bearer/basic auth) and we POST to it
 * when a message goes out. Matches ntfy.sh, Slack incoming webhooks,
 * Discord, self-hosted Gotify, and anything else that accepts an HTTP
 * request.
 */
export class WebhookChannel implements ChannelProvider {
  readonly name = 'webhook' as const;
  private readonly config: WebhookChannelConfig;
  private readonly secrets: SecretStore;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private lastError?: string;

  constructor(opts: WebhookChannelOpts) {
    this.config = opts.config;
    this.secrets = opts.secrets;
    // If no explicit fetch was passed, resolve `globalThis.fetch` lazily
    // at send time — tests swap it out on the global, and the service
    // has no stable global at construction time in all scenarios.
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    try {
      new URL(this.config.url);
    } catch {
      this.lastError = `invalid url: ${this.config.url}`;
    }
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }

  async status(): Promise<ChannelStatus> {
    const detail: Record<string, unknown> = { url: maskUrl(this.config.url) };
    return {
      name: this.name,
      configured: true,
      ready: !this.lastError,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      detail,
    };
  }

  async send(message: string, _metadata?: Record<string, unknown>): Promise<SendResult> {
    if (this.lastError) return { ok: false, error: this.lastError };
    const method = this.config.method ?? 'POST';
    const template = this.config.bodyTemplate ?? DEFAULT_BODY_TEMPLATE;
    const body = renderTemplate(template, message);
    const headers: Record<string, string> = {
      'content-type': this.config.bodyContentType ?? 'application/json',
      ...(this.config.headers ?? {}),
    };
    const authHeader = await this.resolveAuthHeader();
    if (authHeader) headers.authorization = authHeader;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const fetchFn = this.fetchImpl ?? globalThis.fetch;
    try {
      const res = await fetchFn(this.config.url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ''}` };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveAuthHeader(): Promise<string | null> {
    const bearer = await this.secrets.get({
      kind: 'providerCredential',
      name: 'webhookBearerToken',
    });
    if (bearer) return `Bearer ${bearer}`;
    const basic = await this.secrets.get({
      kind: 'providerCredential',
      name: 'webhookBasicAuth',
    });
    if (basic) return `Basic ${Buffer.from(basic, 'utf8').toString('base64')}`;
    return null;
  }
}

/**
 * `{{message}}` → JSON-encoded message text. Intentionally tiny — users
 * who want something richer should post-process on the receiving side.
 * JSON-encoding keeps newlines/quotes safe by default.
 */
function renderTemplate(template: string, message: string): string {
  const json = JSON.stringify(message);
  return template.replaceAll('{{message}}', json);
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    // Hide path segments longer than a random-looking topic so ntfy topics
    // don't leak into logs / history / UI.
    const parts = u.pathname.split('/').filter(Boolean);
    const masked = parts.map((p) => (p.length > 6 ? `${p.slice(0, 3)}***` : p));
    return `${u.origin}/${masked.join('/')}`;
  } catch {
    return '(invalid-url)';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
