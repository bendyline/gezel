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
 *     keyed `{kind:'deviceIdentity', scope}`. Never written to a plaintext file.
 *
 * The same identity serves both roles: as a SERVER it's what remote clients
 * pin; as a CLIENT (`appId` at pairing) it's how this device names itself.
 *
 * ## Why the private half is scoped to the home
 *
 * The public half is per-`GEZEL_HOME`; the OS keyring is per-login. Legacy
 * releases stored the private half in one login-global account (`deviceIdentity`),
 * so the two halves disagreed about how many identities exist. Any home
 * without a `device-identity.json` — a fresh install beside an existing one,
 * a second intentional `GEZEL_HOME`, a home the user deleted — went straight
 * to generation and wrote over the one global account. On macOS the write
 * did not even get that far: keychain ACLs are bound to the creating binary,
 * so a differently-signed build cannot read the existing item, the security
 * framework's find-then-update degrades to an add, and the add fails with
 * "The specified item already exists in the keychain". `startService` awaits
 * this function unguarded, so that took the daemon down at boot.
 *
 * Two changes close it. The account is namespaced by a stable hash of the
 * home path, so distinct homes never contend for one entry. And generation
 * is now the last resort: an existing private key is recovered and reconciled
 * first, which also means deleting the home no longer rotates the identity
 * paired peers have pinned.
 *
 * A backend that is merely *unavailable* (locked keychain) never triggers
 * regeneration — losing the private key is not something to infer from a
 * failed read.
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
import {
  SecretBackendUnavailableError,
  type SecretStore,
  deviceIdentityScope,
} from '../secrets/types.js';

export { deviceIdentityScope } from '../secrets/types.js';

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

/**
 * Versioned value stored under the scoped secret account. Keeping deviceId
 * beside the private key makes the complete public identity recoverable after
 * the home (including both public-file copies) is deleted. Legacy accounts
 * contain a bare PKCS#8 PEM and remain readable during migration.
 */
interface StoredPrivateIdentity {
  version: 1;
  deviceId: string;
  privateKeyPem: string;
}

/** Hex SHA-256 of the DER form of a SPKI public key PEM. */
export function fingerprintOfPublicKeyPem(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

function scopedKey(home: string) {
  return { kind: 'deviceIdentity', scope: deviceIdentityScope(home) } as const;
}

/**
 * Read the private half, distinguishing "no key stored" from "backend can't
 * answer right now". A locked keychain must never be read as absence: that
 * would regenerate the identity and rotate a fingerprint peers have pinned.
 */
async function readPrivateKey(
  secrets: SecretStore,
  key: Parameters<SecretStore['get']>[0],
): Promise<{ value: string | null; unavailable: SecretBackendUnavailableError | null }> {
  try {
    return { value: await secrets.get(key), unavailable: null };
  } catch (error) {
    if (error instanceof SecretBackendUnavailableError) {
      return { value: null, unavailable: error };
    }
    throw error;
  }
}

/**
 * Load this device's identity, generating + persisting it only when no usable
 * private key exists. Resolution order:
 *
 *   1. Public file + matching scoped private key → use as-is.
 *   2. Scoped private key alone (home wiped, keyring intact) → rebuild the
 *      public half from it, preserving the fingerprint peers pinned.
 *   3. Legacy un-namespaced key that provably belongs to THIS home → migrate
 *      it into the scoped account, identity unchanged.
 *   4. Nothing usable → generate.
 *
 * If the persisted public key has no matching private key (the keyring really
 * was wiped) the identity is regenerated, rotating the fingerprint and forcing
 * paired peers to re-pin — the correct SSH-like failure. A backend that is
 * merely unavailable takes neither path: the persisted identity is returned
 * unchanged and signing degrades until the keychain unlocks.
 */
export async function loadOrCreateDeviceIdentity(
  home: string,
  secrets: SecretStore,
): Promise<DeviceIdentity> {
  const file = deviceIdentityFile(home);
  const key = scopedKey(home);
  const existing = await readPersisted(file);
  const scoped = await readPrivateKey(secrets, key);

  if (existing) {
    if (scoped.value && privateMatchesPublic(scoped.value, existing.publicKeyPem)) {
      return existing;
    }
    if (scoped.unavailable) {
      // Case 5: locked/unavailable keychain with a keyring backend already
      // selected. Regenerating here would silently destroy a live identity
      // over a transient condition, and the write would then collide with
      // the entry we could not read. Keep the identity; signCertFingerprint
      // already returns null so callers surface "identity not initialized".
      log.warn(
        `[remote-identity] secret backend unavailable (${scoped.unavailable.message}) — keeping the persisted identity; remote signing is unavailable until it recovers`,
      );
      return existing;
    }
    try {
      const migrated = await adoptLegacyKey(secrets, key, existing);
      if (migrated) return existing;
    } catch (error) {
      if (!(error instanceof SecretBackendUnavailableError)) throw error;
      // The scoped lookup above succeeded, so the backend itself was usable;
      // only the legacy item is inaccessible (the common cross-signature ACL
      // case). Do not leave the daemon permanently unable to boot. Rotate into
      // the scoped account and leave the inaccessible legacy item untouched.
      log.warn(
        `[remote-identity] legacy device key is inaccessible (${error.message}) — rotating into a home-scoped account without modifying the legacy entry`,
      );
      return generateAndPersist(file, secrets, key);
    }
    log.warn('[remote-identity] persisted identity has no matching private key — regenerating');
    return generateAndPersist(file, secrets, key);
  }

  // No public file. Before minting anything, recover an identity the keyring
  // may still hold for this home — the "home deleted, keychain retained" case,
  // and the one that used to walk straight into the duplicate-item failure.
  if (scoped.value) {
    const recovered = recoverFromPrivateKey(scoped.value);
    if (recovered) {
      await persistPublic(file, recovered);
      log.info(
        `[remote-identity] recovered device identity ${recovered.deviceId} from the secret store ` +
          `(fp ${recovered.fingerprint.slice(0, 16)}…)`,
      );
      return recovered;
    }
    log.warn('[remote-identity] stored device private key is unreadable — regenerating');
  } else if (scoped.unavailable) {
    throw new SecretBackendUnavailableError(
      scoped.unavailable.backend,
      'Cannot initialize this device identity while the secret backend is unavailable. ' +
        'Unlock the OS keychain and restart Gezel, or set GEZEL_SECRETS_BACKEND=file.',
      { cause: scoped.unavailable },
    );
  }

  return generateAndPersist(file, secrets, key);
}

/**
 * Sign a TLS cert fingerprint with the identity private key. Returned base64
 * is what `/v1/identity` ships as `sig`, proving the holder of the pinned
 * identity controls the current TLS cert. Returns `null` if no private key is
 * available (caller should surface a clear "identity not initialized" error).
 */
export async function signCertFingerprint(
  secrets: SecretStore,
  home: string,
  tlsCertFingerprint: string,
): Promise<string | null> {
  const { value } = await readPrivateKey(secrets, scopedKey(home));
  const stored = value ? decodePrivateIdentity(value) : null;
  if (!stored) return null;
  try {
    const sig = cryptoSign(
      null,
      Buffer.from(tlsCertFingerprint, 'utf8'),
      createPrivateKey(stored.privateKeyPem),
    );
    return sig.toString('base64');
  } catch {
    return null;
  }
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

function encodePrivateIdentity(privateKeyPem: string, deviceId: string): string {
  const stored: StoredPrivateIdentity = { version: 1, deviceId, privateKeyPem };
  return JSON.stringify(stored);
}

function decodePrivateIdentity(
  value: string,
): { privateKeyPem: string; deviceId: string | null } | null {
  // Legacy entries are the bare PKCS#8 PEM.
  if (!value.trimStart().startsWith('{')) {
    return { privateKeyPem: value, deviceId: null };
  }
  try {
    const parsed = JSON.parse(value) as Partial<StoredPrivateIdentity>;
    if (
      parsed.version !== 1 ||
      typeof parsed.deviceId !== 'string' ||
      parsed.deviceId.length === 0 ||
      typeof parsed.privateKeyPem !== 'string'
    ) {
      return null;
    }
    return { privateKeyPem: parsed.privateKeyPem, deviceId: parsed.deviceId };
  } catch {
    return null;
  }
}

function privateMatchesPublic(privatePem: string, publicPem: string): boolean {
  try {
    const stored = decodePrivateIdentity(privatePem);
    if (!stored) return false;
    const derived = createPublicKey(createPrivateKey(stored.privateKeyPem)).export({
      type: 'spki',
      format: 'der',
    });
    const expected = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
    return Buffer.compare(derived, expected) === 0;
  } catch {
    return false;
  }
}

/**
 * Adopt the legacy login-global entry into this home's scoped account,
 * but only when it provably belongs to this home — i.e. it matches the public
 * key already persisted here. Any other home's key is left untouched, so an
 * upgrade cannot silently transplant one install's identity onto another.
 *
 * The legacy entry is deliberately not deleted: nothing writes to it any more,
 * and leaving it lets a downgrade still find its key.
 */
async function adoptLegacyKey(
  secrets: SecretStore,
  key: { kind: 'deviceIdentity'; scope: string },
  identity: DeviceIdentity,
): Promise<boolean> {
  const legacy = await readPrivateKey(secrets, { kind: 'deviceIdentity' });
  if (legacy.unavailable) {
    throw new SecretBackendUnavailableError(
      legacy.unavailable.backend,
      'Cannot migrate the existing device identity while its legacy keychain entry is ' +
        'unavailable. Unlock the OS keychain and restart Gezel.',
      { cause: legacy.unavailable },
    );
  }
  if (!legacy.value || !privateMatchesPublic(legacy.value, identity.publicKeyPem)) return false;
  const stored = decodePrivateIdentity(legacy.value);
  if (!stored) return false;
  await secrets.set(key, encodePrivateIdentity(stored.privateKeyPem, identity.deviceId));
  log.info('[remote-identity] migrated device private key to a home-scoped keychain entry');
  return true;
}

/** Rebuild the public half from a stored private key, so a deleted home does
 *  not rotate an identity that paired peers have already pinned. */
function recoverFromPrivateKey(value: string): DeviceIdentity | null {
  try {
    const stored = decodePrivateIdentity(value);
    if (!stored) return null;
    const publicKeyPem = createPublicKey(createPrivateKey(stored.privateKeyPem))
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const fingerprint = fingerprintOfPublicKeyPem(publicKeyPem);
    return {
      deviceId: stored.deviceId ?? deviceIdFromFingerprint(fingerprint),
      publicKeyPem,
      fingerprint,
    };
  } catch {
    return null;
  }
}

/**
 * Compatibility fallback for an early scoped entry that stored only the PEM
 * before the versioned secret envelope existed. New entries preserve their
 * randomly generated deviceId in that envelope; a PEM-only entry has no such
 * value to recover, so derive a stable, version-5-shaped UUID from its key.
 */
function deviceIdFromFingerprint(fingerprint: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`gezel-device-id:${fingerprint}`).digest(),
  ).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function persistPublic(file: string, identity: DeviceIdentity): Promise<void> {
  const shape: PersistedShape = { version: 1, ...identity };
  await writeSecurityJson(file, `${JSON.stringify(shape, null, 2)}\n`);
  await chmod(file, 0o600).catch(() => {});
}

async function generateAndPersist(
  file: string,
  secrets: SecretStore,
  key: { kind: 'deviceIdentity'; scope: string },
): Promise<DeviceIdentity> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const fingerprint = fingerprintOfPublicKeyPem(publicKeyPem);
  const identity: DeviceIdentity = {
    deviceId: randomUUID(),
    publicKeyPem,
    fingerprint,
  };

  // Private half first: if this fails we don't want a public file pointing at
  // a key we can't sign with.
  await secrets.set(key, encodePrivateIdentity(privateKeyPem, identity.deviceId));
  await persistPublic(file, identity);
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
