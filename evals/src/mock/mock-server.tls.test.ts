import { X509Certificate, verify } from 'node:crypto';
import { get } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { type MockServicesRuntime, startMockServices } from './mock-server.ts';

let runtime: MockServicesRuntime | null = null;

afterEach(async () => {
  await runtime?.close();
  runtime = null;
});

function derElement(bytes: Buffer, offset = 0) {
  let cursor = offset + 1;
  let length = bytes[cursor++]!;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++]!;
  }
  const end = cursor + length;
  return { encoded: bytes.subarray(offset, end), content: bytes.subarray(cursor, end), end };
}

describe('mock service TLS certificate', () => {
  it('signs with SHA-256 and serves HTTPS with explicit trust and hostname verification', async () => {
    runtime = await startMockServices([
      { kind: 'webhook', id: 'receiver', description: 'TLS probe', path: '/probe' },
    ]);
    expect(runtime).not.toBeNull();
    const certificate = new X509Certificate(runtime!.caPem);
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificate.checkHost('localhost')).toBe('localhost');
    expect(certificate.checkHost('unrelated.example')).toBeUndefined();
    expect(certificate.ca).toBe(false);

    const sequence = derElement(certificate.raw).content;
    const signed = derElement(sequence);
    const algorithm = derElement(sequence, signed.end);
    const signature = derElement(sequence, algorithm.end).content;
    // sha256WithRSAEncryption OID with NULL parameters, plus the actual signature.
    expect(algorithm.encoded.toString('hex')).toBe('300d06092a864886f70d01010b0500');
    expect(signature[0]).toBe(0);
    expect(verify('sha256', signed.encoded, certificate.publicKey, signature.subarray(1))).toBe(
      true,
    );

    const response = await new Promise<{ authorized: boolean; status: number | undefined }>(
      (resolve, reject) => {
        const request = get(
          `${runtime!.services.get('receiver')!.baseUrl}/probe`,
          { ca: runtime!.caPem, rejectUnauthorized: true, agent: false },
          (res) => {
            res.resume();
            resolve({
              authorized: (request.socket as TLSSocket).authorized,
              status: res.statusCode,
            });
          },
        );
        request.on('error', reject);
      },
    );
    expect(response.authorized).toBe(true);
    expect(response.status).toBe(405);
  });
});
