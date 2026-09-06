import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deviceIdentityFile, secretsFile } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { readSecurityJson } from '../fs/security-json.js';
import { type SecretKey, deviceIdentityScope } from '../secrets/types.js';
import {
  type IdentityKeyStore,
  loadOrCreateDeviceIdentity,
  signCertFingerprint,
} from './identity.js';

type IdentityKey = Extract<SecretKey, { kind: 'deviceIdentity' }>;

/** The broker owns one identity key, never a provider-credential vault.
 * Older brokers stored that key in the general vault. Read only the identity
 * account during migration, preserving paired clients' pinned fingerprint.
 * Never enumerate credentials, migrate the vault or seed environment secrets.
 */
export async function loadEngineIdentity(home: string, certFingerprint?: string) {
  const keyPath = join(home, 'engine-identity-key.json');
  let value = await readSecurityJson(keyPath, 'engine identity key', (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'string' || !parsed) throw new Error('invalid identity key');
    const pem = parsed.startsWith('-----BEGIN') ? parsed : JSON.parse(parsed).privateKeyPem;
    if (typeof pem !== 'string' || createPrivateKey(pem).asymmetricKeyType !== 'ed25519')
      throw new Error('invalid identity private key');
    return parsed;
  });
  let legacyRead: IdentityKeyStore['get'] | undefined;
  if (!value) {
    const marker = await readFile(join(home, 'secrets.backend'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (marker !== null && !['file', 'keyring'].includes(marker.trim()))
      throw new Error('Invalid existing identity backend');
    const exists = async (path: string) => {
      const { access } = await import('node:fs/promises');
      return access(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
    };
    const hasEncryptedFile = await exists(secretsFile(home));
    if (
      marker?.trim() === 'keyring' ||
      (!marker && !hasEncryptedFile && (await exists(deviceIdentityFile(home))))
    ) {
      const { readKeyringIdentityKey, probeKeyringAvailable } = await import(
        '../secrets/keyring-store.js'
      );
      const reason = probeKeyringAvailable();
      if (reason !== null)
        throw new Error(`Existing engine identity keychain is unavailable: ${reason}`);
      legacyRead = readKeyringIdentityKey;
    } else if (hasEncryptedFile) {
      const { readFileIdentityKey } = await import('../secrets/file-store.js');
      legacyRead = (key) => readFileIdentityKey(home, key);
    }
  }
  const keys: IdentityKeyStore = {
    async get(key: IdentityKey) {
      if (key.scope === deviceIdentityScope(home) && value) return value;
      return legacyRead?.(key) ?? null;
    },
    async set(key: IdentityKey, next: string) {
      if (key.scope !== deviceIdentityScope(home))
        throw new Error('Engine identity scope mismatch');
      await writeFileAtomic(keyPath, `${JSON.stringify(next)}\n`, { mode: 0o600, durable: true });
      value = next;
    },
  };
  const identity = await loadOrCreateDeviceIdentity(home, keys);
  const scopedKey = { kind: 'deviceIdentity', scope: deviceIdentityScope(home) } as const;
  const migrated = await keys.get(scopedKey);
  if (!value && migrated) await keys.set(scopedKey, migrated);
  legacyRead = undefined;
  return {
    identity,
    signCertificate: () =>
      certFingerprint ? signCertFingerprint(keys, home, certFingerprint) : Promise.resolve(null),
  };
}
