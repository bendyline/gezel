import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Keep deterministic bridge listeners out of the privileged and IANA dynamic
 * port ranges while spreading user homes across a large enough space that two
 * accounts on one machine are unlikely to collide.
 */
export const CODEX_BRIDGE_PORT_RANGE_START = 20_000;
export const CODEX_BRIDGE_PORT_RANGE_END = 49_151;

const CODEX_BRIDGE_PORT_RANGE_SIZE =
  CODEX_BRIDGE_PORT_RANGE_END - CODEX_BRIDGE_PORT_RANGE_START + 1;

/**
 * Derive the stable loopback port used by one Gezel home.
 *
 * The port is only an address, never an authentication secret. The bridge's
 * bearer token remains mandatory. Canonicalizing first ensures a symlinked or
 * lexically equivalent home does not create a second Codex bridge identity.
 */
export function codexBridgePortForHome(home: string): number {
  const digest = createHash('sha256').update(canonicalPath(home)).digest();
  const bucket = digest.readUInt32BE(0) % CODEX_BRIDGE_PORT_RANGE_SIZE;
  return CODEX_BRIDGE_PORT_RANGE_START + bucket;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
