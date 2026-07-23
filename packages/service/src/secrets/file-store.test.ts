import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretsFile, secretsKeyFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSecretStore } from './file-store.js';
import type { SecretKey } from './types.js';

describe('FileSecretStore', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-secrets-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const toolsetKey = (fieldId: string): SecretKey => ({
    kind: 'toolset',
    toolsetId: 'github-mcp',
    fieldId,
  });

  it('round-trips a value', async () => {
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('GITHUB_TOKEN'), 'ghp_abc');
    expect(await store.get(toolsetKey('GITHUB_TOKEN'))).toBe('ghp_abc');
    expect(await store.has(toolsetKey('GITHUB_TOKEN'))).toBe(true);
  });

  it('persists across store instances', async () => {
    const a = new FileSecretStore(home);
    await a.set(toolsetKey('GITHUB_TOKEN'), 'ghp_abc');
    const b = new FileSecretStore(home);
    expect(await b.get(toolsetKey('GITHUB_TOKEN'))).toBe('ghp_abc');
  });

  it('lets the active backend overwrite stale migration values', async () => {
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('GITHUB_TOKEN'), 'stale-file-value');
    await store.importEntries(
      new Map([['toolset:github-mcp:GITHUB_TOKEN', 'active-keyring-value']]),
      true,
    );
    expect(await store.get(toolsetKey('GITHUB_TOKEN'))).toBe('active-keyring-value');
  });

  it('deletes a value', async () => {
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('GITHUB_TOKEN'), 'ghp_abc');
    await store.delete(toolsetKey('GITHUB_TOKEN'));
    expect(await store.get(toolsetKey('GITHUB_TOKEN'))).toBeNull();
    expect(await store.has(toolsetKey('GITHUB_TOKEN'))).toBe(false);
  });

  it('lists field ids for a toolset', async () => {
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('GITHUB_TOKEN'), 'ghp_abc');
    await store.set(toolsetKey('GITHUB_ORG'), 'acme');
    await store.set({ kind: 'toolset', toolsetId: 'other', fieldId: 'X' }, 'y');
    const fields = await store.listForToolset('github-mcp');
    expect(fields.sort()).toEqual(['GITHUB_ORG', 'GITHUB_TOKEN']);
  });

  it('stores provider credentials separately from toolset secrets', async () => {
    const store = new FileSecretStore(home);
    await store.set({ kind: 'providerCredential', name: 'githubToken' }, 'ghp_zzz');
    expect(await store.get({ kind: 'providerCredential', name: 'githubToken' })).toBe('ghp_zzz');
    expect(await store.listForToolset('any')).toEqual([]);
  });

  it('persists ciphertext (not plaintext) on disk', async () => {
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('GITHUB_TOKEN'), 'ghp_should_be_hidden');
    const raw = await readFile(secretsFile(home), 'utf8');
    expect(raw).not.toContain('ghp_should_be_hidden');
  });

  it('does not treat a malformed secret file as an empty store', async () => {
    await writeFile(secretsFile(home), '{broken json');
    const store = new FileSecretStore(home);
    await expect(store.get(toolsetKey('GITHUB_TOKEN'))).rejects.toThrow(/malformed JSON/);
  });

  it('rejects decryption with the wrong key', async () => {
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('GITHUB_TOKEN'), 'ghp_abc');
    // Corrupt the key file and boot a fresh store — reading should throw.
    const badKey = Buffer.alloc(32, 0xff);
    await writeFile(secretsKeyFile(home), badKey);
    const other = new FileSecretStore(home);
    await expect(other.get(toolsetKey('GITHUB_TOKEN'))).rejects.toThrow();
  });

  it('writes the key file with 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const store = new FileSecretStore(home);
    await store.set(toolsetKey('X'), 'y');
    const s = await stat(secretsKeyFile(home));
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent writers without tearing', async () => {
    const store = new FileSecretStore(home);
    const count = 20;
    await Promise.all(
      Array.from({ length: count }, (_, i) => store.set(toolsetKey(`F${i}`), `v${i}`)),
    );
    const other = new FileSecretStore(home);
    for (let i = 0; i < count; i++) {
      expect(await other.get(toolsetKey(`F${i}`))).toBe(`v${i}`);
    }
  });
});
