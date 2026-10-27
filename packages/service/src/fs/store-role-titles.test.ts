import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-role-titles-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function setRole(id: string, role: string, roleBasedName: string): Promise<void> {
  const path = join(home, 'gezels', id, 'gezel.md');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source
      .replace(/^role: .*$/m, `role: ${role}`)
      .replace(/^roleBasedName: .*$/m, `roleBasedName: ${roleBasedName}`),
  );
}

describe('plain role titles', () => {
  it('writes a Dutch role as its plain title at creation', async () => {
    const created = await store.createGezel({ name: 'Ada', role: 'Voorman' });
    expect(created.role).toBe('Crew Lead');
    expect(created.roleBasedName).toBe('crew-lead');
  });

  it('migrates stored Dutch roles once at boot, re-deriving the role-based name', async () => {
    const keeper = await store.createGezel({ name: 'Bram', role: 'Librarian' });
    const scribe = await store.createGezel({ name: 'Cas', role: 'Scribe' });
    const senior = await store.createGezel({ name: 'Dirk', role: 'Senior Voorman' });
    await setRole(keeper.id, 'Boekwachter', 'boekwachter');
    await setRole(scribe.id, 'klerk', 'klerk');

    await new Store({ home }).ensureLayout();

    expect(await store.getGezel(keeper.id)).toMatchObject({
      role: 'Librarian',
      roleBasedName: 'librarian',
    });
    expect(await store.getGezel(scribe.id)).toMatchObject({
      role: 'Scribe',
      roleBasedName: 'scribe',
    });
    expect((await store.getGezel(senior.id))?.role).toBe('Senior Voorman');

    const before = await readFile(join(home, 'gezels', keeper.id, 'gezel.md'), 'utf8');
    await new Store({ home }).ensureLayout();
    expect(await readFile(join(home, 'gezels', keeper.id, 'gezel.md'), 'utf8')).toBe(before);
  });

  it('rewrites only the gezel’s own Dutch title in its about.md', async () => {
    const created = await store.createGezel({
      name: 'Fien',
      role: 'Voorman',
      about: 'You are a **voorman**: the foreman. Ask the Meester when unsure.',
    });
    expect(created.about).toBe(
      'You are a **crew lead**: the foreman. Ask the Meester when unsure.',
    );

    const scribe = await store.createGezel({ name: 'Gus', role: 'Scribe' });
    await setRole(scribe.id, 'Klerk', 'klerk');
    await writeFile(
      join(home, 'gezels', scribe.id, 'about.md'),
      'You are the **Klerk** — the workshop scribe. My own notes stay.',
    );
    await new Store({ home }).ensureLayout();
    expect((await store.getGezel(scribe.id))?.about).toBe(
      'You are the **Scribe** — the workshop scribe. My own notes stay.',
    );
  });

  // 1.26299.99 matched the English title too, so the rewrite ran at every
  // boot and reverted a Dutch title the person had put back.
  it('rewrites about.md only while migrating a Dutch role, never again', async () => {
    const scribe = await store.createGezel({ name: 'Hanna', role: 'Scribe' });
    await writeFile(
      join(home, 'gezels', scribe.id, 'about.md'),
      'You are the **Klerk**, by my own choice.',
    );
    await new Store({ home }).ensureLayout();
    expect((await store.getGezel(scribe.id))?.about).toBe(
      'You are the **Klerk**, by my own choice.',
    );
  });

  it('turns a Dutch role written into the markdown into its plain title', async () => {
    const created = await store.createGezel({ name: 'Eva', role: 'Researcher' });
    const path = join(home, 'gezels', created.id, 'gezel.md');
    const source = (await readFile(path, 'utf8')).replace(/^role: .*$/m, 'role: Keurmeester');
    const updated = await store.updateGezelMarkdown(created.id, source);
    expect(updated.role).toBe('Inspector');
    expect(updated.roleBasedName).toBe('inspector');
  });
});
