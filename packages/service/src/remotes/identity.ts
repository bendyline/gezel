/**
 * Stable per-device identity for remote model execution.
 *
 * Each gezel install has ONE long-lived Ed25519 keypair, generated once and
 * persisted across reboots. It anchors pairing trust the way an SSH host key
 * does: a paired peer pins this device's identity **fingerprint** (TOFU), and
 * on every later connect this device proves continuity by signing the current
 * (rotating) TLS cert fingerprint with the identity private key. So the TLS
 * cert can keep rotating every boot while the trust anchor stays put.
 *
 * Split of where the halves live:
 *   - public key + deviceId + fingerprint → `~/.gezel/device-identity.json`
 *     (non-secret, but 0600 so the deviceId isn't world-readable).
 *   - private key → the {@link SecretStore} (OS keyring / encrypted file),
 *     keyed `{kind:'deviceIdentity'}`. Never written to a plaintext file.
 *
 * The same identity serves both roles: as a SERVER it's what remote clients
 * pin; as a CLIENT (`appId` at pairing) it's how this device names itself.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createLogger } from '@bendyline/gezel';
import { deviceIdentityFile } from '@bendyline/gezel/paths';
import { z } from 'zod';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import type { SecretStore } from '../secrets/types.js';

const log = createLogger('remote-identity');

/**
 * Body of `GET /v1/identity` — a device's public identity plus a signature
 * over its current TLS cert fingerprint that proves the responder holds the
 * identity private key (continuity across cert rotation). The client pins
 * `publicKeyPem`/`fingerprint` at first pairing (TOFU) and re-verifies `sig`
 * on every later connect.
 */
export const IdentityResponseSchema = z.object({
  deviceId: z.string(),
  publicKeyPem: z.string(),
  fingerprint: z.string(),
  /** Hex SHA-256 of the current TLS cert DER (absent under insecure transport). */
  tlsCertFingerprint: z.string().optional(),
  /** The current TLS cert PEM, so a pairing client can pin it as its CA. */
  tlsCertPem: z.string().optional(),
  /** Ed25519 signature (base64) over `tlsCertFingerprint`. */
  sig: z.string().optional(),
  gezelVersion: z.string().optional(),
  protocolVersion: z.number().optional(),
});
export type IdentityResponse = z.infer<typeof IdentityResponseSchema>;

/** Hex SHA-256 of a PEM-encoded X.509 cert's DER bytes. */
export function certFingerprintFromPem(certPem: string): string {
  const body = certPem
    .split('\n')
    .filter((line) => !line.startsWith('-----') && line.trim().length > 0)
    .join('');
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex');
}

export interface DeviceIdentity {
  /** Stable, opaque id for this device. Used as the pairing `appId`. */
  deviceId: string;
  /** SPKI (PEM) public half — handed to peers at pairing, pinned by them. */
  publicKeyPem: string;
  /** Hex SHA-256 of the SPKI DER. The short human-comparable identity. */
  fingerprint: string;
}

interface PersistedShape {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  fingerprint: string;
}

/** Hex SHA-256 of the DER form of a SPKI public key PEM. */
export function fingerprintOfPublicKeyPem(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Load this device's identity, generating + persisting it on first run. If the
 * persisted public key has no matching private key in the secret store (e.g.
 * the keyring was wiped), the identity is regenerated — which rotates the
 * fingerprint and forces paired peers to re-pin, the correct SSH-like failure.
 */
export async function loadOrCreateDeviceIdentity(
  home: string,
  secrets: SecretStore,
): Promise<DeviceIdentity> {
  const file = deviceIdentityFile(home);
  const existing = await readPersisted(file);
  if (existing) {
    const priv = await secrets.get({ kind: 'deviceIdentity' });
    if (priv && privateMatchesPublic(priv, existing.publicKeyPem)) {
      return existing;
    }
    log.warn('[remote-identity] persisted identity has no matching private key — regenerating');
  }
  return generateAndPersist(file, secrets);
}

/**
 * Sign a TLS cert fingerprint with the identity private key. Returned base64
 * is what `/v1/identity` ships as `sig`, proving the holder of the pinned
 * identity controls the current TLS cert. Returns `null` if no private key is
 * available (caller should surface a clear "identity not initialized" error).
 */
export async function signCertFingerprint(
  secrets: SecretStore,
  tlsCertFingerprint: string,
): Promise<string | null> {
  const priv = await secrets.get({ kind: 'deviceIdentity' });
  if (!priv) return null;
  const sig = cryptoSign(null, Buffer.from(tlsCertFingerprint, 'utf8'), createPrivateKey(priv));
  return sig.toString('base64');
}

/**
 * Verify a peer's signature over `data` against their pinned public key. Used
 * by the client (Device A) to confirm the box it's talking to still controls
 * the identity it pinned at pairing. Never throws — returns false on any
 * malformed input.
 */
export function verifyIdentitySignature(
  publicKeyPem: string,
  data: string,
  signatureBase64: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(data, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

function privateMatchesPublic(privatePem: string, publicPem: string): boolean {
  try {
    const derived = createPublicKey(createPrivateKey(privatePem)).export({
      type: 'spki',
      format: 'der',
    });
    const expected = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
    return Buffer.compare(derived, expected) === 0;
  } catch {
    return false;
  }
}

async function generateAndPersist(file: string, secrets: SecretStore): Promise<DeviceIdentity> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const fingerprint = fingerprintOfPublicKeyPem(publicKeyPem);
  const identity: DeviceIdentity = { deviceId: randomUUID(), publicKeyPem, fingerprint };

  // Private half first: if this fails we don't want a public file pointing at
  // a key we can't sign with.
  await secrets.set({ kind: 'deviceIdentity' }, privateKeyPem);
  const shape: PersistedShape = { version: 1, ...identity };
  await writeSecurityJson(file, `${JSON.stringify(shape, null, 2)}\n`);
  await chmod(file, 0o600).catch(() => {});
  log.info(
    `[remote-identity] generated device identity ${identity.deviceId} (fp ${fingerprint.slice(0, 16)}…)`,
  );
  return identity;
}

async function readPersisted(file: string): Promise<DeviceIdentity | null> {
  return readSecurityJson(file, 'device identity', (raw) => {
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (
      parsed.version !== 1 ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.publicKeyPem !== 'string' ||
      typeof parsed.fingerprint !== 'string'
    ) {
      throw new Error('invalid identity fields');
    }
    if (fingerprintOfPublicKeyPem(parsed.publicKeyPem) !== parsed.fingerprint) {
      throw new Error('identity fingerprint does not match the public key');
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      fingerprint: parsed.fingerprint,
    };
  });
}
