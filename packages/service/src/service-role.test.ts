import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEffectiveServiceRole } from './service.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-service-role-'));
  homes.push(home);
  return home;
}

describe('resolveEffectiveServiceRole', () => {
  it('starts a fresh installed system home as a machine engine', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'runtime'), { recursive: true });

    await expect(
      resolveEffectiveServiceRole('machine-engine', { GEZEL_SYSTEM_SCOPE: '1' }, home),
    ).resolves.toBe('machine-engine');
  });

  it('preserves an established machine product home during an upgrade', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'default'), { recursive: true });

    await expect(
      resolveEffectiveServiceRole('machine-engine', { GEZEL_SYSTEM_SCOPE: '1' }, home),
    ).resolves.toBe('legacy-full');
  });

  it('does not reinterpret explicit test or portable roles outside system scope', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'default'), { recursive: true });

    await expect(resolveEffectiveServiceRole('machine-engine', {}, home)).resolves.toBe(
      'machine-engine',
    );
  });
});
