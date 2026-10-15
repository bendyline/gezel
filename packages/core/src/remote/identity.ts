/**
 * Device identities for remote serving, in the form both a daemon and a phone
 * can check: `GET /v1/identity`'s shape, how its signature is verified, and a
 * fresh identity for a device that has none (the phone).
 *
 * A fingerprint is the hex SHA-256 of the public key's SPKI DER — the same
 * value `fingerprintOfPublicKeyPem` computes on the desktop, so a phone's
 * pinned fingerprint and a daemon's own agree byte for byte.
 */

import { z } from 'zod';
import { bytesToHex, derToPem, pemToDer, toArrayBuffer, utf8, webCrypto } from './bytes.js';

export const RemoteIdentitySchema = z.object({
  deviceId: z.string(),
  publicKeyPem: z.string(),
  fingerprint: z.string(),
  tlsCertFingerprint: z.string().optional(),
  tlsCertPem: z.string().optional(),
  sig: z.string().optional(),
  gezelVersion: z.string().optional(),
  protocolVersion: z.number().optional(),
  serviceRole: z.string().optional(),
  pairingMethods: z.array(z.string()).max(8).optional(),
});
export type RemoteIdentity = z.infer<typeof RemoteIdentitySchema>;

const subtle = webCrypto;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await subtle().digest('SHA-256', toArrayBuffer(bytes))));
}

export async function fingerprintOfPublicKeyPem(publicKeyPem: string): Promise<string> {
  return sha256Hex(pemToDer(publicKeyPem));
}

export async function certFingerprintFromPem(certPem: string): Promise<string> {
  return sha256Hex(pemToDer(certPem));
}

/**
 * Whether a `/v1/identity` answer is internally consistent: its key hashes to
 * its fingerprint, and that key signed the TLS certificate it presents. That
 * signature is what lets a pinned identity vouch for a certificate the server
 * rotated since pairing. Ed25519 through WebCrypto; a host without it answers
 * false rather than trusting an unchecked certificate.
 */
export async function verifyRemoteIdentity(identity: RemoteIdentity): Promise<boolean> {
  if (!identity.tlsCertPem || !identity.tlsCertFingerprint || !identity.sig) return false;
  try {
    if ((await fingerprintOfPublicKeyPem(identity.publicKeyPem)) !== identity.fingerprint) {
      return false;
    }
    if ((await certFingerprintFromPem(identity.tlsCertPem)) !== identity.tlsCertFingerprint) {
      return false;
    }
    const key = await subtle().importKey(
      'spki',
      toArrayBuffer(pemToDer(identity.publicKeyPem)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const sig = Uint8Array.from(atob(identity.sig), (c) => c.charCodeAt(0));
    return await subtle().verify(
      { name: 'Ed25519' },
      key,
      toArrayBuffer(sig),
      toArrayBuffer(utf8(identity.tlsCertFingerprint)),
    );
  } catch {
    return false;
  }
}

/**
 * What a device presents when it pairs: a stable id and a public key. The
 * pairing protocol never asks a client to sign, so only the public half is
 * kept; the key is the device's name in the server's transcript, not a
 * credential.
 */
export interface ClientIdentity {
  deviceId: string;
  publicKeyPem: string;
  fingerprint: string;
}

export async function createClientIdentity(): Promise<ClientIdentity> {
  const pair = (await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as { publicKey: Parameters<ReturnType<typeof subtle>['exportKey']>[1] };
  const spki = new Uint8Array(await subtle().exportKey('spki', pair.publicKey));
  const publicKeyPem = derToPem(spki, 'PUBLIC KEY');
  return {
    deviceId: globalThis.crypto.randomUUID(),
    publicKeyPem,
    fingerprint: await sha256Hex(spki),
  };
}
