import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { GezelApp, authorize as sdkAuthorize } from '@bendyline/gezel-app-sdk';
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
  /** Revocable app token used by the webview and other ordinary extension calls. */
  token: string;
  /**
   * Per-launch discovery credential used only to administer the extension's
   * own grant (approval/reset). It is never forwarded into the webview.
   */
  firstPartyToken: string;
  /** PEM-encoded loopback cert; null when daemon serves plain HTTP. */
  cert: string | null;
  /** Fetch implementation bound to the daemon's TLS trust anchor. */
  fetch: typeof fetch;
  mode: ConnectMode;
  pid?: number;
}

/**
 * Code-verified app connection used by the complete VS Code extension.
 *
 * `connection` is rebuilt around the revocable app token: its `product`
 * scope powers the embedded chat UX and its `openai` scope powers the
 * Language Model Provider. `firstPartyToken` remains host-only so the
 * extension can approve or reset its own grant without exposing that
 * discovery credential to the webview.
 */
export interface AppConnection {
  app: GezelApp;
  appToken: string;
  connection: Connection;
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
      firstPartyToken: config.daemonToken,
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
    firstPartyToken: result.token,
    cert: certPem,
    fetch: fetchImpl,
    mode: result.outcome,
    pid: result.pid,
  };
}

/**
 * Acquire one per-app token for the complete VS Code integration.
 *
 * Uses the SDK's consent flow (`POST /v1/apps/register` → poll grant)
 * with `tokenStorage` backed by VS Code's secret store so the user
 * only sees the approval dialog once per machine.
 *
 * Older extension builds stored an inference-only `openai` token under
 * the same app id. Probe a saved token against the product API and
 * self-revoke it before requesting the expanded, code-verified grant.
 */
export async function acquireAppConnection(
  connection: Connection,
  context: vscode.ExtensionContext,
  logger: Logger,
  onVerificationCode: (code: string) => Promise<void> | void,
): Promise<AppConnection> {
  const appId = 'vscode';
  const secretKey = `gezel:${appId}`;
  const existingToken = await context.secrets.get(secretKey);
  if (existingToken) {
    const productProbe = await connection.fetch(`${connection.baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${existingToken}` },
    });
    const inferenceProbe = productProbe.ok
      ? await connection.fetch(`${connection.baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${existingToken}` },
        })
      : null;
    const lacksRequiredScope =
      productProbe.status === 401 ||
      productProbe.status === 403 ||
      inferenceProbe?.status === 401 ||
      inferenceProbe?.status === 403;
    if (lacksRequiredScope) {
      logger.info(
        'saved VS Code token lacks product or inference access; replacing it through consent',
      );
      const revoke = await connection.fetch(
        `${connection.baseUrl}/v1/apps/${encodeURIComponent(appId)}/token`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${existingToken}` },
        },
      );
      if (!revoke.ok && revoke.status !== 401 && revoke.status !== 404) {
        throw new Error(`could not replace the legacy VS Code token (HTTP ${revoke.status})`);
      }
      await context.secrets.delete(secretKey);
    } else if (!productProbe.ok || !inferenceProbe?.ok) {
      throw new Error(
        `could not validate the saved VS Code token (HTTP ${productProbe.status}/${inferenceProbe?.status ?? 'not-run'})`,
      );
    }
  }

  const authorized = await sdkAuthorize({
    appId,
    appName: 'Visual Studio Code',
    scopes: ['product', 'openai'],
    baseUrl: connection.baseUrl,
    fetch: connection.fetch,
    onVerificationCode,
    tokenStorage: {
      save: async (id, t) => context.secrets.store(`gezel:${id}`, t),
      load: async (id) => (await context.secrets.get(`gezel:${id}`)) ?? null,
    },
    approvalTimeoutSec: 300,
  });
  const appToken = authorized.token;
  const app = new GezelApp(authorized);
  const authorizedConnection: Connection = {
    ...connection,
    client: new GezelClient({
      baseUrl: connection.baseUrl,
      token: appToken,
      fetch: connection.fetch,
    }),
    token: appToken,
  };
  logger.info('acquired code-verified product + inference token for Visual Studio Code');
  return { app, appToken, connection: authorizedConnection };
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
