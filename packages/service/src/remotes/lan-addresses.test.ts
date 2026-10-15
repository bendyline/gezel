import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listLanAddresses } from './lan-addresses.js';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe('listLanAddresses', () => {
  it('keeps routable IPv4 addresses and drops loopback, link-local, and IPv6', () => {
    expect(
      listLanAddresses({
        lo: [v4('127.0.0.1', true)],
        en0: [v4('192.168.1.23'), v6('fe80::1')],
        en5: [v4('169.254.10.4')],
      }),
    ).toEqual([{ address: '192.168.1.23', interfaceName: 'en0' }]);
  });

  it('puts a home network first and virtual adapters last, whatever order the OS reports', () => {
    const addresses = listLanAddresses({
      'vEthernet (WSL)': [v4('172.29.16.1')],
      'Ethernet 2': [v4('10.0.0.8')],
      docker0: [v4('172.17.0.1')],
      'Wi-Fi': [v4('192.168.1.23')],
      tailscale0: [v4('100.101.102.103')],
    }).map((a) => a.address);
    expect(addresses).toEqual([
      '192.168.1.23',
      '10.0.0.8',
      '100.101.102.103',
      '172.29.16.1',
      '172.17.0.1',
    ]);
  });

  it('lists an address shared by two interfaces once', () => {
    expect(
      listLanAddresses({ a: [v4('192.168.1.5')], b: [v4('192.168.1.5')] }).map((a) => a.address),
    ).toEqual(['192.168.1.5']);
  });
});
