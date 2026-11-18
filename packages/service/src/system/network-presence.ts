/**
 * Whether this computer has a network it could reach the internet on, read
 * from its own interfaces: no request leaves the machine. A plane with Wi-Fi
 * off, a laptop out of range, a cable pulled — each leaves only loopback,
 * link-local and virtual adapters. A captive portal still has an address, so
 * this answers "might be online", never "is online"; requests decide that.
 *
 * `watchNetworkPresence` calls back when the usable addresses change (joining
 * a network, landing) and when the host wakes from sleep, which is when a
 * connection waiting for the network should try again rather than wait out
 * its retry delay.
 */

import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import { createLogger, onSuspension } from '@bendyline/gezel';

const log = createLogger('network');

/** Adapters no other machine routes to: VMs, containers, hypervisor switches. */
const VIRTUAL_INTERFACE =
  /^(?:vEthernet|docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|podman|kube|cali|weave|bridge)|VirtualBox|VMware|Hyper-V|WSL/i;

function usable(name: string, info: NetworkInterfaceInfo): boolean {
  if (info.internal || VIRTUAL_INTERFACE.test(name)) return false;
  if (info.family === 'IPv4') return !info.address.startsWith('169.254.');
  // fe80::/10 is link-local; every interface has one, network or not.
  return !/^fe[89ab]/i.test(info.address);
}

/** The usable addresses, sorted: equal strings mean the same network. */
export function networkSignature(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const found: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) if (usable(name, info)) found.push(info.address);
  }
  return [...new Set(found)].sort().join(',');
}

/** Whether any interface could carry traffic beyond this machine. */
export function hasUsableNetwork(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): boolean {
  return networkSignature(interfaces) !== '';
}

export interface NetworkPresenceOptions {
  /** How often to read the interfaces (default 10 s). */
  intervalMs?: number;
  /** Test seam for the interface table. */
  read?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/**
 * Call `onChange` when a usable network appears or changes, and after the
 * host wakes. Losing the network calls nothing: there is nothing to retry.
 * Returns the stop function.
 */
export function watchNetworkPresence(
  onChange: () => void,
  opts: NetworkPresenceOptions = {},
): () => void {
  const read = opts.read ?? networkInterfaces;
  let last = networkSignature(read());
  const check = () => {
    const now = networkSignature(read());
    if (now === last) return;
    const joined = now !== '';
    log.info(joined ? 'network available' : 'no network');
    last = now;
    if (joined) onChange();
  };
  const timer = setInterval(check, opts.intervalMs ?? 10_000);
  if (typeof timer.unref === 'function') timer.unref();
  const offSuspension = onSuspension(() => {
    last = networkSignature(read());
    if (last !== '') onChange();
  });
  return () => {
    clearInterval(timer);
    offSuspension();
  };
}
