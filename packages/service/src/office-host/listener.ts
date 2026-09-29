import { createLogger } from '@bendyline/gezel';
import type { ServerType, serve } from '@hono/node-server';
import type { LoopbackCert } from '../http/cert.js';
import { closeLoopbackListener, listenLoopback } from '../http/loopback-listener.js';

const log = createLogger('office-host');

export type Fetch = Parameters<typeof serve>[0]['fetch'];

export type OfficeHostListenerState = 'stopped' | 'listening' | 'port-in-use' | 'error';

export interface OfficeHostListenerStatus {
  state: OfficeHostListenerState;
  /** The bound port when listening, else the port it would bind. */
  port: number;
  /** `https://localhost:<port>`: the origin the add-in manifests name. */
  origin: string;
  message?: string;
}

export interface OfficeHostListener {
  desiredPort(): number;
  status(): OfficeHostListenerStatus;
  /** The live origin, or `null` when not listening. */
  origin(): string | null;
  /** Bind (or rebind after a certificate change). Resolves with the resulting status; never rejects. */
  start(cert: LoopbackCert): Promise<OfficeHostListenerStatus>;
  stop(): Promise<void>;
}

/**
 * A second loopback TLS listener serving the FULL product app on a stable
 * port, with the persistent Office certificate.
 *
 * Not a local bridge: bridges are plain HTTP and inference-only by
 * construction (`http/local-bridge.ts`). The Office pane is a first-party
 * page that needs `/api/*` and `/events/*`, and WebView2 / WKWebView will
 * only load it over HTTPS they trust. Precedent for "same app, own cert,
 * own listener" is the LAN listener in `remotes/serving.ts`.
 *
 * `localhost` resolves to both loopback families and some WebView2 builds try
 * `::1` first, so the listener also binds `::1` when it can; that bind is
 * best effort and never fails the listener.
 */
export function createOfficeHostListener(opts: {
  fetch: () => Fetch;
  port: number;
}): OfficeHostListener {
  let v4: ServerType | null = null;
  let v6: ServerType | null = null;
  let boundPort = 0;
  let certSha: string | null = null;
  let state: OfficeHostListenerState = 'stopped';
  let message: string | undefined;

  const originFor = (port: number) => `https://localhost:${port}`;

  async function closeAll(): Promise<void> {
    const servers = [v4, v6].filter((s): s is ServerType => s !== null);
    v4 = null;
    v6 = null;
    await Promise.all(servers.map((s) => closeLoopbackListener(s).catch(() => {})));
  }

  const listener: OfficeHostListener = {
    desiredPort: () => opts.port,
    status: () => {
      const port = state === 'listening' ? boundPort : opts.port;
      return { state, port, origin: originFor(port), ...(message ? { message } : {}) };
    },
    origin: () => (state === 'listening' ? originFor(boundPort) : null),
    async start(cert) {
      if (state === 'listening' && certSha === cert.sha256Hex) return listener.status();
      await closeAll();
      try {
        const bound = await listenLoopback(opts.fetch(), cert, opts.port);
        v4 = bound.server;
        boundPort = bound.port;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        state = code === 'EADDRINUSE' ? 'port-in-use' : 'error';
        message =
          code === 'EADDRINUSE'
            ? `Port ${opts.port} is in use by another program, so Word, Excel and PowerPoint cannot reach Gezel.`
            : `The Office connection could not start: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`[office-host] listen failed on ${opts.port}: ${message}`);
        return listener.status();
      }
      try {
        v6 = (await listenLoopback(opts.fetch(), cert, boundPort, { hostname: '::1' })).server;
      } catch (err) {
        log.debug(`[office-host] ::1 not bound on ${boundPort}: ${String(err)}`);
      }
      certSha = cert.sha256Hex;
      state = 'listening';
      message = undefined;
      log.info(`[office-host] listening on ${originFor(boundPort)}`);
      return listener.status();
    },
    async stop() {
      await closeAll();
      state = 'stopped';
      certSha = null;
      message = undefined;
    },
  };
  return listener;
}
