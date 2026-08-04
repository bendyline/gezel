import { createRequire } from 'node:module';
import { GezelApp, authorizeLocal } from '@bendyline/gezel-app-sdk';
import type { LocalDaemonMode } from '@bendyline/gezel-app-sdk';
import { GezelClient } from '@bendyline/gezel-client/node';
import type * as vscode from 'vscode';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './log.js';

export type ConnectMode = LocalDaemonMode;

export interface Connection {
  client: GezelClient;
  baseUrl: string;
  /** Revocable app token used by the webview and other ordinary extension calls. */
  token: string;
  /** PEM-encoded loopback cert; null when daemon serves plain HTTP. */
  cert: string | null;
  /** Fetch implementation bound to the daemon's TLS trust anchor. */
  fetch: typeof fetch;
  mode: ConnectMode;
  pid?: number;
}

/**
 * Code-verified, third-party-style connection used by the complete VS Code
 * extension. The extension receives only its revocable app token; daemon
 * discovery credentials never leave the shared SDK bootstrap.
 */
export interface AppConnection {
  app: GezelApp;
  appToken: string;
  connection: Connection;
}

/**
 * Discover/start the per-user daemon and acquire one per-app token for the
 * complete VS Code integration through the public app SDK.
 *
 * Uses the SDK's consent flow (`POST /v1/apps/register` → poll grant)
 * with `tokenStorage` backed by VS Code's secret store so the user
 * only sees the approval dialog once per machine.
 *
 * The SDK owns runtime discovery, pinned TLS, safe optional user-daemon
 * startup, persisted-token scope validation, and consent polling. Keeping
 * that protocol here to a single call makes VS Code the reference integration
 * other native third-party clients can follow.
 */
export async function acquireAppConnection(
  config: ResolvedConfig,
  context: vscode.ExtensionContext,
  logger: Logger,
  onVerificationCode: (code: string) => Promise<void> | void,
): Promise<AppConnection> {
  const appId = 'vscode';
  const daemonEntry = config.daemonUrl ? undefined : resolveDaemonEntryFromExtension();
  const authorized = await authorizeLocal({
    appId,
    appName: 'Visual Studio Code',
    scopes: ['product', 'openai'],
    ...(config.daemonUrl ? { baseUrl: config.daemonUrl } : {}),
    ...(config.daemonUrl && config.daemonToken ? { existingToken: config.daemonToken } : {}),
    ...(process.env.GEZEL_CERT_PATH ? { tlsCertPath: process.env.GEZEL_CERT_PATH } : {}),
    onVerificationCode,
    tokenStorage: {
      save: async (id, t) => context.secrets.store(`gezel:${id}`, t),
      load: async (id) => (await context.secrets.get(`gezel:${id}`)) ?? null,
      delete: async (id) => context.secrets.delete(`gezel:${id}`),
    },
    approvalTimeoutSec: 300,
    ...(daemonEntry
      ? {
          daemon: {
            daemonEntry,
            spawnIfMissing: config.spawnIfMissing,
            timeoutMs: 20_000,
            logger: { info: (m: string) => logger.info(m), warn: (m: string) => logger.warn(m) },
          },
        }
      : {}),
  });
  const appToken = authorized.token;
  const app = new GezelApp(authorized);
  const connection: Connection = {
    client: new GezelClient({
      baseUrl: authorized.baseUrl,
      token: appToken,
      fetch: authorized.fetch,
    }),
    baseUrl: authorized.baseUrl,
    token: appToken,
    cert: authorized.daemon.cert,
    fetch: authorized.fetch,
    mode: authorized.daemon.mode,
    ...(authorized.daemon.pid !== undefined ? { pid: authorized.daemon.pid } : {}),
  };
  logger.info(
    `daemon ${connection.mode}${connection.pid ? ` pid=${connection.pid}` : ''} url=${connection.baseUrl}`,
  );
  logger.info('acquired code-verified product + inference token for Visual Studio Code');
  return { app, appToken, connection };
}

/**
 * Locate the bundled `gezeld.js` entry. The service package explicitly
 * exports `./dist/bin/gezeld.js` (do not remove that entry — see the
 * "Gotchas" section in the project's CLAUDE.md). We resolve from this
 * extension module's location so it works whether the extension is
 * installed via pnpm in the monorepo or unpacked from a VSIX.
 */
function resolveDaemonEntryFromExtension(): string {
  // __filename is the bundled extension.cjs path; createRequire from there
  // walks the same node_modules tree as the extension itself.
  const req = createRequire(__filename);
  return req.resolve('@bendyline/gezel-service/dist/bin/gezeld.js');
}
