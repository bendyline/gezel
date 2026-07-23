import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { resetTemplateGezels } from './reset-templates.js';

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-reset-templates-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Find a gilde template that ships a non-empty about.md to seed the tests. */
async function firstTemplateWithAbout(): Promise<{ id: string; version?: string; about: string }> {
  const items = await catalog.list('gezel-template');
  for (const it of items) {
    if (it.manifest.kind !== 'gezel-template') continue;
    const detail = await catalog.get('gezel-template', it.manifest.id);
    if (detail?.manifest.kind === 'gezel-template' && detail.about) {
      return { id: it.manifest.id, version: detail.manifest.version, about: detail.about };
    }
  }
  throw new Error('no gezel-template with an about.md found in the bundled catalog');
}

describe('resetTemplateGezels', () => {
  it('restores a template-derived gezel’s edited about.md back to the catalog default', async () => {
    const template = await firstTemplateWithAbout();
    const created = await store.createGezel({
      name: 'Twan',
      role: 'Tester',
      about: template.about,
      templateId: template.id,
      ...(template.version ? { templateVersion: template.version } : {}),
    });

    // Simulate a user editing the gezel's instructions.
    await store.updateGezelAbout(created.id, 'totally custom prompt the user wrote');
    expect((await store.getGezel(created.id))?.about).toContain('totally custom prompt');

    const result = await resetTemplateGezels({ store, catalog });

    expect(result.reset).toContain(created.id);
    expect((await store.getGezel(created.id))?.about).toBe(template.about);
  });

  it('skips bespoke gezels that have no templateId', async () => {
    const bespoke = await store.createGezel({
      name: 'Bram',
      role: 'Bespoke',
      about: 'hand-written instructions',
    });

    const result = await resetTemplateGezels({ store, catalog });

    expect(result.reset).not.toContain(bespoke.id);
    expect(result.skipped).toContain(bespoke.id);
    // Untouched.
    expect((await store.getGezel(bespoke.id))?.about).toBe('hand-written instructions');
  });
});
