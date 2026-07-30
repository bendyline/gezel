import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import {
  ensureDefaultBoekwachter,
  resolveProjectBoekwachter,
  transferBoekwachterMembership,
} from './autonomous-roles.js';

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-boekwachter-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  catalog = new CatalogService(undefined, { localRoot: home });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('autonomous project roles', () => {
  it('ensures a canonical, prompt-backed Boekwachter and migrates existing projects', async () => {
    const project = await store.createProject({ name: 'Atlas' });
    const boekwachter = await ensureDefaultBoekwachter(store, catalog);

    expect(boekwachter.role).toBe('Boekwachter');
    expect(boekwachter.templateId).toBe('boekwachter');
    expect(boekwachter.about).toContain("crew's index-keeper");
    expect((await store.readConfig()).boekwachterGezelId).toBe(boekwachter.id);
    expect((await store.getProject('default'))?.gezelIds).toContain(boekwachter.id);
    expect((await store.getProject(project.id))?.gezelIds).toContain(boekwachter.id);
  });

  it('uses roster presence as the AI-indexing switch', async () => {
    const boekwachter = await ensureDefaultBoekwachter(store, catalog);
    expect((await resolveProjectBoekwachter(store, 'default'))?.id).toBe(boekwachter.id);

    await store.removeGezelFromProject('default', boekwachter.id);
    expect(await resolveProjectBoekwachter(store, 'default')).toBeNull();
  });

  it('adopts an existing Boekwachter instead of creating a duplicate', async () => {
    const existing = await store.createGezel({
      name: 'Lena',
      role: 'Boekwachter',
      about: 'Keep the index useful.',
      templateId: 'boekwachter',
      templateVersion: '1.0.0',
    });

    const ensured = await ensureDefaultBoekwachter(store, catalog);
    expect(ensured.id).toBe(existing.id);
    expect((await store.listGezels()).filter((gezel) => gezel.role === 'Boekwachter')).toHaveLength(
      1,
    );
  });

  it('transfers only projects that contained the previous designation', async () => {
    const first = await ensureDefaultBoekwachter(store, catalog);
    const optedOut = await store.createProject({ name: 'Quiet project' });
    const replacement = await store.createGezel({
      name: 'Mina',
      role: 'Archivist',
      about: 'Keep a careful project index.',
    });

    await transferBoekwachterMembership(store, first.id, replacement.id);
    await store.writeConfig({ boekwachterGezelId: replacement.id });

    expect((await store.getProject('default'))?.gezelIds).toContain(replacement.id);
    expect((await store.getProject('default'))?.gezelIds).not.toContain(first.id);
    expect((await store.getProject(optedOut.id))?.gezelIds ?? []).not.toContain(replacement.id);
    expect((await resolveProjectBoekwachter(store, 'default'))?.id).toBe(replacement.id);
  });

  it('replaces a deleted designation without re-enabling opted-out projects', async () => {
    const first = await ensureDefaultBoekwachter(store, catalog);
    const optedOut = await store.createProject({ name: 'No AI project' });

    await store.deleteGezel(first.id);
    const replacement = await ensureDefaultBoekwachter(store, catalog, {
      recruitProjectIds: ['default'],
    });

    expect((await store.getProject('default'))?.gezelIds).toContain(replacement.id);
    expect((await store.getProject(optedOut.id))?.gezelIds ?? []).not.toContain(replacement.id);
  });
});
