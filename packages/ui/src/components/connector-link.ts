import { api } from '../api.js';

/** Thrown when the person cancels a sign-in that was waiting on the browser. */
export class OAuthCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled.');
    this.name = 'OAuthCancelledError';
  }
}

/**
 * Run the loopback OAuth flow for an OAuth-shaped connector type and bind it.
 * Reuses the desktop shell's 127.0.0.1 listener (the same bridge mail uses):
 * open a listener, build the consent URL through the service, let the shell
 * capture the `code`, then complete the exchange. Throws when the shell isn't
 * present (browser dev) or the user cancels.
 *
 * `opts.redirectPort` pins the listener to the manifest's declared fixed port
 * (`clientSetup.redirectPort`) for providers that match redirect URIs exactly
 * (X, Meta). Omitted, the OS picks an ephemeral port — fine for RFC 8252
 * providers like Google and Microsoft.
 *
 * `opts.signal` cancels the attempt. A provider that refuses before its
 * consent screen (an app in testing that does not list the account) shows an
 * error page and never redirects back, so the wait would otherwise run out
 * the shell's whole timeout. Aborting stops the shell's wait and rejects with
 * {@link OAuthCancelledError}; nothing is bound.
 */
export async function connectOAuth(
  projectId: string,
  type: string,
  config: Record<string, unknown>,
  displayName?: string,
  opts?: { redirectPort?: number; allowCloudModels?: boolean; signal?: AbortSignal },
): Promise<{ id: string } | undefined> {
  const shell = window.__GEZEL__;
  if (!shell?.mailOAuthListen || !shell.mailOAuthAwait) {
    throw new Error('Connecting this source needs the Gezel desktop app.');
  }
  const signal = opts?.signal;
  const { requestId, redirectUri } = await shell.mailOAuthListen(
    opts?.redirectPort !== undefined ? { port: opts.redirectPort } : undefined,
  );
  const stopWaiting = () => void shell.mailOAuthCancel?.(requestId)?.catch(() => {});
  signal?.addEventListener('abort', stopWaiting, { once: true });
  try {
    if (signal?.aborted) {
      stopWaiting();
      throw new OAuthCancelledError();
    }
    const { authUrl, state } = await api.startConnectorOAuth(projectId, {
      type,
      redirectUri,
      config,
      ...(displayName ? { displayName } : {}),
      ...(opts?.allowCloudModels ? { allowCloudModels: true } : {}),
    });
    if (signal?.aborted) throw new OAuthCancelledError();
    const result = await shell.mailOAuthAwait(requestId, authUrl);
    if (signal?.aborted) throw new OAuthCancelledError();
    if ('error' in result) throw new Error(result.error);
    const completed = await api.completeConnectorOAuth(projectId, {
      state: result.state || state,
      code: result.code,
    });
    return completed?.binding;
  } finally {
    signal?.removeEventListener('abort', stopWaiting);
  }
}
