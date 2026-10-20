/**
 * Test worlds for the mail providers: a connector test env, the provider fake
 * wired into a `FakeHttp` (or the in-memory IMAP server), a stored credential,
 * and an `adapter()` that builds the binding's adapter exactly as the engine
 * does (`createMailAdapter`, with `deps.fetch` pointing at the fakes).
 *
 * Test-only; nothing in the service imports it.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeGmail } from '../connectors/testing/fake-gmail.js';
import { FakeGraphMail } from '../connectors/testing/fake-graph-mail.js';
import { FakeHttp, FakeTokenEndpoint } from '../connectors/testing/fake-http.js';
import { FakeImapServer, FakeSmtp } from '../connectors/testing/fake-imap.js';
import { type ConnectorTestEnv, createConnectorTestEnv } from '../connectors/testing/harness.js';
import type { ConnectorBindingRef } from '../connectors/types.js';
import type { MailConnectorAdapter } from './adapter.js';
import { createMailAdapter } from './registry.js';
import type { ImapCredential } from './types.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/organizations/oauth2/v2.0/token';

export const DAY = 86_400_000;
export const daysAgoIso = (days: number) => new Date(Date.now() - days * DAY).toISOString();

interface BaseWorld {
  env: ConnectorTestEnv;
  binding: ConnectorBindingRef;
  adapter(): Promise<MailConnectorAdapter>;
}

export interface OAuthMailWorld extends BaseWorld {
  http: FakeHttp;
  tokens: FakeTokenEndpoint;
}

export interface GmailWorld extends OAuthMailWorld {
  gmail: FakeGmail;
}

export interface GraphWorld extends OAuthMailWorld {
  graph: FakeGraphMail;
}

export interface ImapWorld extends BaseWorld {
  server: FakeImapServer;
  smtp: FakeSmtp;
  credential: ImapCredential;
}

const future = () => new Date(Date.now() + 3600_000).toISOString();

/**
 * The harness's fake Store points the project workspace at `<root>/workspace`
 * without creating it, and the outbox's corpus-migration check realpaths it.
 */
async function mailEnv(): Promise<ConnectorTestEnv> {
  const env = await createConnectorTestEnv();
  await mkdir(join(env.root, 'workspace'), { recursive: true });
  return env;
}

export async function gmailWorld(
  config: Record<string, unknown> = {},
  credential: Record<string, unknown> = {},
): Promise<GmailWorld> {
  const env = await mailEnv();
  const http = new FakeHttp();
  const tokens = new FakeTokenEndpoint(GOOGLE_TOKEN_URL).install(http);
  const gmail = new FakeGmail().install(http);
  const binding: ConnectorBindingRef = {
    id: 'mail-gmail:test',
    type: 'mail-gmail',
    config: { address: 'me@example.com', ...config },
  };
  await env.storeCredential(binding, {
    accessToken: 'seed-access',
    refreshToken: tokens.issueRefreshToken(),
    expiresAt: future(),
    clientId: 'google-client',
    clientSecret: 'google-secret',
    tokenUrl: GOOGLE_TOKEN_URL,
    ...credential,
  });
  return {
    env,
    http,
    tokens,
    gmail,
    binding,
    adapter: () => createMailAdapter(binding, env.deps({ fetch: http.fetch })),
  };
}

export async function graphWorld(
  config: Record<string, unknown> = {},
  credential: Record<string, unknown> = {},
  type: 'mail-microsoft365' | 'mail-outlook' = 'mail-microsoft365',
): Promise<GraphWorld> {
  const env = await mailEnv();
  const http = new FakeHttp();
  const tokens = new FakeTokenEndpoint(MICROSOFT_TOKEN_URL, { rotateRefreshToken: true }).install(
    http,
  );
  const graph = new FakeGraphMail().install(http);
  const binding: ConnectorBindingRef = {
    id: `${type}:test`,
    type,
    config: {
      address: 'me@contoso.example',
      tenant: type === 'mail-outlook' ? 'consumers' : 'organizations',
      ...config,
    },
  };
  await env.storeCredential(binding, {
    accessToken: 'seed-access',
    refreshToken: tokens.issueRefreshToken(),
    expiresAt: future(),
    clientId: 'ms-client',
    tenant: type === 'mail-outlook' ? 'consumers' : 'organizations',
    tokenUrl: MICROSOFT_TOKEN_URL,
    ...credential,
  });
  return {
    env,
    http,
    tokens,
    graph,
    binding,
    adapter: () => createMailAdapter(binding, env.deps({ fetch: http.fetch })),
  };
}

export async function imapWorld(
  config: Record<string, unknown> = {},
  server = new FakeImapServer(),
): Promise<ImapWorld> {
  const env = await mailEnv();
  const smtp = new FakeSmtp();
  const binding: ConnectorBindingRef = {
    id: 'mail-imap:test',
    type: 'mail-imap',
    config: { address: server.user, ...config },
  };
  const credential: ImapCredential = {
    host: 'imap.example.net',
    user: server.user,
    pass: server.pass,
    smtp: { host: 'smtp.example.net' },
  };
  await env.storeCredential(binding, credential);
  return {
    env,
    server,
    smtp,
    credential,
    binding,
    adapter: () =>
      createMailAdapter(binding, env.deps(), undefined, {
        imap: { createClient: server.createClient, createTransport: smtp.createTransport },
      }),
  };
}
