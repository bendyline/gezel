/**
 * Mail credential lifecycle — the stored OAuth credential blob and the session
 * the Gmail/Graph providers refresh it through mid-sync. The interactive link
 * flow (authorize URL, PKCE, code exchange) lives in the generic connector
 * OAuth core (`connectors/oauth.ts` + the mail connector-type manifests, which
 * carry the endpoints, scopes, and install-level client env names).
 *
 * Refresh goes through the shared `OAuthSession`: it prefers the token URL the
 * grant was issued by (a Microsoft tenant), passes the injected transport,
 * re-persists a rotated refresh token before the pass continues, and turns a
 * refused refresh (`invalid_grant`) into a "Re-link the account" message.
 */

import {
  GOOGLE_OAUTH,
  MICROSOFT_OAUTH,
  OAuthSession,
  type StoredOAuthCredential,
} from '../connectors/natives/oauth-session.js';
import { isExpired } from '../connectors/oauth.js';
import type { OAuthTokens } from '../connectors/oauth.js';
import type { AdapterDeps, ConnectorBindingRef } from '../connectors/types.js';
import type { MailProviderKind } from './types.js';

export { isExpired };
export type { OAuthTokens };

/** Stored credential blob for an OAuth mail account (in the SecretStore). */
export interface OAuthCredential extends StoredOAuthCredential {
  /** Written by older link flows; the binding's type is authoritative now. */
  provider?: Exclude<MailProviderKind, 'imap'>;
}

/** Token endpoint + scopes for a provider (Microsoft is tenant-parameterized). */
export function providerEndpoints(provider: Exclude<MailProviderKind, 'imap'>, tenant = 'common') {
  if (provider === 'gmail') {
    return {
      authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      // Full mailbox access — read, send, save drafts, modify labels.
      scopes: ['https://mail.google.com/'],
    };
  }
  // microsoft365 (tenant 'organizations') + outlook.com (tenant 'consumers')
  return {
    authEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: [
      'offline_access',
      'https://graph.microsoft.com/Mail.Read',
      // Saving a draft creates a message in the mailbox.
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ],
  };
}

/** The per-pass OAuth session for a Gmail or Microsoft mail binding. */
export function createMailOAuthSession(
  binding: ConnectorBindingRef,
  deps: AdapterDeps,
  provider: Exclude<MailProviderKind, 'imap'>,
): OAuthSession {
  if (provider === 'gmail') return new OAuthSession(binding, deps, GOOGLE_OAUTH);
  // A credential from before the token URL was stored names its tenant; the
  // binding config pins it for the newer types. Either beats `common`, which
  // a consumers-only or organizations-only app registration refuses.
  const configTenant = (binding.config as { tenant?: unknown } | undefined)?.tenant;
  return new OAuthSession(binding, deps, {
    ...MICROSOFT_OAUTH,
    defaultTokenUrl: (cred) =>
      providerEndpoints(
        provider,
        encodeURIComponent(
          cred.tenant || (typeof configTenant === 'string' && configTenant) || 'common',
        ),
      ).tokenEndpoint,
  });
}
