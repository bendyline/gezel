import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { DEFAULT_CONTAINER_PORT } from '@bendyline/gezel';
import { type ServerType, serve } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import type { TokenRecord, TokenStore } from './token-store.js';

/**
 * The container listener (ADR 0029, docs/container.md). Inside a container
 * the daemon's loopback is the container's own, which Docker's port
 * publishing never reaches, so a container serves its UI and API on a
 * second listener bound to the container's interface. That listener is not
 * the loopback app with a wider bind: it mounts the product surface on
 * purpose, admits only signed-in accounts and approved app grants, and
 * leaves out every route that trusts a local caller.
 */

declare module 'hono' {
  interface ContextVariableMap {
    /** Set on requests that arrived through the container listener. */
    listener: 'container';
  }
}

/**
 * Not the daemon's 6228. On a computer that also has the Gezel app, its
 * machine service holds host port 6228, pinned without a fallback on Linux
 * and Windows, so publishing 6228 either fails to start the container or,
 * when the container comes up first, knocks out the machine service. The
 * docs publish this same port on both sides, which keeps the setup link
 * (built from it) right without `GEZEL_PUBLIC_URL`. The number itself is in
 * core, where the command line reads it to print the same address.
 */
export { DEFAULT_CONTAINER_PORT };

/**
 * Routes that trust "can read this account's runtime/" or "is on this
 * machine", or that configure apps installed beside the daemon. None of
 * them mean anything from another machine, and several would be a way in.
 */
export const CONTAINER_DENIED_PREFIXES: readonly string[] = [
  '/v1/apps/local-connect',
  '/v1/apps/harness-connect',
  '/v1/apps/office',
  '/v1/apps/pair',
  '/v1/remote',
  '/v1/identity',
  '/office',
  '/api/remote-serving',
  '/api/machine-serving',
  '/api/harness-tools',
  '/api/codex-setup',
  '/api/opencode-setup',
  '/api/pi-setup',
  '/api/vscode-setup',
  '/api/office-setup',
  '/api/libreoffice-setup',
];

export function isContainerDeniedPath(path: string): boolean {
  return CONTAINER_DENIED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function containerRouteDenylist(): MiddlewareHandler {
  return async (c, next) => {
    c.set('listener', 'container');
    if (isContainerDeniedPath(c.req.path)) return c.json({ error: 'not found' }, 404);
    return next();
  };
}

/**
 * Credentials the container listener refuses. The owner's runtime credential
 * and the web-UI token live in the home volume and stay usable from inside
 * the container; gezels' session tokens and outside apps' harness tokens
 * are handed to local processes only. A network caller signs in instead.
 */
export function admittedOnContainerListener(record: TokenRecord): boolean {
  if (record.kind === 'account') return true;
  if (record.appId === 'root' || record.appId === 'desktop-client' || record.appId === 'web-ui') {
    return false;
  }
  if (record.kind === 'harness' || record.kind === 'device') return false;
  const refused = ['root', 'session', 'harness', 'remote-inference', 'machine-models'];
  return !record.scopes.some((scope) => refused.includes(scope));
}

/** The same store, with lookups narrowed to what the container listener admits. */
export function containerTokenStore(store: TokenStore): TokenStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'lookup') {
        return (token: string) => {
          const record = target.lookup(token);
          return record && admittedOnContainerListener(record) ? record : null;
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export interface ContainerHostPolicy {
  allowLanIpHosts: () => boolean;
  allowedHostnames: () => readonly string[];
}

/**
 * Which `Host` values the container listener answers. Loopback names
 * always (a browser on the Docker host); an IP literal only when the person
 * opted into plain HTTP on their LAN; a hostname only when listed, which is
 * how a TLS reverse proxy in front is admitted. DNS rebinding stays shut.
 */
export function containerHostPolicy(env: NodeJS.ProcessEnv = process.env): ContainerHostPolicy {
  const hostnames = (env.GEZEL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0 && isIP(name) === 0);
  const lan = env.GEZEL_LAN === 'plain-http';
  return { allowLanIpHosts: () => lan, allowedHostnames: () => hostnames };
}

/** Docker writes `/.dockerenv`; Podman and CRI-O write `/run/.containerenv`. */
export function detectContainer(
  probe: { exists: (path: string) => boolean; read: (path: string) => string | null } = {
    exists: existsSync,
    read: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  },
): boolean {
  if (process.platform !== 'linux') return false;
  if (probe.exists('/.dockerenv') || probe.exists('/run/.containerenv')) return true;
  const cgroup = probe.read('/proc/1/cgroup') ?? '';
  return /docker|containerd|kubepods|libpod/.test(cgroup);
}

export interface ContainerListenerSettings {
  enabled: boolean;
  port: number;
  /** Why the listener is off, when `GEZEL_CONTAINER` asked for it. */
  refusedBecause?: string;
}

/**
 * `GEZEL_CONTAINER=1` asks for the listener; a real container must agree,
 * so the variable alone never opens a desktop to its network.
 * `GEZEL_CONTAINER_FORCE=1` is the escape hatch for runtimes the detection
 * misses.
 */
export function resolveContainerListener(
  env: NodeJS.ProcessEnv = process.env,
  inContainer: () => boolean = detectContainer,
): ContainerListenerSettings {
  const port = Number.parseInt(env.GEZEL_CONTAINER_PORT ?? '', 10);
  const settings = {
    // 0 binds an ephemeral port; tests use it.
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_CONTAINER_PORT,
  };
  if (env.GEZEL_CONTAINER !== '1') return { enabled: false, ...settings };
  if (env.GEZEL_CONTAINER_FORCE !== '1' && !inContainer()) {
    return {
      enabled: false,
      ...settings,
      refusedBecause:
        'GEZEL_CONTAINER=1 is set but this does not look like a container, so the network listener stays off. Set GEZEL_CONTAINER_FORCE=1 if it is one.',
    };
  }
  return { enabled: true, ...settings };
}

/** Bind the container listener on every interface of the container. Plain HTTP. */
export function bindContainerListener(
  fetch: Parameters<typeof serve>[0]['fetch'],
  port: number,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname: '0.0.0.0' }, (info) =>
      resolve({ server, port: info.port }),
    );
    server.once('error', reject);
    const raw = server as unknown as NodeJS.EventEmitter;
    raw.on('clientError', (_err: unknown, socket: { destroy: () => void }) => socket.destroy());
  });
}
