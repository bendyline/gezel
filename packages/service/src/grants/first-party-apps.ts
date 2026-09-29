import type { TokenStore } from '../http/token-store.js';
import { createMutationQueue } from '../local-harness/base.js';

/**
 * Gezel's own add-ins for Office, LibreOffice and VS Code connect without a
 * connection code when they can prove they run as this computer's Gezel
 * user: by reading a file only that account can read (the daemon's owner
 * credential, a provisioned token file) or by presenting the enrollment key
 * written into the Office manifest. The code protects a grant against other
 * local accounts and web pages; neither can read those files, and a process
 * that can read them already reads `tokens.json`. See ADR 0018.
 *
 * The public consent flow stays available for these ids as a fallback, and
 * still gates everything else.
 */
export const FIRST_PARTY_LOCAL_APPS = {
  office: { appName: 'Microsoft Office', scopes: ['product'] },
  libreoffice: { appName: 'LibreOffice', scopes: ['product'] },
  vscode: { appName: 'Visual Studio Code', scopes: ['product', 'openai'] },
} as const satisfies Record<string, { appName: string; scopes: readonly string[] }>;

export type FirstPartyLocalAppId = keyof typeof FIRST_PARTY_LOCAL_APPS;

export function isFirstPartyLocalAppId(value: string): value is FirstPartyLocalAppId {
  return Object.hasOwn(FIRST_PARTY_LOCAL_APPS, value);
}

export interface FirstPartyAppTokens {
  /**
   * The app's token: the existing one when its scopes match, else a fresh
   * one. Reusing it is what lets Word, Excel and PowerPoint, whose panes keep
   * separate storage, share one grant instead of revoking each other.
   */
  connect(appId: FirstPartyLocalAppId): Promise<string>;
  /** Revoke the app's token, if any. Setup removal calls this. */
  disconnect(appId: FirstPartyLocalAppId): Promise<void>;
}

export function createFirstPartyAppTokens(
  tokenStore: Pick<TokenStore, 'list' | 'issue' | 'revoke'>,
): FirstPartyAppTokens {
  const serialize = createMutationQueue();
  return {
    connect: (appId) =>
      serialize(async () => {
        const spec = FIRST_PARTY_LOCAL_APPS[appId];
        const existing = tokenStore.list().find((r) => r.appId === appId);
        if (existing && sameScopes(existing.scopes, spec.scopes)) return existing.token;
        if (existing) await tokenStore.revoke(appId);
        const issued = await tokenStore.issue({
          appId,
          appName: spec.appName,
          scopes: [...spec.scopes],
        });
        return issued.token;
      }),
    disconnect: (appId) =>
      serialize(async () => {
        await tokenStore.revoke(appId);
      }),
  };
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((scope) => a.includes(scope));
}
