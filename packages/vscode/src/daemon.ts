import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { type GezelApp, connect as sdkConnect } from '@bendyline/gezel-app-sdk';
import {
  type DiscoverOrSpawnResult,
  GezelClient,
  createTrustingFetch,
  discoverOrSpawn,
} from '@bendyline/gezel-client/node';
import type * as vscode from 'vscode';
import type { ResolvedConfig } from './config.js';
import type { Logger } from './log.js';

export type ConnectMode = 'configured' | 'adopted' | 'spawned';

export interface Connection {
  client: GezelClient;
  baseUrl: string;
  /** Root daemon token — drives the existing webview chat panel. */
  token: string;
  /** PEM-encoded loopback cert; null when daemon serves plain HTTP. */
  cert: string | null;
  /** Fetch implementation bound to the daemon's TLS trust anchor. */
  fetch: typeof fetch;
  mode: ConnectMode;
  pid?: number;
}

/**
 * Per-app SDK connection used by the Language Model Chat Provider.
 *
 * The provider talks to `/v1/chat/completions` via the SDK so it goes
 * through the public consent flow and uses a scoped token rather than
 * the root token. The webview chat panel keeps using the root token
 * (it loads the gezel SPA which expects root-level access).
 */
export interface AppConnection {
  app: GezelApp;
  appToken: string;
}

/**
 * Resolve a connection to gezeld. Order:
 *   1. Explicit `gezel.daemonUrl` + `gezel.daemonToken` settings → use directly.
 *   2. discoverOrSpawn → adopts a running desktop-app daemon if present
 *      (reads ~/.gezel/runtime/{port,token,pid}), else spawns a fresh one
 *      detached so it outlives the VSCode session.
 *   3. If `gezel.spawnIfMissing` is false and no daemon is running, throw.
 */
export async function resolveDaemon(config: ResolvedConfig, logger: Logger): Promise<Connection> {
  if (config.daemonUrl && config.daemonToken) {
    logger.info(`using configured daemon at ${config.daemonUrl}`);
    const { cert, fetchImpl } = await resolveCertAndFetchForUrl(config.daemonUrl);
    const client = new GezelClient({
      baseUrl: config.daemonUrl,
      token: config.daemonToken,
      fetch: fetchImpl,
    });
    await client.health();
    return {
      client,
      baseUrl: config.daemonUrl,
      token: config.daemonToken,
      cert,
      fetch: fetchImpl,
      mode: 'configured',
    };
  }

  const daemonEntry = resolveDaemonEntryFromExtension();
  const opts: Parameters<typeof discoverOrSpawn>[0] = {
    daemonEntry,
    detached: true,
    logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
    timeoutMs: 20000,
  };
  let result: DiscoverOrSpawnResult;
  try {
    result = await discoverOrSpawn(opts);
  } catch (err) {
    if (!config.spawnIfMissing) {
      throw new Error(
        'No running gezel daemon and gezel.spawnIfMissing is disabled. Start the gezel desktop app or enable spawn.',
      );
    }
    throw err;
  }
  logger.info(`daemon ${result.outcome} pid=${result.pid} url=${result.baseUrl}`);
  const certPem = result.cert;
  const fetchImpl = certPem
    ? createTrustingFetch({ cert: certPem })
    : (globalThis.fetch as typeof fetch);
  return {
    client: result.client,
    baseUrl: result.baseUrl,
    token: result.token,
    cert: certPem,
    fetch: fetchImpl,
    mode: result.outcome,
    pid: result.pid,
  };
}

/**
 * Acquire a per-app token for the Language Model Chat Provider.
 *
 * Uses the SDK's consent flow (`POST /v1/apps/register` → poll grant)
 * with `tokenStorage` backed by VS Code's secret store so the user
 * only sees the approval dialog once per machine.
 *
 * The `appId` is namespaced to the workspace's machine identity so
 * each install ships its own token; revoking from Connected Apps
 * affects only that machine's VS Code.
 */
export async function acquireAppConnection(
  connection: Connection,
  context: vscode.ExtensionContext,
  logger: Logger,
): Promise<AppConnection> {
  const appId = 'vscode';
  const app = await sdkConnect({
    appId,
    appName: 'Visual Studio Code',
    scopes: ['openai'],
    baseUrl: connection.baseUrl,
    fetch: connection.fetch,
    tokenStorage: {
      save: async (id, t) => context.secrets.store(`gezel:${id}`, t),
      load: async (id) => (await context.secrets.get(`gezel:${id}`)) ?? null,
    },
    approvalTimeoutSec: 300,
  });
  // The SDK returns the connected GezelApp but not the raw token.
  // The provider needs the token to attach to `Authorization: Bearer`
  // headers on follow-up `/v1/gezels` calls (which the GezelApp doesn't
  // wrap directly). Re-read it from secrets — guaranteed present once
  // connect() resolved.
  const appToken = (await context.secrets.get(`gezel:${appId}`)) ?? '';
  if (!appToken) {
    throw new Error('SDK consent flow returned without persisting an app token');
  }
  logger.info('acquired per-app token for Language Model Chat Provider');
  return { app, appToken };
}

async function resolveCertAndFetchForUrl(
  baseUrl: string,
): Promise<{ cert: string | null; fetchImpl: typeof fetch }> {
  // For an explicitly-configured daemon URL we can't infer the cert
  // path. Users who point gezel.daemonUrl at HTTPS-with-self-signed
  // should set NODE_EXTRA_CA_CERTS themselves; here we just use the
  // global fetch.
  if (baseUrl.startsWith('https://') && process.env.GEZEL_CERT_PATH) {
    try {
      const cert = await readFile(process.env.GEZEL_CERT_PATH, 'utf8');
      return { cert, fetchImpl: createTrustingFetch({ cert }) };
    } catch {
      /* fall through */
    }
  }
  return { cert: null, fetchImpl: globalThis.fetch as typeof fetch };
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
