/**
 * The addresses another device on the network can use to reach this one.
 * Shown in Settings → Remote Servers ("other devices connect at …") and
 * advertised as A records by the LAN discovery responder.
 *
 * IPv4 only: pairing accepts an IP literal, and a bracketed IPv6 origin is
 * not something a person reads aloud to the next desk. Link-local
 * (169.254/16) is dropped because it only appears when DHCP failed, and an
 * address on a virtual adapter (WSL, Hyper-V, Docker, VirtualBox, VMware)
 * sorts last because no other machine can route to it — on Windows the WSL
 * switch is usually the first adapter `os.networkInterfaces()` returns.
 */

import { isIPv4 } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

export interface LanAddress {
  address: string;
  interfaceName: string;
}

const VIRTUAL_INTERFACE =
  /^(?:vEthernet|docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|podman|kube|cali|weave)|VirtualBox|VMware|Hyper-V|WSL/i;

function rangeRank(address: string): number {
  const [a = 0, b = 0] = address.split('.').map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 100 && b >= 64 && b <= 127) return 3;
  return 4;
}

export function listLanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): LanAddress[] {
  const found: Array<LanAddress & { rank: number; order: number }> = [];
  for (const [interfaceName, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || !isIPv4(info.address)) continue;
      if (info.address.startsWith('169.254.')) continue;
      if (found.some((f) => f.address === info.address)) continue;
      const virtual = VIRTUAL_INTERFACE.test(interfaceName) ? 10 : 0;
      found.push({
        address: info.address,
        interfaceName,
        rank: virtual + rangeRank(info.address),
        order: found.length,
      });
    }
  }
  return found
    .sort((x, y) => x.rank - y.rank || x.order - y.order)
    .map(({ address, interfaceName }) => ({ address, interfaceName }));
}
