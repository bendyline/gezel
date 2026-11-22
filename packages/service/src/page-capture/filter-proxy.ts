/**
 * The capture browser's only way out to the network. Every request Chromium
 * makes (page, subresources, WebSockets, workers, preconnects) is sent to this
 * forward proxy, which resolves the host itself, refuses any private,
 * loopback, link-local or metadata address, and connects to the address it
 * checked. Connecting to the checked address is what closes DNS rebinding:
 * the browser never resolves a name, so a record that flips between the check
 * and the connect has nothing to flip.
 *
 * What it does not see: the method and path inside a TLS tunnel (the worker's
 * request rules cover those), and UDP (the seeded profile turns off
 * non-proxied UDP; QUIC is disabled by flag). See docs/website-connector.md.
 */

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { createLogger, redactPageUrl } from '@bendyline/gezel';
import { isPrivateAddress, neverReachableKind } from '../utils/ssrf.js';

const log = createLogger('page-capture');

/** Per-page network limits. */
export interface PageNetworkBudget {
  /** Bytes the browser may receive for one page. */
  bytes: number;
  /** Connections (tunnels + plain requests) for one page. */
  connections: number;
  /** Distinct hosts for one page. */
  hosts: number;
}

export const DEFAULT_PAGE_NETWORK_BUDGET: PageNetworkBudget = {
  bytes: 30 * 1024 * 1024,
  connections: 400,
  hosts: 80,
};

/**
 * Limits for a sign-in window. The person drives it, may keep it open for
 * minutes, and a single sign-on flow passes through identity providers,
 * captcha services and their CDNs, so the per-page limits would cut it off.
 */
export const SIGN_IN_NETWORK_BUDGET: PageNetworkBudget = {
  bytes: 400 * 1024 * 1024,
  connections: 4_000,
  hosts: 400,
};

export interface PageNetworkStats {
  bytes: number;
  connections: number;
  hosts: number;
  refused: Record<string, number>;
  /** A budget ran out and later connections were refused. */
  overBudget: boolean;
}

export interface FilterProxyOptions {
  /**
   * Hosts whose private addresses may be reached, each only while a page on
   * that same host is being captured (an intranet wiki the person typed).
   */
  privateHosts?: readonly string[];
  /** Allow plain-HTTP POST/PUT/… through (script requests). TLS methods are invisible here. */
  allowScriptPost?: boolean;
  /** Extra ports besides 80 and 443 the person's own site addresses use. */
  extraPorts?: readonly number[];
  /** Test seam: resolve a host to addresses. Production uses the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * Test seam only, never set from config: loopback targets a fixture server
   * listens on. Production passes nothing and loopback is always refused.
   */
  allowLoopbackPorts?: readonly number[];
}

type Refusal =
  | 'private'
  | 'loopback'
  | 'metadata'
  | 'own-address'
  | 'unresolvable'
  | 'port'
  | 'method'
  | 'budget'
  | 'no-page'
  | 'bad-request'
  | 'rebinding';

export class FilterProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private currentHost: string | null = null;
  private budget: PageNetworkBudget = DEFAULT_PAGE_NETWORK_BUDGET;
  private stats: PageNetworkStats = emptyStats();
  private readonly pageHosts = new Set<string>();
  private readonly privateHosts: Set<string>;
  /**
   * What each typed host's first answer was, for the life of this session. A
   * typed host may be an intranet site, so its private answers are allowed,
   * but only when it has always answered privately: a host that first served
   * a public page and later answers with a router's address is DNS
   * rebinding, which would let that page read the person's network.
   */
  private readonly typedHostKind = new Map<string, 'public' | 'private'>();
  private readonly ports: Set<number>;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly allowLoopbackPorts: Set<number>;
  private ownAddresses: Set<string> = new Set();

  private constructor(private readonly opts: FilterProxyOptions) {
    this.privateHosts = new Set((opts.privateHosts ?? []).map((h) => h.toLowerCase()));
    this.ports = new Set([80, 443, ...(opts.extraPorts ?? [])]);
    this.resolveHost =
      opts.resolve ??
      (async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));
    this.allowLoopbackPorts = new Set(opts.allowLoopbackPorts ?? []);
  }

  static async start(opts: FilterProxyOptions = {}): Promise<FilterProxy> {
    const proxy = new FilterProxy(opts);
    proxy.refreshOwnAddresses();
    // A rejection here would be unhandled, and the daemon exits on one: a
    // page's own requests must never be able to stop it.
    const server = http.createServer((req, res) => {
      proxy.onRequest(req, res).catch((err) => {
        log.warn(`proxy request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    server.on('connect', (req, socket, head) => {
      proxy.onConnect(req, socket as net.Socket, head).catch((err) => {
        log.warn(`proxy tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
        (socket as net.Socket).destroy();
      });
    });
    server.on('upgrade', (_req, socket) => {
      (socket as net.Socket).end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    server.on('connection', (socket) => {
      proxy.sockets.add(socket);
      socket.on('close', () => proxy.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    proxy.server = server;
    return proxy;
  }

  get port(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  /**
   * Start accounting for one page. Tunnels left from the previous page are
   * closed, so a private host's allowance cannot outlive its page.
   */
  beginPage(host: string, budget: PageNetworkBudget = DEFAULT_PAGE_NETWORK_BUDGET): void {
    this.destroyTunnels();
    this.currentHost = host.toLowerCase();
    this.budget = budget;
    this.stats = emptyStats();
    this.pageHosts.clear();
    this.refreshOwnAddresses();
  }

  /** Stop accounting; nothing new connects until the next `beginPage`. */
  endPage(): PageNetworkStats {
    const stats = { ...this.stats, refused: { ...this.stats.refused } };
    this.currentHost = null;
    this.destroyTunnels();
    return stats;
  }

  async close(): Promise<void> {
    this.currentHost = null;
    this.destroyTunnels();
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private readonly tunnels = new Set<net.Socket>();

  private destroyTunnels(): void {
    for (const s of this.tunnels) s.destroy();
    this.tunnels.clear();
  }

  private refreshOwnAddresses(): void {
    const own = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) own.add(iface.address.toLowerCase());
    }
    this.ownAddresses = own;
  }

  private refuse(why: Refusal): Refusal {
    this.stats.refused[why] = (this.stats.refused[why] ?? 0) + 1;
    return why;
  }

  /**
   * Whether a typed host's answer is public, private (a LAN or this machine's
   * own address), or both. Loopback and metadata are judged separately and
   * never reachable, so they count as neither.
   */
  private typedAnswerKind(addresses: readonly string[]): 'public' | 'private' | 'mixed' {
    let pub = false;
    let priv = false;
    for (const ip of addresses) {
      const lower = ip.toLowerCase();
      if (neverReachableKind(lower)) continue;
      if (this.ownAddresses.has(lower) || isPrivateAddress(lower)) priv = true;
      else pub = true;
    }
    return pub && priv ? 'mixed' : priv ? 'private' : 'public';
  }

  /** The address to connect to, or why the target is refused. */
  private async pin(hostRaw: string, port: number): Promise<{ ip: string } | { refused: Refusal }> {
    if (this.currentHost === null) return { refused: this.refuse('no-page') };
    const host = hostRaw.replace(/^\[|\]$/g, '').toLowerCase();
    const loopbackFixture = this.allowLoopbackPorts.has(port);
    if (!this.ports.has(port) && !loopbackFixture) return { refused: this.refuse('port') };
    if (this.stats.connections >= this.budget.connections) {
      this.stats.overBudget = true;
      return { refused: this.refuse('budget') };
    }
    if (!this.pageHosts.has(host) && this.pageHosts.size >= this.budget.hosts) {
      this.stats.overBudget = true;
      return { refused: this.refuse('budget') };
    }
    let addresses: string[];
    if (net.isIP(host)) addresses = [host];
    else if (host === 'localhost' || host.endsWith('.localhost')) {
      return { refused: this.refuse('loopback') };
    } else {
      try {
        addresses = await this.resolveHost(host);
      } catch {
        return { refused: this.refuse('unresolvable') };
      }
    }
    if (addresses.length === 0) return { refused: this.refuse('unresolvable') };
    // The page can end while the lookup runs; nothing connects after it.
    const current = this.currentHost;
    if (current === null) return { refused: this.refuse('no-page') };
    let privateOk = false;
    if (this.privateHosts.has(host)) {
      const kind = this.typedAnswerKind(addresses);
      const before = this.typedHostKind.get(host);
      if (kind === 'mixed' || (before && before !== kind)) {
        log.warn(`refused ${host}: its addresses changed between public and private`);
        return { refused: this.refuse('rebinding') };
      }
      this.typedHostKind.set(host, kind);
      // A private address is allowed only for a typed host that has always
      // answered privately, while a page on that host is the one captured.
      privateOk =
        kind === 'private' &&
        (current === host || current.replace(/^www\./, '') === host.replace(/^www\./, ''));
    }
    for (const ip of addresses) {
      const lower = ip.toLowerCase();
      // Never reachable, even for a private site the person typed. Judged on
      // the parsed address, so an IPv4-mapped AAAA answer counts as its IPv4.
      const never = neverReachableKind(lower);
      if (never === 'metadata') return { refused: this.refuse('metadata') };
      if (never === 'loopback') {
        if (loopbackFixture) continue;
        return { refused: this.refuse('loopback') };
      }
      if (this.ownAddresses.has(lower) && !privateOk)
        return { refused: this.refuse('own-address') };
      if (isPrivateAddress(lower) && !privateOk) return { refused: this.refuse('private') };
    }
    this.stats.connections++;
    this.pageHosts.add(host);
    this.stats.hosts = this.pageHosts.size;
    return { ip: addresses[0]! };
  }

  private countBytes(n: number, sockets: net.Socket[]): void {
    this.stats.bytes += n;
    if (this.stats.bytes > this.budget.bytes) {
      this.stats.overBudget = true;
      for (const s of sockets) s.destroy();
    }
  }

  private async onConnect(
    req: http.IncomingMessage,
    client: net.Socket,
    head: Buffer,
  ): Promise<void> {
    client.on('error', () => {});
    const m = /^(.+):(\d+)$/.exec(req.url ?? '');
    if (!m) {
      this.refuse('bad-request');
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const port = Number(m[2]);
    const pinned = await this.pin(m[1]!, port);
    if ('refused' in pinned) {
      log.debug(`refused CONNECT ${m[1]}:${port} (${pinned.refused})`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: pinned.ip, port });
    this.tunnels.add(client);
    this.tunnels.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      upstream.destroy();
      this.tunnels.delete(client);
    });
    upstream.on('close', () => {
      client.destroy();
      this.tunnels.delete(upstream);
    });
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('data', (chunk: Buffer) => this.countBytes(chunk.length, [client, upstream]));
      upstream.pipe(client);
      client.pipe(upstream);
    });
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      this.refuse('bad-request');
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      this.refuse('bad-request');
      res.writeHead(400).end();
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !this.opts.allowScriptPost) {
      this.refuse('method');
      res.writeHead(403).end();
      return;
    }
    const port = Number(target.port || 80);
    const pinned = await this.pin(target.hostname, port);
    if ('refused' in pinned) {
      log.debug(`refused ${method} ${redactPageUrl(target.href)} (${pinned.refused})`);
      res.writeHead(403).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request(
      {
        host: pinned.ip,
        port,
        method,
        path: `${target.pathname}${target.search}`,
        headers,
        // Never pool: a pooled socket could be reused for another host.
        agent: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.on('data', (chunk: Buffer) => {
          const sockets = [res.socket, upstream.socket].filter((s): s is net.Socket => Boolean(s));
          this.countBytes(chunk.length, sockets);
        });
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}

function emptyStats(): PageNetworkStats {
  return { bytes: 0, connections: 0, hosts: 0, refused: {}, overBudget: false };
}
