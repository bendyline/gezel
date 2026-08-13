import { api } from '../api.js';

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
 */
export async function connectOAuth(
  projectId: string,
  type: string,
  config: Record<string, unknown>,
  displayName?: string,
  opts?: { redirectPort?: number },
): Promise<void> {
  const shell = window.__GEZEL__;
  if (!shell?.mailOAuthListen || !shell.mailOAuthAwait) {
    throw new Error('Connecting this source needs the Gezel desktop app.');
  }
  const { requestId, redirectUri } = await shell.mailOAuthListen(
    opts?.redirectPort !== undefined ? { port: opts.redirectPort } : undefined,
  );
  const { authUrl, state } = await api.startConnectorOAuth(projectId, {
    type,
    redirectUri,
    config,
    ...(displayName ? { displayName } : {}),
  });
  const result = await shell.mailOAuthAwait(requestId, authUrl);
  if ('error' in result) throw new Error(result.error);
  await api.completeConnectorOAuth(projectId, { state: result.state || state, code: result.code });
}
