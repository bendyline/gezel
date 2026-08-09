/**
 * Mail credential lifecycle — the stored `OAuthCredential` blob shape and the
 * refresh path the Gmail/Graph providers use mid-sync. The interactive link
 * flow (authorize URL, PKCE, code exchange) lives in the generic connector
 * OAuth core (`connectors/oauth.ts` + the mail connector-type manifests, which
 * carry the endpoints, scopes, and install-level client env names).
 */

import { type OAuthTokens, isExpired, refreshToken } from '../connectors/oauth.js';
import type { MailProviderKind } from './types.js';

export { isExpired };
export type { OAuthTokens };

/** Stored credential blob for an OAuth mail account (in the SecretStore). */
export interface OAuthCredential {
  provider: Exclude<MailProviderKind, 'imap'>;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  clientId: string;
  /** Google "desktop app" clients carry a (non-confidential) secret. */
  clientSecret?: string;
  /** Microsoft directory tenant (`organizations` / `consumers` / `common`). */
  tenant?: string;
}

/** Token endpoint + scopes for a provider (Microsoft is tenant-parameterized). */
export function providerEndpoints(provider: OAuthCredential['provider'], tenant = 'common') {
  if (provider === 'gmail') {
    return {
      authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      // Full mailbox access — read, send, and modify (mark read/labels).
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
      'https://graph.microsoft.com/Mail.Send',
    ],
  };
}

/** Trade a refresh token for a fresh access token. */
export function refreshAccessToken(cred: OAuthCredential): Promise<OAuthTokens> {
  return refreshToken({
    endpoints: providerEndpoints(cred.provider, cred.tenant),
    clientId: cred.clientId,
    ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}),
    refreshToken: cred.refreshToken,
  });
}
