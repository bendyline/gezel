import { Hono } from 'hono';
import {
  type CredentialOriginSource,
  resolveCredentialOriginPolicy,
} from '../../secrets/origins.js';
import type { ProviderCredentialName } from '../../secrets/types.js';
import type { ServiceContext } from '../context.js';

/**
 * Lists named credentials currently stored in the workspace's
 * `SecretStore`. Used by the Settings → Project → Credentials UI to
 * render a grant list. Returns only short names — never values.
 */

const PROVIDER_CREDENTIALS: Array<{
  shortName: string;
  secretName: ProviderCredentialName;
  label: string;
}> = [
  {
    shortName: 'github.token',
    secretName: 'githubToken',
    label: 'GitHub personal access token',
  },
  {
    shortName: 'openai.key',
    secretName: 'openaiApiKey',
    label: 'OpenAI API key',
  },
  {
    shortName: 'openai.organization',
    secretName: 'openaiOrganization',
    label: 'OpenAI organization header',
  },
  {
    shortName: 'anthropic.key',
    secretName: 'anthropicApiKey',
    label: 'Anthropic API key',
  },
  {
    shortName: 'webhook.bearer',
    secretName: 'webhookBearerToken',
    label: 'Webhook bearer token',
  },
  {
    shortName: 'webhook.basic',
    secretName: 'webhookBasicAuth',
    label: 'Webhook basic auth',
  },
  {
    shortName: 'brave.key',
    secretName: 'braveSearchApiKey',
    label: 'Brave Search API key',
  },
  {
    shortName: 'tavily.key',
    secretName: 'tavilyApiKey',
    label: 'Tavily API key',
  },
];

export function credentialRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/available', async (c) => {
    const out: Array<{
      name: string;
      label: string;
      stored: boolean;
      allowedOrigins: string[];
      originSource: CredentialOriginSource;
      /** @deprecated Compatibility for clients predating destination policies. */
      defaultOrigins: string[];
    }> = [];
    const config = await ctx.store.readConfig();
    const webhookUrl = config.channels?.webhook?.url;
    for (const p of PROVIDER_CREDENTIALS) {
      const stored = await ctx.secrets.has({ kind: 'providerCredential', name: p.secretName });
      const originPolicy = resolveCredentialOriginPolicy(p.shortName, { webhookUrl });
      out.push({
        name: p.shortName,
        label: p.label,
        stored,
        allowedOrigins: originPolicy.origins,
        originSource: originPolicy.source,
        defaultOrigins: originPolicy.origins,
      });
    }
    return c.json({ credentials: out });
  });

  return app;
}
