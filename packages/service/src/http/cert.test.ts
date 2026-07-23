import { X509Certificate, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateLoopbackCert } from './cert.js';

describe('generateLoopbackCert', () => {
  it('produces a parseable X.509 cert with the expected SAN entries', async () => {
    const cert = await generateLoopbackCert();
    const x509 = new X509Certificate(cert.certPem);
    // Modern Chromium will only honour SAN matches; CN is informational.
    // Both loopback addresses must be covered, plus `localhost` for users
    // who type the hostname instead of the literal IP.
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(x509.subjectAltName).toContain('IP Address:0:0:0:0:0:0:0:1');
    expect(x509.subjectAltName).toContain('DNS:localhost');
  });

  it('uses RSA-2048 with the right key shape', async () => {
    const cert = await generateLoopbackCert();
    const key = createPublicKey(cert.certPem);
    const details = key.asymmetricKeyDetails;
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(details?.modulusLength).toBe(2048);
  });

  it('sets validity to about a day from now', async () => {
    const cert = await generateLoopbackCert();
    const x509 = new X509Certificate(cert.certPem);
    const validFrom = new Date(x509.validFrom).getTime();
    const validTo = new Date(x509.validTo).getTime();
    const span = validTo - validFrom;
    // 1 day window. Allow ±60 s for clock-rounding inside selfsigned.
    expect(span).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 60_000);
    expect(span).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000);
  });

  it('returns a fingerprint that matches the cert', async () => {
    const cert = await generateLoopbackCert();
    const x509 = new X509Certificate(cert.certPem);
    // Node's `fingerprint256` is colon-separated uppercase hex; normalise
    // both sides to lowercase, no separators, before comparing.
    const nodeFp = x509.fingerprint256.replace(/:/g, '').toLowerCase();
    expect(cert.sha256Hex.toLowerCase()).toBe(nodeFp);
    // Chromium's session.setCertificateVerifyProc reports the same
    // digest as `sha256/<base64>`. Confirm the base64 matches.
    expect(Buffer.from(cert.sha256Hex, 'hex').toString('base64')).toBe(cert.fingerprintBase64);
  });

  it('does not leak the private key into the cert PEM', async () => {
    const cert = await generateLoopbackCert();
    expect(cert.certPem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(cert.certPem).not.toContain('PRIVATE KEY');
    // selfsigned emits keys in PKCS#8 (`-----BEGIN PRIVATE KEY-----`)
    // not PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`). Either is valid
    // PEM for tls.createSecureContext, but the format we observe matters
    // for any downstream tool that does string-level inspection.
    expect(cert.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('rotates on every call (per-launch model)', async () => {
    const a = await generateLoopbackCert();
    const b = await generateLoopbackCert();
    expect(a.sha256Hex).not.toBe(b.sha256Hex);
    expect(a.keyPem).not.toBe(b.keyPem);
  });
});
