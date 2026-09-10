import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CertificateVerifyHandler,
  type CertificateVerifySession,
  createLoopbackCertificatePin,
} from './loopback-certificate-pin.js';

const DER = Buffer.from('daemon certificate');
const CERTIFICATE = `-----BEGIN CERTIFICATE-----\n${DER.toString('base64')}\n-----END CERTIFICATE-----`;
const FINGERPRINT = createHash('sha256').update(DER).digest('base64');

function harness() {
  let handler: CertificateVerifyHandler | null = null;
  const rendererSession: CertificateVerifySession = {
    setCertificateVerifyProc(next) {
      handler = next;
    },
  };
  const pin = createLoopbackCertificatePin();
  pin.install(rendererSession);
  if (!handler) throw new Error('certificate verifier was not installed');

  return { handler, pin };
}

function decision(
  handler: CertificateVerifyHandler,
  hostname: string,
  fingerprint = `sha256/${FINGERPRINT}`,
): number {
  let result: number | undefined;
  handler(
    { hostname, certificate: { fingerprint } } as Parameters<CertificateVerifyHandler>[0],
    (value) => {
      result = value;
    },
  );
  if (result === undefined) throw new Error('certificate verifier did not invoke its callback');
  return result;
}

describe('loopback certificate pin', () => {
  it('defers non-loopback certificate validation to Chromium', () => {
    const { handler } = harness();

    expect(decision(handler, 'example.com')).toBe(-3);
  });

  it('fails closed until the daemon certificate is pinned', () => {
    const { handler } = harness();

    expect(decision(handler, '127.0.0.1')).toBe(-2);
  });

  it('trusts only the current daemon certificate on loopback', () => {
    const { handler, pin } = harness();
    pin.setCertificate(CERTIFICATE);

    expect(decision(handler, 'localhost')).toBe(0);
    expect(decision(handler, '::1', 'sha256/not-the-pin')).toBe(-2);

    pin.setCertificate(null);
    expect(decision(handler, '127.0.0.1')).toBe(-2);
  });
});
