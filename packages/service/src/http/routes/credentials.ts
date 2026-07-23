import { Hono } from 'hono';
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
  defaultOrigins: string[];
}> = [
  {
    shortName: 'github.token',
    secretName: 'githubToken',
    label: 'GitHub personal access token',
    defaultOrigins: ['https://api.github.com'],
  },
  {
    shortName: 'openai.key',
    secretName: 'openaiApiKey',
    label: 'OpenAI API key',
    defaultOrigins: ['https://api.openai.com'],
  },
  {
    shortName: 'openai.organization',
    secretName: 'openaiOrganization',
    label: 'OpenAI organization header',
    defaultOrigins: ['https://api.openai.com'],
  },
  {
    shortName: 'anthropic.key',
    secretName: 'anthropicApiKey',
    label: 'Anthropic API key',
    defaultOrigins: ['https://api.anthropic.com'],
  },
  {
    shortName: 'webhook.bearer',
    secretName: 'webhookBearerToken',
    label: 'Webhook bearer token',
    defaultOrigins: [],
  },
  {
    shortName: 'webhook.basic',
    secretName: 'webhookBasicAuth',
    label: 'Webhook basic auth',
    defaultOrigins: [],
  },
  {
    shortName: 'brave.key',
    secretName: 'braveSearchApiKey',
    label: 'Brave Search API key',
    defaultOrigins: ['https://api.search.brave.com'],
  },
  {
    shortName: 'tavily.key',
    secretName: 'tavilyApiKey',
    label: 'Tavily API key',
    defaultOrigins: ['https://api.tavily.com'],
  },
];

export function credentialRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/available', async (c) => {
    const out: Array<{
      name: string;
      label: string;
      stored: boolean;
      defaultOrigins: string[];
    }> = [];
    for (const p of PROVIDER_CREDENTIALS) {
      const stored = await ctx.secrets.has({ kind: 'providerCredential', name: p.secretName });
      out.push({
        name: p.shortName,
        label: p.label,
        stored,
        defaultOrigins: p.defaultOrigins,
      });
    }
    return c.json({ credentials: out });
  });

  return app;
}
