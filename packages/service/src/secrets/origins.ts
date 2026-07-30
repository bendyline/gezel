/**
 * Destination policy for credentials used by script HTTP.
 *
 * Built-in provider credentials are pinned to service-owned origins. Webhook
 * credentials follow the configured webhook URL. Only non-provider
 * credentials (for example toolset credentials and eval fixtures) may use the
 * legacy project-scoped origin map.
 */

export type CredentialOriginSource = 'provider' | 'webhook' | 'project';

export interface CredentialOriginPolicy {
  origins: string[];
  source: CredentialOriginSource;
  /** Explicitly configured destinations may intentionally be self-hosted. */
  permitsPrivateNetwork: boolean;
}

export const FIXED_CREDENTIAL_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  'github.token': ['https://api.github.com'],
  'openai.key': ['https://api.openai.com'],
  'openai.organization': ['https://api.openai.com'],
  'anthropic.key': ['https://api.anthropic.com'],
  'brave.key': ['https://api.search.brave.com'],
  'tavily.key': ['https://api.tavily.com'],
};

const WEBHOOK_CREDENTIALS = new Set(['webhook.bearer', 'webhook.basic']);

export function resolveCredentialOriginPolicy(
  credentialName: string,
  options: {
    webhookUrl?: string;
    projectOrigins?: Record<string, string[]>;
  } = {},
): CredentialOriginPolicy {
  const fixed = FIXED_CREDENTIAL_ORIGINS[credentialName];
  if (fixed) {
    return {
      origins: [...fixed],
      source: 'provider',
      permitsPrivateNetwork: false,
    };
  }

  if (WEBHOOK_CREDENTIALS.has(credentialName)) {
    const origin = options.webhookUrl ? httpsOriginForUrl(options.webhookUrl) : null;
    return {
      origins: origin ? [origin] : [],
      source: 'webhook',
      permitsPrivateNetwork: true,
    };
  }

  return {
    origins: (options.projectOrigins?.[credentialName] ?? [])
      .map(normalizeHttpsOrigin)
      .filter((value): value is string => value !== null),
    source: 'project',
    permitsPrivateNetwork: true,
  };
}

function httpsOriginForUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeHttpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
