import { describe, expect, it } from 'vitest';
import { decodeText, encodeText } from './files.js';
import { PortableStore } from './store.js';
import { portableFixture } from './test-files.js';

describe('plain role titles on the phone', () => {
  it('writes a Dutch role as its plain title at creation', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const created = await store.createGezel({ name: 'Ada', role: 'Reisleider' });
    expect(created.role).toBe('Trip Planner');
    expect(created.roleBasedName).toBe('trip-planner');
  });

  it('migrates a stored Dutch role once, and leaves a role in the person’s own words', async () => {
    const { files, options, store } = portableFixture();
    await store.ensureLayout();
    const keeper = await store.createGezel({ name: 'Bram', role: 'Librarian' });
    const senior = await store.createGezel({ name: 'Cas', role: 'Senior Voorman' });
    const path = `gezels/${keeper.id}/gezel.md`;
    const source = decodeText(files.entries.get(path)!);
    files.entries.set(
      path,
      encodeText(
        source
          .replace(/^role: .*$/m, 'role: Boekwachter')
          .replace(/^roleBasedName: .*$/m, 'roleBasedName: boekwachter'),
      ),
    );
    files.entries.set(
      `gezels/${keeper.id}/about.md`,
      encodeText('# Boekwachter\n\nYou are the **boekwachter**.'),
    );

    await new PortableStore(options).ensureLayout();

    const migrated = await store.getGezel(keeper.id);
    expect(migrated?.about).toBe('# Librarian\n\nYou are the **librarian**.');
    expect(migrated?.role).toBe('Librarian');
    expect(migrated?.roleBasedName).toBe('librarian');
    expect(migrated?.character).toEqual(keeper.character);
    expect((await store.getGezel(senior.id))?.role).toBe('Senior Voorman');
  });

  it('leaves a Dutch title the person put back into an English-titled gezel’s about.md', async () => {
    const { files, options, store } = portableFixture();
    await store.ensureLayout();
    const scribe = await store.createGezel({ name: 'Hanna', role: 'Scribe' });
    files.entries.set(
      `gezels/${scribe.id}/about.md`,
      encodeText('You are the **Klerk**, by my own choice.'),
    );
    await new PortableStore(options).ensureLayout();
    expect((await store.getGezel(scribe.id))?.about).toBe(
      'You are the **Klerk**, by my own choice.',
    );
  });
});
