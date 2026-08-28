import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Keep deterministic bridge listeners out of the privileged and IANA dynamic
 * port ranges while spreading user homes across a large enough space that two
 * accounts on one machine are unlikely to collide.
 */
export const LOCAL_BRIDGE_PORT_RANGE_START = 20_000;
export const LOCAL_BRIDGE_PORT_RANGE_END = 49_151;

const LOCAL_BRIDGE_PORT_RANGE_SIZE =
  LOCAL_BRIDGE_PORT_RANGE_END - LOCAL_BRIDGE_PORT_RANGE_START + 1;

/** Separator no filesystem path can contain, so a home cannot forge a salt. */
const SALT_SEPARATOR = String.fromCharCode(0);

/**
 * Derive the stable loopback port one Gezel home uses for one integration.
 *
 * The port is only an address, never an authentication secret. Every bridge's
 * bearer token remains mandatory. Canonicalizing first ensures a symlinked or
 * lexically equivalent home does not create a second bridge identity.
 *
 * `salt` separates integrations sharing a home. The empty salt reproduces the
 * pre-salt digest exactly — Codex profiles already published to user disks
 * name that port, so it is not ours to move.
 */
export function bridgePortForHome(home: string, salt = ''): number {
  return portForCanonicalHome(canonicalPath(home), salt);
}

/**
 * Every derivation below is a function of the *canonical* home, and the later
 * integrations need their predecessors' ports to step off a collision. Taking
 * the canonical path as the parameter means one `realpathSync` per public
 * call instead of one per digest — the VS Code port alone needed eight, and
 * `realpathSync` on a path that does not exist is a failed syscall plus a
 * thrown exception, two orders of magnitude dearer than the sha256 it feeds.
 */
function portForCanonicalHome(path: string, salt: string): number {
  const digest = createHash('sha256')
    .update(salt === '' ? path : `${path}${SALT_SEPARATOR}${salt}`)
    .digest();
  const bucket = digest.readUInt32BE(0) % LOCAL_BRIDGE_PORT_RANGE_SIZE;
  return LOCAL_BRIDGE_PORT_RANGE_START + bucket;
}

/** Next slot in the range, wrapping at the top. */
function stepPort(port: number): number {
  return port === LOCAL_BRIDGE_PORT_RANGE_END ? LOCAL_BRIDGE_PORT_RANGE_START : port + 1;
}

/** First port for `salt` that none of the older integrations already claimed. */
function firstFreePort(path: string, salt: string, taken: ReadonlySet<number>): number {
  let port = portForCanonicalHome(path, salt);
  while (taken.has(port)) port = stepPort(port);
  return port;
}

function codexPort(path: string): number {
  return portForCanonicalHome(path, '');
}

function opencodePort(path: string): number {
  const port = portForCanonicalHome(path, 'opencode');
  // Two independent digests over one home collide about once in 29k installs.
  // Left alone, the second listener to start reports the other integration's
  // port-conflict message, which sends the user looking for a foreign process
  // that does not exist. Stepping one slot is cheaper than explaining that.
  return port === codexPort(path) ? stepPort(port) : port;
}

function piPort(path: string): number {
  return firstFreePort(path, 'pi', new Set([codexPort(path), opencodePort(path)]));
}

export function codexBridgePortForHome(home: string): number {
  return codexPort(canonicalPath(home));
}

export function opencodeBridgePortForHome(home: string): number {
  return opencodePort(canonicalPath(home));
}

/**
 * pi is the newest harness, so it is the one that yields: Codex's port is named
 * by profiles already on user disks, and OpenCode's by published config files
 * and the plugin that reads them. Stepping must loop rather than add one, since
 * a single step can land on the *other* harness's port.
 */
export function piBridgePortForHome(home: string): number {
  return piPort(canonicalPath(home));
}

/**
 * The extension-free VS Code endpoint yields to every older integration whose
 * deterministic address may already be present in a published config file.
 */
export function vscodeBridgePortForHome(home: string): number {
  const path = canonicalPath(home);
  return firstFreePort(
    path,
    'vscode',
    new Set([codexPort(path), opencodePort(path), piPort(path)]),
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
