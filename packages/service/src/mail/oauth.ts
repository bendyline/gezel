/**
 * Mail-specific OAuth wrappers over the generic connector OAuth primitives
 * (`connectors/oauth.ts`). This file owns the provider descriptors (Gmail /
 * Microsoft Graph endpoints + scopes, tenant math), the stored `OAuthCredential`
 * blob shape, and the install-level client resolution; the PKCE + token
 * round-trip mechanics live in the connector core. Public names are unchanged.
 *
 * Client IDs are install-level config (`GEZEL_GOOGLE_CLIENT_ID` /
 * `GEZEL_MICROSOFT_CLIENT_ID`), not hard-coded — each deployment registers its
 * own OAuth app.
 */

import {
  type OAuthEndpoints,
  type OAuthTokens,
  type PkcePair,
  buildAuthorizeUrl,
  createPkce,
  exchangeAuthCode,
  isExpired,
  randomState,
  refreshToken,
} from '../connectors/oauth.js';
import type { MailProviderKind } from './types.js';

export { createPkce, randomState, isExpired };
export type { OAuthTokens, PkcePair };

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

/** Endpoint + scope config for a provider (Microsoft is tenant-parameterized). */
export function providerEndpoints(
  provider: OAuthCredential['provider'],
  tenant = 'common',
): OAuthEndpoints {
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

/** Default Microsoft tenant for a provider kind. */
export function microsoftTenant(provider: OAuthCredential['provider']): string {
  if (provider === 'microsoft365') return 'organizations';
  if (provider === 'outlook') return 'consumers';
  return 'common';
}

export interface AuthUrlParams {
  provider: OAuthCredential['provider'];
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  tenant?: string;
  loginHint?: string;
}

/** Build the authorization URL the shell opens in the browser. */
export function buildAuthUrl(params: AuthUrlParams): string {
  return buildAuthorizeUrl({
    endpoints: providerEndpoints(params.provider, params.tenant),
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    state: params.state,
    challenge: params.challenge,
    // Google needs these to actually return a refresh token.
    extraParams: params.provider === 'gmail' ? { access_type: 'offline', prompt: 'consent' } : {},
    ...(params.loginHint ? { loginHint: params.loginHint } : {}),
  });
}

export interface ExchangeParams {
  provider: OAuthCredential['provider'];
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tenant?: string;
}

/** Exchange an authorization code for tokens. */
export function exchangeCode(params: ExchangeParams): Promise<OAuthTokens> {
  return exchangeAuthCode({
    endpoints: providerEndpoints(params.provider, params.tenant),
    clientId: params.clientId,
    ...(params.clientSecret ? { clientSecret: params.clientSecret } : {}),
    code: params.code,
    codeVerifier: params.codeVerifier,
    redirectUri: params.redirectUri,
  });
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

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * Resolve the install's OAuth client for a provider from the environment. Each
 * deployment registers its own OAuth app — there are no shipped client ids.
 */
export function resolveOAuthClient(provider: OAuthCredential['provider']): OAuthClient {
  if (provider === 'gmail') {
    const clientId = process.env.GEZEL_GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error(
        'Gmail OAuth is not configured. Register a Google OAuth "Desktop app" and set GEZEL_GOOGLE_CLIENT_ID (and GEZEL_GOOGLE_CLIENT_SECRET).',
      );
    }
    return {
      clientId,
      ...(process.env.GEZEL_GOOGLE_CLIENT_SECRET
        ? { clientSecret: process.env.GEZEL_GOOGLE_CLIENT_SECRET }
        : {}),
    };
  }
  const clientId = process.env.GEZEL_MICROSOFT_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'Microsoft OAuth is not configured. Register an Azure AD app (public client) and set GEZEL_MICROSOFT_CLIENT_ID.',
    );
  }
  return { clientId };
}

/** Provider-appropriate default sync folder ids. */
export function defaultFoldersFor(provider: OAuthCredential['provider'] | 'imap'): string[] {
  if (provider === 'microsoft365' || provider === 'outlook') return ['inbox'];
  return ['INBOX']; // Gmail's system inbox label is also 'INBOX'
}
