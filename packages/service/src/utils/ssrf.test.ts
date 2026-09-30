import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { SsrfError, assertPublicUrl, isPrivateAddress } from './ssrf.js';

describe('isPrivateAddress', () => {
  it('judges every IPv6 form that carries an IPv4 address as that address', () => {
    // What `new URL()` turns [::ffff:127.0.0.1], [::ffff:169.254.169.254] and
    // [::ffff:192.168.1.1] into. The old dotted-quad match let all three by.
    for (const ip of [
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::ffff:c0a8:101',
      '::ffff:127.0.0.1',
      '0:0:0:0:0:ffff:0a00:0001',
      '::7f00:1', // IPv4-compatible (deprecated)
      '64:ff9b::a9fe:a9fe', // NAT64 well-known prefix
      '64:ff9b::127.0.0.1',
      '2002:7f00:1::', // 6to4
      '2002:c0a8:0101::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('keeps the public addresses those forms can carry', () => {
    for (const ip of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('blocks the IPv6 ranges that are never a public destination', () => {
    for (const ip of [
      '::',
      '::1',
      'fe80::1',
      'fe80::1%eth0',
      'febf::1',
      'fec0::1', // site-local
      'fc00::1',
      'fdff::1',
      'ff02::1', // multicast
      'ff0e::101',
      '64:ff9b:1::a9fe:a9fe', // local-use NAT64
      '2001:0:4136:e378::1', // Teredo
      '2001:db8::1', // documentation
      '100::1', // discard-only
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('keeps the IPv4 rules, including the benchmarking range', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '198.18.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('refuses every spelling of loopback and cloud metadata', async () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2002:a9fe:a9fe::]/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.1/',
      'http://[ff02::1]/',
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('never reaches a loopback-only server through a mapped address', async () => {
    const server = createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await expect(assertPublicUrl(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(
        /private or loopback/,
      );
    } finally {
      server.close();
    }
  });
});
