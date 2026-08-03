import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { deviceIdentityFile, secretsFile } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { FileSecretStore } from './file-store.js';
import { KeyringSecretStore, probeKeyringAvailable } from './keyring-store.js';
import {
  SecretBackendUnavailableError,
  type SecretStore,
  SecretStoreCorruptError,
  deviceIdentityScope,
} from './types.js';

const log = createLogger('secrets');

export { FileSecretStore } from './file-store.js';
export { KeyringSecretStore } from './keyring-store.js';
export type {
  SecretStore,
  SecretKey,
  SecretStoreBackend,
  ProviderCredentialName,
} from './types.js';
export {
  SecretBackendUnavailableError,
  SecretStoreCorruptError,
  stringifySecretKey,
  toolsetKeyPrefix,
} from './types.js';

export interface OpenSecretStoreOptions {
  /** Force the file-backed fallback. Used in tests + explicit dev opt-out. */
  forceFile?: boolean;
  /** Override the native availability probe. Test seam only. */
  keyringProbe?: () => string | null;
}

/**
 * Open the SecretStore. Probes the OS keyring first. A fresh install may
 * choose the encrypted file fallback; an established install fails closed
 * rather than silently changing backends while its keyring is unavailable.
 */
export async function openSecretStore(
  home: string,
  opts: OpenSecretStoreOptions = {},
): Promise<SecretStore> {
  const identityScope = deviceIdentityScope(home);
  const keyringProbe = opts.keyringProbe ?? probeKeyringAvailable;
  const markerPath = join(home, 'secrets.backend');
  const previousBackend = await readBackendMarker(markerPath);
  const hasIdentity = await exists(deviceIdentityFile(home));
  const hasEncryptedFile = await exists(secretsFile(home));
  const looksLikeLegacyKeyringInstall =
    previousBackend === null && hasIdentity && !hasEncryptedFile;
  // Mock-provider E2E uses an isolated file backend, but an operator setting
  // the mock flag against an established home must not silently switch away
  // from that home's keyring and rotate its device identity.
  const testMode =
    process.env.VITEST === 'true' ||
    (process.env.GEZEL_MOCK_PROVIDER === '1' &&
      previousBackend !== 'keyring' &&
      !looksLikeLegacyKeyringInstall);
  const forceFile = opts.forceFile || process.env.GEZEL_SECRETS_BACKEND === 'file' || testMode;
  if (forceFile) {
    // Tests and E2E must never touch the real OS keychain — it would
    // accumulate entries across runs and leak cross-test state.
    log.info('[secrets] using encrypted file store (test or forced)');
    const store = new FileSecretStore(home);
    if (!testMode && previousBackend === 'keyring') {
      const reason = keyringProbe();
      if (reason !== null) {
        throw new SecretBackendUnavailableError(
          'keyring',
          `OS keychain is unavailable (${reason}); cannot migrate secrets to the file backend`,
        );
      }
      const entries = await new KeyringSecretStore({ identityScope }).exportEntries();
      await store.importEntries(entries, true);
      log.info(`[secrets] migrated ${entries.size} keyring secret(s) to encrypted file storage`);
    }
    await writeFileAtomic(markerPath, 'file\n', { mode: 0o600 });
    return store;
  }
  const reason = keyringProbe();
  if (reason === null) {
    log.info('[secrets] using OS keychain');
    const keyring = new KeyringSecretStore({ identityScope });
    if (previousBackend === 'file' && hasEncryptedFile) {
      const entries = await new FileSecretStore(home).exportEntries();
      await keyring.importEntries(entries, true);
      log.info(`[secrets] migrated ${entries.size} encrypted-file secret(s) to the OS keychain`);
    }
    await writeFileAtomic(markerPath, 'keyring\n', { mode: 0o600 });
    return keyring;
  }
  if (previousBackend === 'keyring' || looksLikeLegacyKeyringInstall) {
    throw new SecretBackendUnavailableError(
      'keyring',
      `OS keychain is unavailable (${reason}); refusing to switch secret backends implicitly`,
    );
  }
  log.warn(
    `[secrets] OS keychain unavailable (${reason}); falling back to encrypted file store at ~/.gezel/secrets.enc`,
  );
  const store = new FileSecretStore(home);
  await writeFileAtomic(markerPath, 'file\n', { mode: 0o600 });
  return store;
}

async function readBackendMarker(path: string): Promise<'keyring' | 'file' | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    if (value === 'keyring' || value === 'file') return value;
    throw new SecretStoreCorruptError(`[secrets] invalid backend marker ${JSON.stringify(value)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
