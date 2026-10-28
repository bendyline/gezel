/**
 * Finding gezel servers on the local network without typing an address:
 * DNS-SD over multicast DNS (RFC 6762 / RFC 6763), service type
 * `_gezel._tcp`.
 *
 * - The **advertiser** runs beside the LAN serving listener, only while it
 *   listens. It answers queries for `_gezel._tcp.local` with a PTR to this
 *   server's instance, an SRV naming its port, a TXT carrying its identity
 *   fingerprint and display name, and an A record per LAN address. It
 *   announces on start and says goodbye (TTL 0) on stop.
 * - The **browser** runs only while someone has Settings → Remote Servers
 *   open. It sends one-shot "legacy unicast" queries from an ephemeral port
 *   (RFC 6762 §6.7), so responders answer it directly by unicast: it never
 *   has to bind 5353 beside the OS's own responder, and a stateful firewall
 *   admits the replies as responses to its own query.
 *
 * Nothing here is a trust decision. An advertisement only fills in an
 * address; pairing still fetches the server's identity itself and the person
 * still compares the identity code with the other screen. The fingerprint in
 * the TXT record is the one `/v1/identity` already hands to anyone on the
 * network, and it is used here to mark servers this device has paired with.
 *
 * Set `GEZEL_LAN_DISCOVERY=off` to disable both halves (the test suites do,
 * so a test service never announces itself on a developer's network).
 */

import { randomInt } from 'node:crypto';
import { type RemoteInfo, type Socket, createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { createLogger } from '@bendyline/gezel';
import {
  DNS_TYPE_A,
  DNS_TYPE_ANY,
  DNS_TYPE_PTR,
  DNS_TYPE_SRV,
  DNS_TYPE_TXT,
  type DnsMessage,
  type DnsRecord,
  decodeDnsMessage,
  encodeDnsMessage,
  sameDnsName,
} from './dns-sd.js';
import { type LanAddress, listLanAddresses } from './lan-addresses.js';

const log = createLogger('lan-discovery');

export const GEZEL_SERVICE_TYPE = '_gezel._tcp.local';
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const MULTICAST_TTL_SEC = 120;
/** RFC 6762 §6.7: an answer to a legacy unicast query carries at most a 10 s TTL. */
const LEGACY_TTL_SEC = 10;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_DISCOVERED = 64;

export function lanDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GEZEL_LAN_DISCOVERY?.trim().toLowerCase();
  return value !== '0' && value !== 'off' && value !== 'false';
}

/** The machine name a person recognizes: `Mikes-MacBook.local` → `Mikes-MacBook`. */
export function displayHostname(raw: string = osHostname()): string {
  return raw.replace(/\.local\.?$/i, '').slice(0, 63) || 'gezel';
}

export interface AdvertisedServer {
  port: number;
  fingerprint: string;
  name: string;
  /** IPv4 addresses peers can reach the listener on. Empty → nothing to announce. */
  addresses: string[];
}

export interface DiscoveredServer {
  name: string;
  fingerprint: string;
  address: string;
  port: number;
  baseUrl: string;
  lastSeenAt: number;
}

// ── Records ─────────────────────────────────────────────────────────────

function serviceRecords(server: AdvertisedServer, ttl: number, cacheFlush: boolean) {
  // The fingerprint prefix keeps two machines that share a hostname from
  // colliding without the probing dance RFC 6762 §8 uses to rename one.
  const label = `gezel-${server.fingerprint.slice(0, 16)}`;
  const instance = `${label}.${GEZEL_SERVICE_TYPE}`;
  const host = `${label}.local`;
  const ptr: DnsRecord = {
    name: GEZEL_SERVICE_TYPE,
    ttl,
    data: { type: DNS_TYPE_PTR, name: instance },
  };
  const srv: DnsRecord = {
    name: instance,
    ttl,
    cacheFlush,
    data: { type: DNS_TYPE_SRV, priority: 0, weight: 0, port: server.port, target: host },
  };
  const txt: DnsRecord = {
    name: instance,
    ttl,
    cacheFlush,
    data: {
      type: DNS_TYPE_TXT,
      entries: ['v=1', `fp=${server.fingerprint}`, `name=${server.name}`],
    },
  };
  const a: DnsRecord[] = server.addresses.map((address) => ({
    name: host,
    ttl,
    cacheFlush,
    data: { type: DNS_TYPE_A, address },
  }));
  return { instance, host, ptr, srv, txt, a };
}

/** An unsolicited announcement (`ttlSec: 0` is the goodbye). */
export function announcement(server: AdvertisedServer, ttlSec = MULTICAST_TTL_SEC): Buffer {
  const r = serviceRecords(server, ttlSec, true);
  return encodeDnsMessage({ isResponse: true, answers: [r.ptr, r.srv, r.txt, ...r.a] });
}

/**
 * The answer to one query, or null when it asks nothing about this server.
 * A legacy query (sent from a port other than 5353) gets its id and
 * questions echoed and short TTLs without cache-flush bits, per RFC 6762
 * §6.7; a standard one gets a plain multicast-shaped response.
 */
export function answerQuery(
  query: DnsMessage,
  server: AdvertisedServer,
  legacy: boolean,
): Buffer | null {
  if (query.isResponse || query.questions.length === 0) return null;
  const r = serviceRecords(server, legacy ? LEGACY_TTL_SEC : MULTICAST_TTL_SEC, !legacy);
  const answers: DnsRecord[] = [];
  const add = (record: DnsRecord) => {
    if (!answers.includes(record)) answers.push(record);
  };
  for (const q of query.questions) {
    const any = q.type === DNS_TYPE_ANY;
    if (sameDnsName(q.name, GEZEL_SERVICE_TYPE) && (any || q.type === DNS_TYPE_PTR)) add(r.ptr);
    if (sameDnsName(q.name, r.instance)) {
      if (any || q.type === DNS_TYPE_SRV) add(r.srv);
      if (any || q.type === DNS_TYPE_TXT) add(r.txt);
    }
    if (sameDnsName(q.name, r.host) && (any || q.type === DNS_TYPE_A)) r.a.forEach(add);
  }
  if (answers.length === 0) return null;
  const additionals = [r.srv, r.txt, ...r.a].filter((record) => !answers.includes(record));
  return encodeDnsMessage({
    id: legacy ? query.id : 0,
    isResponse: true,
    ...(legacy ? { questions: query.questions } : {}),
    answers,
    additionals,
  });
}

function cleanName(raw: string | undefined): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters a peer put in its name is the point.
  const cleaned = raw?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, 80) : undefined;
}

/**
 * Every gezel server a response describes. `source` is the address the
 * response came from: the responder's OS picked it to reach us, so it is the
 * one to dial — unless the server advertised specific addresses without it,
 * which happens when its listener is bound to one interface.
 */
export function discoveredServersIn(
  message: DnsMessage,
  source: string,
  now: number,
): DiscoveredServer[] {
  if (!message.isResponse) return [];
  const servers: DiscoveredServer[] = [];
  for (const ptr of message.records) {
    if (ptr.data.type !== DNS_TYPE_PTR || !sameDnsName(ptr.name, GEZEL_SERVICE_TYPE)) continue;
    if (ptr.ttl === 0) continue;
    const instance = ptr.data.name;
    let srv: { port: number; target: string } | undefined;
    let txt: string[] | undefined;
    for (const record of message.records) {
      if (!sameDnsName(record.name, instance)) continue;
      if (record.data.type === DNS_TYPE_SRV) srv = record.data;
      if (record.data.type === DNS_TYPE_TXT) txt = record.data.entries;
    }
    if (!srv || !txt || srv.port < 1 || srv.port > 65535) continue;
    const fields = new Map<string, string>();
    for (const entry of txt) {
      const eq = entry.indexOf('=');
      if (eq > 0) fields.set(entry.slice(0, eq).toLowerCase(), entry.slice(eq + 1));
    }
    const fingerprint = fields.get('fp')?.toLowerCase();
    if (!fingerprint || !FINGERPRINT.test(fingerprint)) continue;
    const target = srv.target;
    const advertised = message.records.flatMap((record) =>
      record.data.type === DNS_TYPE_A && sameDnsName(record.name, target)
        ? [record.data.address]
        : [],
    );
    const sourceUsable = isIPv4(source) && !source.startsWith('169.254.');
    const address =
      sourceUsable && (advertised.length === 0 || advertised.includes(source))
        ? source
        : advertised[0];
    if (!address) continue;
    servers.push({
      name: cleanName(fields.get('name')) ?? address,
      fingerprint,
      address,
      port: srv.port,
      baseUrl: `https://${address}:${srv.port}`,
      lastSeenAt: now,
    });
  }
  return servers;
}

// ── Sockets ─────────────────────────────────────────────────────────────

function sendTo(socket: Socket, buf: Buffer, port: number, address: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.send(buf, port, address, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * One datagram to the mDNS group out of each interface. Sends are awaited
 * one at a time because the outgoing interface is a socket option, and
 * switching it under a queued send would route that send out the wrong one.
 */
async function sendMulticast(socket: Socket, buf: Buffer, addresses: string[]): Promise<void> {
  if (addresses.length === 0) {
    await sendTo(socket, buf, MDNS_PORT, MDNS_GROUP);
    return;
  }
  for (const address of addresses) {
    try {
      socket.setMulticastInterface(address);
    } catch {
      continue;
    }
    await sendTo(socket, buf, MDNS_PORT, MDNS_GROUP);
  }
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function bindSocket(socket: Socket, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

function sameServer(a: AdvertisedServer, b: AdvertisedServer): boolean {
  return (
    a.port === b.port &&
    a.fingerprint === b.fingerprint &&
    a.name === b.name &&
    a.addresses.join(',') === b.addresses.join(',')
  );
}

export interface LanAdvertiser {
  /** Starts advertising, or re-announces after a change. Never throws. */
  advertise(server: AdvertisedServer): Promise<void>;
  /** Says goodbye and closes the socket. Never throws. */
  stop(): Promise<void>;
}

export function createLanAdvertiser(
  opts: {
    /** Test seam: a port other than 5353, with no multicast group joined. */
    port?: number;
    multicast?: boolean;
  } = {},
): LanAdvertiser & { boundPort(): number | undefined } {
  const listenPort = opts.port ?? MDNS_PORT;
  const multicast = opts.multicast ?? true;
  let socket: Socket | null = null;
  let current: AdvertisedServer | null = null;
  let repeatTimer: NodeJS.Timeout | null = null;
  let lastMulticastAt = 0;
  let warnedBind = false;
  const joined = new Set<string>();

  const joinGroups = (addresses: string[]) => {
    if (!socket || !multicast) return;
    for (const address of addresses) {
      if (joined.has(address)) continue;
      try {
        socket.addMembership(MDNS_GROUP, address);
        joined.add(address);
      } catch (err) {
        log.debug(`[lan-discovery] could not join mDNS on ${address}: ${(err as Error).message}`);
      }
    }
  };

  const onQuery = (msg: Buffer, rinfo: RemoteInfo) => {
    const server = current;
    const active = socket;
    if (!server || !active) return;
    let query: DnsMessage;
    try {
      query = decodeDnsMessage(msg);
    } catch {
      return;
    }
    const legacy = rinfo.port !== MDNS_PORT;
    // Anyone on the network can send this packet, and a throw here is
    // uncaught: it would end the daemon, not just this answer.
    let response: Buffer | null;
    try {
      response = answerQuery(query, server, legacy);
    } catch (err) {
      log.debug(`[lan-discovery] could not answer a query: ${(err as Error).message}`);
      return;
    }
    if (!response) return;
    if (legacy || query.questions.some((q) => q.unicastResponse)) {
      void sendTo(active, response, rinfo.port, rinfo.address);
      return;
    }
    // RFC 6762 §6: at most one multicast answer per second.
    const now = Date.now();
    if (now - lastMulticastAt < 1000) return;
    lastMulticastAt = now;
    void sendMulticast(active, response, server.addresses);
  };

  const open = async (): Promise<Socket | null> => {
    const next = createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await bindSocket(next, listenPort);
    } catch (err) {
      await closeSocket(next);
      if (!warnedBind) {
        warnedBind = true;
        log.warn(
          `[lan-discovery] cannot listen for discovery queries on UDP ${listenPort} ` +
            `(${(err as Error).message}); other devices will need this device's address`,
        );
      }
      return null;
    }
    if (multicast) {
      try {
        next.setMulticastTTL(255);
        next.setMulticastLoopback(true);
      } catch {
        /* defaults are fine */
      }
    }
    next.on('error', (err) => log.debug(`[lan-discovery] advertiser socket: ${err.message}`));
    next.on('message', onQuery);
    return next;
  };

  const stop = async (): Promise<void> => {
    if (repeatTimer) clearTimeout(repeatTimer);
    repeatTimer = null;
    const active = socket;
    const server = current;
    socket = null;
    current = null;
    joined.clear();
    if (!active) return;
    if (server && multicast) await sendMulticast(active, announcement(server, 0), server.addresses);
    await closeSocket(active);
  };

  return {
    boundPort: () => {
      try {
        return socket?.address().port;
      } catch {
        return undefined;
      }
    },
    async advertise(server) {
      if (server.addresses.length === 0 || !FINGERPRINT.test(server.fingerprint)) {
        await stop();
        return;
      }
      if (socket && current && sameServer(current, server)) return;
      const previous = current;
      if (!socket) {
        socket = await open();
        if (!socket) return;
      }
      current = server;
      joinGroups(server.addresses);
      if (!multicast) return;
      const active = socket;
      if (previous && previous.fingerprint === server.fingerprint) {
        // Retract the old port/addresses before announcing the new ones.
        await sendMulticast(active, announcement(previous, 0), previous.addresses);
      }
      // RFC 6762 §8.3: announce at least twice, a second apart.
      await sendMulticast(active, announcement(server), server.addresses);
      lastMulticastAt = Date.now();
      if (repeatTimer) clearTimeout(repeatTimer);
      repeatTimer = setTimeout(() => {
        repeatTimer = null;
        if (socket === active && current === server) {
          void sendMulticast(active, announcement(server), server.addresses);
        }
      }, 1000);
      repeatTimer.unref?.();
    },
    stop,
  };
}

export interface LanBrowser {
  /**
   * The gezel servers that answered recently. Starting a browse waits
   * briefly for the first answers; later calls return at once and re-query
   * in passing.
   */
  browse(opts?: { waitMs?: number }): Promise<DiscoveredServer[]>;
  close(): Promise<void>;
}

export function createLanBrowser(
  opts: {
    /** Test seam: query this address instead of the mDNS group. */
    target?: { address: string; port: number };
    interfaces?: () => LanAddress[];
    /** Close the socket after this long without a browse. */
    idleMs?: number;
    requeryMs?: number;
    /** Forget a server not heard from for this long. */
    expireMs?: number;
  } = {},
): LanBrowser {
  const interfaces = opts.interfaces ?? (() => listLanAddresses());
  const idleMs = opts.idleMs ?? 60_000;
  const requeryMs = opts.requeryMs ?? 2_500;
  const expireMs = opts.expireMs ?? 20_000;
  const found = new Map<string, DiscoveredServer>();
  const recentIds: number[] = [];
  let socket: Socket | null = null;
  let opening: Promise<Socket | null> | null = null;
  let lastBrowseAt = 0;
  let lastQueryAt = 0;
  let warmUntil = 0;
  let idleTimer: NodeJS.Timeout | null = null;

  const onResponse = (msg: Buffer, rinfo: RemoteInfo) => {
    let message: DnsMessage;
    try {
      message = decodeDnsMessage(msg);
    } catch {
      return;
    }
    if (!message.isResponse || !recentIds.includes(message.id)) return;
    for (const server of discoveredServersIn(message, rinfo.address, Date.now())) {
      if (!found.has(server.fingerprint) && found.size >= MAX_DISCOVERED) continue;
      found.set(server.fingerprint, server);
    }
  };

  const close = async (): Promise<void> => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const active = socket;
    socket = null;
    opening = null;
    found.clear();
    if (active) await closeSocket(active);
  };

  const armIdle = () => {
    if (idleTimer) return;
    idleTimer = setTimeout(function check() {
      const idleFor = Date.now() - lastBrowseAt;
      if (idleFor >= idleMs) {
        idleTimer = null;
        void close();
        return;
      }
      idleTimer = setTimeout(check, idleMs - idleFor);
      idleTimer.unref?.();
    }, idleMs);
    idleTimer.unref?.();
  };

  const open = async (): Promise<Socket | null> => {
    const next = createSocket({ type: 'udp4' });
    try {
      await bindSocket(next, 0);
    } catch (err) {
      await closeSocket(next);
      log.warn(`[lan-discovery] cannot open a discovery socket: ${(err as Error).message}`);
      return null;
    }
    next.on('error', (err) => log.debug(`[lan-discovery] browser socket: ${err.message}`));
    next.on('message', onResponse);
    return next;
  };

  const query = async (active: Socket) => {
    const id = randomInt(1, 0x10000);
    recentIds.push(id);
    if (recentIds.length > 8) recentIds.shift();
    lastQueryAt = Date.now();
    const buf = encodeDnsMessage({
      id,
      questions: [{ name: GEZEL_SERVICE_TYPE, type: DNS_TYPE_PTR }],
    });
    if (opts.target) {
      await sendTo(active, buf, opts.target.port, opts.target.address);
      return;
    }
    await sendMulticast(
      active,
      buf,
      interfaces().map((a) => a.address),
    );
  };

  return {
    async browse(browseOpts = {}) {
      lastBrowseAt = Date.now();
      armIdle();
      let fresh = false;
      if (!socket) {
        opening ??= open();
        const opened = await opening;
        if (!opened) {
          opening = null;
          return [];
        }
        if (!socket) {
          socket = opened;
          fresh = true;
          warmUntil = Date.now() + (browseOpts.waitMs ?? 1200);
        }
      }
      const active = socket;
      if (fresh || Date.now() - lastQueryAt >= requeryMs) await query(active);
      const wait = warmUntil - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const cutoff = Date.now() - expireMs;
      for (const [key, server] of found) {
        if (server.lastSeenAt < cutoff) found.delete(key);
      }
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    close,
  };
}
