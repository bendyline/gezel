import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretsFile } from '@bendyline/gezel/paths';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSecretStore } from '../secrets/file-store.js';
import { loadEngineIdentity } from './engine-identity.js';
import { loadOrCreateDeviceIdentity, verifyIdentitySignature } from './identity.js';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'gezel-engine-identity-'));
  homes.push(home);
  return home;
}

describe('machine identity ownership', () => {
  it('migrates only the legacy identity and preserves certificate-signing continuity', async () => {
    const home = await temporaryHome();
    const vault = new FileSecretStore(home);
    const before = await loadOrCreateDeviceIdentity(home, vault);
    await vault.set({ kind: 'providerCredential', name: 'openaiApiKey' }, 'test-only-credential');
    await writeFile(join(home, 'secrets.backend'), 'file\n');
    const encrypted = JSON.parse(await readFile(secretsFile(home), 'utf8'));
    // A corrupt cloud entry must not be read or decrypted by identity migration.
    for (const key of Object.keys(encrypted.entries))
      if (key.includes('openaiApiKey')) encrypted.entries[key] = 'not-a-valid-encrypted-credential';
    await writeFile(secretsFile(home), JSON.stringify(encrypted));
    const encryptedBefore = await readFile(secretsFile(home));
    const get = vi.spyOn(FileSecretStore.prototype, 'get').mockImplementation(() => {
      throw new Error('Engine opened the credential store');
    });
    const fingerprint = 'a'.repeat(64);
    const migrated = await loadEngineIdentity(home, fingerprint);
    expect(migrated.identity).toEqual(before);
    expect(get).not.toHaveBeenCalled();
    expect(await readFile(secretsFile(home))).toEqual(encryptedBefore);
    const signature = await migrated.signCertificate();
    expect(signature).toBeTruthy();
    expect(verifyIdentitySignature(before.publicKeyPem, fingerprint, signature!)).toBe(true);
    get.mockImplementation(() => {
      throw new Error('The migrated engine must not reopen the credential vault');
    });
    const restarted = await loadEngineIdentity(home, 'b'.repeat(64));
    expect(restarted.identity).toEqual(before);
    expect(await restarted.signCertificate()).toBeTruthy();
  });

  it('refuses a damaged private-key file instead of regenerating a paired identity', async () => {
    const home = await temporaryHome();
    await loadEngineIdentity(home);
    const publicBefore = await readFile(join(home, 'device-identity.json'));
    await writeFile(join(home, 'engine-identity-key.json'), '{broken');
    await expect(loadEngineIdentity(home)).rejects.toThrow();
    expect(await readFile(join(home, 'device-identity.json'))).toEqual(publicBefore);
  });
});
