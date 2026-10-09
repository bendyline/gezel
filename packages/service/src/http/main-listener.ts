import { createLogger } from '@bendyline/gezel';
import type { ServerType, serve } from '@hono/node-server';
import { DEFAULT_PORT, type StartServiceOptions } from '../service-options.js';
import type { LoopbackCert } from './cert.js';
import { listenLoopback } from './loopback-listener.js';

const log = createLogger('service');

/**
 * Bind the product daemon's main loopback listener on the port the caller
 * asked for, and log connection-level failures once it is up.
 */
export async function bindMainListener(
  appFetch: Parameters<typeof serve>[0]['fetch'],
  cert: LoopbackCert | null,
  opts: Pick<StartServiceOptions, 'port' | 'preferCanonicalPort'>,
): Promise<{ server: ServerType; port: number }> {
  // Port selection, by caller intent:
  //   - explicit `opts.port` (from `--port` / `GEZEL_PORT`): bind exactly
  //     that and FAIL on collision — a silently-relocated named port makes
  //     the advertised base URL a lie.
  //   - `preferCanonicalPort` (standalone daemon + embedded desktop): try
  //     the canonical DEFAULT_PORT so third-party OpenAI-compatible clients
  //     get a stable base URL, but fall back to an ephemeral port if it's
  //     taken so we never fail to boot.
  //   - neither (tests, library embedders): pure ephemeral — no contention
  //     on a single fixed port across parallel suites.
  let requestedPort = 0;
  let allowEphemeralFallback = false;
  if (opts.port !== undefined) {
    requestedPort = opts.port;
  } else if (opts.preferCanonicalPort) {
    requestedPort = DEFAULT_PORT;
    allowEphemeralFallback = true;
  }

  // Classify what answers on the canonical port when we lose the bind.
  // A 200 with the health body or a 401 on exactly `/api/health` over
  // loopback TLS is another gezeld (health sits behind bearerAuth, so an
  // unauthenticated probe of a live daemon yields 401). TLS/socket
  // failures and non-HTTP listeners classify as unknown/other. Never
  // throws; bounded by a short timeout.
  const identifyCanonicalPortOccupant = async (
    occupiedPort: number,
  ): Promise<'machine-engine' | 'gezeld' | 'other-http' | 'unknown'> => {
    const { request: httpsRequest } = await import('node:https');
    return new Promise((resolve) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: occupiedPort,
          path: '/api/health',
          method: 'GET',
          timeout: 3_000,
          // The occupant's loopback cert is self-signed by a different
          // daemon; identification, not trust, is the goal here.
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => {
            if (chunks.reduce((n, b) => n + b.length, 0) < 4096) chunks.push(c);
          });
          res.on('end', () => {
            if (res.statusCode === 401) return resolve('gezeld');
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 200 && body.includes('"ok":true')) {
              if (body.includes('"serviceRole":"machine-engine"')) {
                return resolve('machine-engine');
              }
              return resolve('gezeld');
            }
            resolve('other-http');
          });
          res.on('error', () => resolve('other-http'));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve('unknown');
      });
      req.on('error', () => resolve('unknown'));
      req.end();
    });
  };
  const bindOnce = (port: number) => listenLoopback(appFetch, cert, port);

  let server!: ServerType;
  let port!: number;
  try {
    ({ server, port } = await bindOnce(requestedPort));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (allowEphemeralFallback && code === 'EADDRINUSE') {
      log.warn(
        `[service] canonical port ${requestedPort} is in use; falling back to an ephemeral port. Third-party clients should read the bound port from ~/.gezel/runtime/port.`,
      );
      // Identify the occupant in the background. A machine-engine broker plus
      // one per-user product daemon is the intended split: the former owns the
      // canonical port and GPU, the latter uses its runtime-discovered port.
      // Two FULL product daemons remain the dangerous case (duplicate
      // schedulers + engine ownership), so keep the old tripwire for legacy
      // occupants. Fire-and-forget so a slow listener cannot delay our boot.
      void identifyCanonicalPortOccupant(requestedPort).then((occupant) => {
        if (occupant === 'machine-engine') {
          log.info(
            `[service] the machine engine owns canonical port ${requestedPort}; this user daemon is using its runtime-discovered port as expected`,
          );
        } else if (occupant === 'gezeld') {
          log.error(
            `[service] another full gezeld daemon is already serving canonical port ${requestedPort}. Two product daemons may duplicate background work and contend for local engines. Upgrade the installed machine service to an engine-only build, or stop the stale service before continuing.`,
          );
        } else if (occupant === 'other-http') {
          log.warn(
            `[service] port ${requestedPort} is held by a non-Gezel local HTTP server; leaving it alone`,
          );
        }
      });
      ({ server, port } = await bindOnce(0));
    } else {
      throw err;
    }
  }
  if (cert) {
    log.info(`[service] serving HTTPS+HTTP/2 on 127.0.0.1:${port} (TLS 1.3)`);
  } else {
    log.info(`[service] serving HTTP/1.1 on 127.0.0.1:${port}`);
  }

  // Connection-level failure visibility. Every renderer SSE stream and
  // poll multiplexes over ONE h2 connection (that's the point of the ALPN
  // order above), so a single session-level error drops them all at once
  // — the UI sees a burst of "network error" with no server-side trace.
  // These handlers are the trace. `sessionError` is the h2 death that
  // matters; `tlsClientError`/`clientError` are handshake noise (port
  // scanners, curl without -k) kept at debug.
  const describeSocketError = (err: unknown): string => {
    if (!(err instanceof Error)) return String(err);
    const code = (err as NodeJS.ErrnoException).code;
    return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  };
  const rawServer = server as unknown as NodeJS.EventEmitter;
  if (cert) {
    rawServer.on('sessionError', (err: unknown) => {
      log.warn(
        `[http] h2 session error — every stream multiplexed on that connection drops: ${describeSocketError(err)}`,
      );
    });
    rawServer.on('tlsClientError', (err: unknown) => {
      log.debug(`[http] TLS client error: ${describeSocketError(err)}`);
    });
  } else {
    // Registering 'clientError' suppresses Node's default 400-and-destroy,
    // so the listener must tear the socket down itself or bad connections
    // leak.
    rawServer.on('clientError', (err: unknown, socket: { destroy: () => void }) => {
      log.debug(`[http] client connection error: ${describeSocketError(err)}`);
      socket.destroy();
    });
  }
  return { server, port };
}
