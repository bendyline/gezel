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
  const path = canonicalPath(home);
  const digest = createHash('sha256')
    .update(salt === '' ? path : `${path}${SALT_SEPARATOR}${salt}`)
    .digest();
  const bucket = digest.readUInt32BE(0) % LOCAL_BRIDGE_PORT_RANGE_SIZE;
  return LOCAL_BRIDGE_PORT_RANGE_START + bucket;
}

export function codexBridgePortForHome(home: string): number {
  return bridgePortForHome(home);
}

export function opencodeBridgePortForHome(home: string): number {
  const port = bridgePortForHome(home, 'opencode');
  // Two independent digests over one home collide about once in 29k installs.
  // Left alone, the second listener to start reports the other integration's
  // port-conflict message, which sends the user looking for a foreign process
  // that does not exist. Stepping one slot is cheaper than explaining that.
  if (port !== codexBridgePortForHome(home)) return port;
  return port === LOCAL_BRIDGE_PORT_RANGE_END ? LOCAL_BRIDGE_PORT_RANGE_START : port + 1;
}

/**
 * pi is the newest harness, so it is the one that yields: Codex's port is named
 * by profiles already on user disks, and OpenCode's by published config files
 * and the plugin that reads them. Stepping must loop rather than add one, since
 * a single step can land on the *other* harness's port.
 */
export function piBridgePortForHome(home: string): number {
  const taken = new Set([codexBridgePortForHome(home), opencodeBridgePortForHome(home)]);
  let port = bridgePortForHome(home, 'pi');
  while (taken.has(port)) {
    port = port === LOCAL_BRIDGE_PORT_RANGE_END ? LOCAL_BRIDGE_PORT_RANGE_START : port + 1;
  }
  return port;
}

/**
 * The extension-free VS Code endpoint yields to every older integration whose
 * deterministic address may already be present in a published config file.
 */
export function vscodeBridgePortForHome(home: string): number {
  const taken = new Set([
    codexBridgePortForHome(home),
    opencodeBridgePortForHome(home),
    piBridgePortForHome(home),
  ]);
  let port = bridgePortForHome(home, 'vscode');
  while (taken.has(port)) {
    port = port === LOCAL_BRIDGE_PORT_RANGE_END ? LOCAL_BRIDGE_PORT_RANGE_START : port + 1;
  }
  return port;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
