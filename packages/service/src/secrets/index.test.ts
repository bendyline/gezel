import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSecretStore } from './index.js';

describe('openSecretStore backend marker', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-secret-backend-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('fails closed on a malformed backend marker', async () => {
    await writeFile(join(home, 'secrets.backend'), 'mystery-backend\n');
    await expect(openSecretStore(home, { forceFile: true })).rejects.toThrow(
      /invalid backend marker/,
    );
  });

  it('fails closed when a previously selected keyring is unavailable', async () => {
    vi.stubEnv('VITEST', 'false');
    const marker = join(home, 'secrets.backend');
    await writeFile(marker, 'keyring\n');

    await expect(
      openSecretStore(home, { keyringProbe: () => 'User interaction is not allowed.' }),
    ).rejects.toThrow(/refusing to switch secret backends implicitly/);
    expect(await readFile(marker, 'utf8')).toBe('keyring\n');
  });
});
