import { createSecureServer as createSecureHttp2Server } from 'node:http2';
import { isIP } from 'node:net';
import type { GezelConfig } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { type ServerType, serve } from '@hono/node-server';
import type { LoopbackCert } from '../http/cert.js';

const log = createLogger('remote-serving');
type ServeFetch = Parameters<typeof serve>[0]['fetch'];

export interface RemoteServingStatus {
  listening: boolean;
  host?: string;
  port?: number;
}

export interface RemoteServingController {
  status(): RemoteServingStatus;
  reconfigure(config: GezelConfig['remoteServing']): Promise<RemoteServingStatus>;
  stop(): Promise<void>;
}

export function createRemoteServingController(opts: {
  cert: LoopbackCert | null;
  deviceFingerprint: string;
  fetch: () => ServeFetch;
}): RemoteServingController {
  let server: ServerType | null = null;
  let current: RemoteServingStatus = { listening: false };

  const stop = async (): Promise<void> => {
    const active = server;
    server = null;
    current = { listening: false };
    if (!active) return;
    await closeServer(active);
  };

  return {
    status: () => ({ ...current }),
    async reconfigure(config) {
      if (!config?.enabled) {
        await stop();
        return { ...current };
      }
      if (!opts.cert) {
        throw new Error('Remote serving requires HTTPS; insecure transport cannot be exposed');
      }
      // Enforced here rather than as a zod refine: a schema failure fails the
      // ENTIRE config read at boot, which would brick an install over one
      // hand-edited field. Throwing here surfaces as a clean rollback/409 on
      // the write path and never disturbs an already-healthy listener.
      const bind = config.bindAddress;
      if (bind !== undefined && bind !== '' && isIP(bind) === 0) {
        throw new Error(
          `remoteServing.bindAddress must be an IP literal or empty (got ${JSON.stringify(bind)})`,
        );
      }
      const host = bind || '0.0.0.0';
      const port = config.port ?? 6229;
      if (server && current.listening && current.host === host && current.port === port) {
        return { ...current };
      }

      await stop();
      const next = await startServer({
        host,
        port,
        cert: opts.cert,
        fetch: opts.fetch(),
      });
      server = next.server;
      current = { listening: true, host, port: next.port };
      const ownedServer = next.server;
      ownedServer.once('close', () => {
        if (server !== ownedServer) return;
        server = null;
        current = { listening: false };
      });
      log.warn(
        `[remote-serving] LAN listener on ${host}:${next.port} ` +
          `(identity ${opts.deviceFingerprint.slice(0, 16)}…). Paired devices can run inference here.`,
      );
      return { ...current };
    },
    stop,
  };
}

async function startServer(opts: {
  host: string;
  port: number;
  cert: LoopbackCert;
  fetch: ServeFetch;
}): Promise<{ server: ServerType; port: number }> {
  return await new Promise((resolve, reject) => {
    let listening = false;
    const server = serve(
      {
        fetch: opts.fetch,
        port: opts.port,
        hostname: opts.host,
        createServer: createSecureHttp2Server,
        serverOptions: {
          key: opts.cert.keyPem,
          cert: opts.cert.certPem,
          allowHTTP1: true,
          minVersion: 'TLSv1.3' as const,
          ALPNProtocols: ['h2', 'http/1.1'],
        },
      },
      (info) => {
        listening = true;
        resolve({ server, port: info.port });
      },
    );
    server.on('error', (err) => {
      if (!listening) reject(err);
      else log.error(`[remote-serving] listener error: ${err.message}`);
    });
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    const http1 = server as unknown as {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
    };
    http1.closeIdleConnections?.();
    http1.closeAllConnections?.();
    const http2 = server as unknown as { _sessions?: Set<{ destroy?: () => void }> };
    for (const session of http2._sessions ?? []) session.destroy?.();
    const timer = setTimeout(finish, 2_000);
    timer.unref?.();
  });
}
