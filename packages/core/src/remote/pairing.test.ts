import { describe, expect, it } from 'vitest';
import { bytesToBase64, derToPem, toArrayBuffer, utf8, webCrypto } from './bytes.js';
import {
  type RemoteIdentity,
  certFingerprintFromPem,
  createClientIdentity,
  fingerprintOfPublicKeyPem,
} from './identity.js';
import {
  type RemoteFetch,
  type RemoteHttp,
  normalizePairingCode,
  normalizeServerOrigin,
  pairWithConnectCode,
  readServerIdentity,
} from './pairing.js';

const subtle = webCrypto;
type SubtleKey = Parameters<ReturnType<typeof subtle>['exportKey']>[1];

function fakeCertificatePem(): string {
  return derToPem(globalThis.crypto.getRandomValues(new Uint8Array(96)), 'CERTIFICATE');
}

/** A server identity whose Ed25519 key signed the certificate it presents. */
async function signedIdentity(): Promise<RemoteIdentity> {
  const pair = (await subtle().generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as { publicKey: SubtleKey; privateKey: SubtleKey };
  const publicKeyPem = derToPem(
    new Uint8Array(await subtle().exportKey('spki', pair.publicKey)),
    'PUBLIC KEY',
  );
  const tlsCertPem = fakeCertificatePem();
  const tlsCertFingerprint = await certFingerprintFromPem(tlsCertPem);
  const sig = new Uint8Array(
    await subtle().sign(
      { name: 'Ed25519' },
      pair.privateKey,
      toArrayBuffer(utf8(tlsCertFingerprint)),
    ),
  );
  return {
    deviceId: 'server-b',
    publicKeyPem,
    fingerprint: await fingerprintOfPublicKeyPem(publicKeyPem),
    tlsCertPem,
    tlsCertFingerprint,
    sig: bytesToBase64(sig),
    pairingMethods: ['code', 'approval'],
  };
}

/** The real server's identity, presented beside a certificate it never signed. */
async function relayedIdentity(real: RemoteIdentity): Promise<RemoteIdentity> {
  const tlsCertPem = fakeCertificatePem();
  return { ...real, tlsCertPem, tlsCertFingerprint: await certFingerprintFromPem(tlsCertPem) };
}

function serving(identity: unknown): RemoteHttp & { pinnedCerts: string[] } {
  const pinnedCerts: string[] = [];
  const bootstrap = (async () => Response.json(identity)) as unknown as RemoteFetch;
  return {
    pinnedCerts,
    bootstrap: () => bootstrap,
    pinned: (certPem) => {
      pinnedCerts.push(certPem);
      return (async () => {
        throw new Error('pairing must not reach a pinned channel');
      }) as unknown as RemoteFetch;
    },
  };
}

describe('readServerIdentity', () => {
  it('accepts an identity whose key signed the certificate it presents', async () => {
    const identity = await signedIdentity();
    await expect(readServerIdentity(serving(identity), 'https://10.0.0.4:6229')).resolves.toEqual(
      identity,
    );
  });

  it('refuses the real identity beside a certificate it did not sign', async () => {
    const identity = await signedIdentity();
    await expect(
      readServerIdentity(serving(await relayedIdentity(identity)), 'https://10.0.0.4:6229'),
    ).rejects.toThrow(/doesn't check out/);
  });

  it('refuses an identity that carries no signature', async () => {
    const identity = await signedIdentity();
    const { sig: _sig, ...unsigned } = identity;
    await expect(readServerIdentity(serving(unsigned), 'https://10.0.0.4:6229')).rejects.toThrow(
      /doesn't check out/,
    );
  });
});

describe('pairWithConnectCode', () => {
  it('pins nothing for a relayed identity, whether read or handed in', async () => {
    const identity = await signedIdentity();
    const relayed = await relayedIdentity(identity);
    const client = { ...(await createClientIdentity()), appName: 'test' };

    const read = serving(relayed);
    await expect(
      pairWithConnectCode(read, { baseUrl: '10.0.0.4', code: '48210937', client }),
    ).rejects.toThrow(/doesn't check out/);
    expect(read.pinnedCerts).toEqual([]);

    const handed = serving(identity);
    await expect(
      pairWithConnectCode(handed, {
        baseUrl: '10.0.0.4',
        code: '48210937',
        client,
        identity: relayed,
      }),
    ).rejects.toThrow(/doesn't check out/);
    expect(handed.pinnedCerts).toEqual([]);
  });
});

describe('normalizeServerOrigin', () => {
  it('reads a bare address as HTTPS on the serving port', () => {
    expect(normalizeServerOrigin('192.168.1.50')).toBe('https://192.168.1.50:6229');
    expect(normalizeServerOrigin(' 192.168.1.50:7000 ')).toBe('https://192.168.1.50:7000');
    expect(normalizeServerOrigin('[fe80::1]')).toBe('https://[fe80::1]:6229');
  });

  it('keeps an origin that is already exact', () => {
    expect(normalizeServerOrigin('https://10.0.0.4:6229')).toBe('https://10.0.0.4:6229');
    expect(normalizeServerOrigin('https://10.0.0.4:6229/')).toBe('https://10.0.0.4:6229');
  });

  it('refuses names, plain HTTP, and paths', () => {
    expect(() => normalizeServerOrigin('werkbank.local')).toThrow(/IP address/);
    expect(() => normalizeServerOrigin('http://10.0.0.4:6229')).toThrow(/https/);
    expect(() => normalizeServerOrigin('https://10.0.0.4:6229/v1')).toThrow(/https/);
  });
});

describe('normalizePairingCode', () => {
  it('accepts the code however it was typed', () => {
    expect(normalizePairingCode('4821 0937')).toBe('48210937');
    expect(normalizePairingCode('4821-0937')).toBe('48210937');
    expect(normalizePairingCode('482109')).toBeNull();
  });
});
