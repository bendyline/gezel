/**
 * Per-launch self-signed certificate for the daemon's loopback HTTPS
 * server. The point of TLS here is HTTP/2 multiplexing in the renderer,
 * not authentication — Chromium won't speak HTTP/2 over plain TCP, so
 * we serve TLS even on `127.0.0.1`. The cert lives in memory for the
 * lifetime of the process; the public PEM is also written to
 * `~/.gezel/runtime/cert.pem` so external clients (CLI, ad-hoc curl)
 * can pin it.
 *
 * Lifetime mirrors the per-launch auth token: a fresh cert per process
 * start. The fingerprint is what the Electron renderer pins via
 * `session.setCertificateVerifyProc` — that's the actual security
 * boundary. The cert subject CN doesn't matter; SAN matching does.
 */

import { createHash } from 'node:crypto';
import { generate as selfsignedGenerate } from 'selfsigned';

export interface LoopbackCert {
  /** PEM-encoded X.509 cert. Public material — safe to write to disk. */
  certPem: string;
  /** PEM-encoded RSA-2048 private key. Memory-only; never persisted. */
  keyPem: string;
  /** Hex SHA-256 of the DER cert. Used in the runtime fingerprint file. */
  sha256Hex: string;
  /**
   * Base64 SHA-256 of the DER cert. This is the format Chromium uses
   * in `request.certificate.fingerprint` (prefixed with `sha256/`),
   * so the renderer's verify proc can compare directly.
   */
  fingerprintBase64: string;
}

/**
 * Validity window. One day is plenty for a per-launch cert; long
 * enough that a developer leaving the daemon running overnight
 * doesn't get bitten by clock-skew rounding, short enough that a
 * leaked PEM ages out quickly.
 */
const CERT_VALIDITY_DAYS = 1;

export async function generateLoopbackCert(): Promise<LoopbackCert> {
  const now = new Date();
  const notAfter = new Date(now.getTime() + CERT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const pems = await selfsignedGenerate([{ name: 'commonName', value: 'gezel-loopback' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: now,
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      {
        // serverAuth EKU is what TLS verifiers look for. clientAuth
        // intentionally absent — daemon never authenticates as a
        // client to itself.
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: false,
        critical: true,
      },
      {
        // Modern TLS clients (Chrome especially) require the host
        // to appear as an IP-type SAN entry; CN-only matching has
        // been off by default since Chrome 58. type 7 = iPAddress.
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          { type: 2, value: 'localhost' },
        ],
      },
    ],
  });

  // Compute our own SHA-256 over the raw DER. selfsigned exposes a
  // `fingerprint` field but uses SHA-1 by default; doing it ourselves
  // keeps the encoding (hex + base64) deterministic and matches
  // Chromium's `sha256/<base64>` exactly.
  const der = pemToDer(pems.cert);
  const digest = createHash('sha256').update(der).digest();
  return {
    certPem: pems.cert,
    keyPem: pems.private,
    sha256Hex: digest.toString('hex'),
    fingerprintBase64: digest.toString('base64'),
  };
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .split('\n')
    .filter((line) => !line.startsWith('-----') && line.trim().length > 0)
    .join('');
  return Buffer.from(body, 'base64');
}
