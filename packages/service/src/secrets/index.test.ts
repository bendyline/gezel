import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSecretStore } from './index.js';

describe('openSecretStore backend marker', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-secret-backend-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('fails closed on a malformed backend marker', async () => {
    await writeFile(join(home, 'secrets.backend'), 'mystery-backend\n');
    await expect(openSecretStore(home, { forceFile: true })).rejects.toThrow(
      /invalid backend marker/,
    );
  });
});
