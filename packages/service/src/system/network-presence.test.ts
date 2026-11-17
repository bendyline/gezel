import type { NetworkInterfaceInfo } from 'node:os';
import { recordSuspensionForTests, resetSuspendClockForTests } from '@bendyline/gezel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasUsableNetwork, networkSignature, watchNetworkPresence } from './network-presence.js';

type Table = NodeJS.Dict<NetworkInterfaceInfo[]>;

function iface(address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

/** A plane: loopback, link-local leftovers, a container bridge. */
const PLANE: Table = {
  lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
  en0: [iface('fe80::1c2a:3bff:fe4d:5e6f', 'IPv6')],
  awdl0: [iface('fe80::aa:bbff:fecc:ddee', 'IPv6')],
  en5: [iface('169.254.12.34', 'IPv4')],
  bridge100: [iface('192.168.64.1', 'IPv4')],
};
const WIFI: Table = { ...PLANE, en0: [iface('192.168.1.23', 'IPv4'), ...(PLANE.en0 ?? [])] };

afterEach(() => {
  vi.useRealTimers();
  resetSuspendClockForTests();
});

describe('network presence', () => {
  it('counts no loopback, link-local or virtual address as a network', () => {
    expect(hasUsableNetwork(PLANE)).toBe(false);
    expect(networkSignature(PLANE)).toBe('');
    expect(hasUsableNetwork(WIFI)).toBe(true);
    expect(hasUsableNetwork({ en0: [iface('2601:600:1:2::5', 'IPv6')] })).toBe(true);
  });

  it('calls back when a network appears and when the host wakes, never when it is lost', () => {
    vi.useFakeTimers();
    let table = WIFI;
    const onChange = vi.fn();
    const stop = watchNetworkPresence(onChange, { intervalMs: 1_000, read: () => table });

    table = PLANE;
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();

    table = WIFI;
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    recordSuspensionForTests(60_000);
    expect(onChange).toHaveBeenCalledTimes(2);

    table = PLANE;
    recordSuspensionForTests(60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });
});
