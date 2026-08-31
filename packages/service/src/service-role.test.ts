import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveEffectiveServiceRole } from './runtime-discovery.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-service-role-'));
  homes.push(home);
  return home;
}

/** The layout `legacy-full` boot manufactures on its own: default project + crew. */
async function seedAutoCreatedBaseline(home: string): Promise<void> {
  await mkdir(join(home, 'projects', 'default'), { recursive: true });
  for (const id of ['elara', 'ilse', 'eduardo']) {
    await mkdir(join(home, 'gezels', id), { recursive: true });
  }
}

const SYSTEM = { GEZEL_SYSTEM_SCOPE: '1' } as const;

describe('resolveEffectiveServiceRole', () => {
  it('starts a fresh installed system home as a machine engine', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'runtime'), { recursive: true });

    await expect(resolveEffectiveServiceRole('machine-engine', { ...SYSTEM }, home)).resolves.toBe(
      'machine-engine',
    );
  });

  it('preserves an established machine product home during an upgrade', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'workshop'), { recursive: true });

    await expect(resolveEffectiveServiceRole('machine-engine', { ...SYSTEM }, home)).resolves.toBe(
      'legacy-full',
    );
  });

  it('treats a gezel with a persisted session as established product state', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'default'), { recursive: true });
    await mkdir(join(home, 'gezels', 'imara', 'sessions'), { recursive: true });
    await writeFile(join(home, 'gezels', 'imara', 'sessions', 'abc.json'), '{}');

    await expect(resolveEffectiveServiceRole('machine-engine', { ...SYSTEM }, home)).resolves.toBe(
      'legacy-full',
    );
  });

  // The trap door. A legacy-full boot creates the default project and the
  // system crew, so keying the check on directory presence made one boot in
  // compatibility mode pin every later boot to it — the home could never
  // return to the broker role even after its real data had been migrated out.
  it('does not treat its own auto-created baseline as established product state', async () => {
    const home = await freshHome();
    await seedAutoCreatedBaseline(home);

    await expect(resolveEffectiveServiceRole('machine-engine', { ...SYSTEM }, home)).resolves.toBe(
      'machine-engine',
    );
  });

  // What the installer's migration actually leaves behind: the entity
  // directories are gone (moved to the shared root) and only strays remain.
  it('returns to the broker role once migration has moved the product trees out', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects'), { recursive: true });
    await mkdir(join(home, 'gezels'), { recursive: true });
    await writeFile(join(home, 'projects', '.DS_Store'), '');

    await expect(resolveEffectiveServiceRole('machine-engine', { ...SYSTEM }, home)).resolves.toBe(
      'machine-engine',
    );
  });

  // v1.26217.38 shipped a Windows service host compiled before
  // GEZEL_SERVICE_ROLE existed, so the daemon saw no role at all. Defaulting
  // that to legacy-full served the full product API under a token every local
  // account can read. Unstated role must resolve to least authority.
  it('defaults an unstated system-scope role to the broker, not the full product API', async () => {
    const home = await freshHome();
    await seedAutoCreatedBaseline(home);

    await expect(resolveEffectiveServiceRole(undefined, { ...SYSTEM }, home)).resolves.toBe(
      'machine-engine',
    );
  });

  it('still preserves compatibility for an unstated role on a genuinely pre-split home', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'workshop'), { recursive: true });

    await expect(resolveEffectiveServiceRole(undefined, { ...SYSTEM }, home)).resolves.toBe(
      'legacy-full',
    );
  });

  it('honours an explicitly configured role over any home inspection', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'workshop'), { recursive: true });

    await expect(
      resolveEffectiveServiceRole(
        undefined,
        { ...SYSTEM, GEZEL_SERVICE_ROLE: 'legacy-full' },
        home,
      ),
    ).resolves.toBe('legacy-full');
    await expect(
      resolveEffectiveServiceRole(undefined, { GEZEL_SERVICE_ROLE: 'user' }, home),
    ).resolves.toBe('user');
  });

  it('leaves ordinary standalone launches as user daemons', async () => {
    const home = await freshHome();
    await expect(resolveEffectiveServiceRole(undefined, {}, home)).resolves.toBe('user');
  });

  it('does not reinterpret explicit test or portable roles outside system scope', async () => {
    const home = await freshHome();
    await mkdir(join(home, 'projects', 'default'), { recursive: true });

    await expect(resolveEffectiveServiceRole('machine-engine', {}, home)).resolves.toBe(
      'machine-engine',
    );
  });
});
