import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService, LocalCatalogSource } from '@bendyline/gezel-catalog';
import { projectTypesRoot } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import { importGzlBundle, packProjectTypeBundle, readGzlBundle, verifyGzlBundle } from './gzl.js';

let home: string;
let bundled: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gzl-'));
  bundled = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('.gzl bundle round-trip', () => {
  it('packs a project type + its gezel template, verifies, and re-parses', async () => {
    const { buffer, manifest } = await packProjectTypeBundle(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    // The bundle carries the type AND the gezel template it references.
    expect(manifest.items.map((i) => `${i.kind}:${i.id}`).sort()).toEqual([
      'gezel-template:language-trainer',
      'project-type:language-trainer',
    ]);
    expect(manifest.items.every((i) => /^[a-f0-9]{64}$/.test(i.sha256))).toBe(true);

    const parsed = readGzlBundle(buffer);
    expect(verifyGzlBundle(parsed).ok).toBe(true);
    // The dashboard page rode along (an asset the manifest names only via pages.entry).
    const hasDashboard = [...parsed.files.keys()].some((k) =>
      k.endsWith('project-types/la/language-trainer/versions/1.0.0/pages/dashboard/index.html'),
    );
    expect(hasDashboard).toBe(true);
  });

  it('review (confirm:false) lists items without writing; confirm installs a usable type', async () => {
    const { buffer } = await packProjectTypeBundle(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );

    // Review: nothing is written to the fresh home.
    const review = await importGzlBundle({ home }, buffer);
    expect(review.installed).toBeUndefined();
    expect(review.items.map((i) => i.id)).toContain('language-trainer');
    expect(existsSync(projectTypesRoot(home))).toBe(false);

    // Confirm: items land under the local home.
    const done = await importGzlBundle({ home }, buffer, { confirm: true });
    expect(done.installed?.map((i) => i.kind).sort()).toEqual(['gezel-template', 'project-type']);
    expect(existsSync(projectTypesRoot(home))).toBe(true);

    // A LOCAL-ONLY catalog (no bundled tier) resolves the imported copy — so
    // the bundle is genuinely self-contained, not just shadowing the builtin.
    const localOnly = new CatalogService([new LocalCatalogSource(home)]);
    expect((await localOnly.list('project-type')).map((i) => i.manifest.id)).toContain(
      'language-trainer',
    );

    // And it applies end-to-end from the imported copy alone (its gezel
    // template resolves from the same imported home).
    const store = new Store({ home });
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Imported Spanish' });
    const applied = await applyProjectType(
      { store, catalog: localOnly, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Spanish' } },
    );
    expect(applied.gezelsCreated[0]?.templateId).toBe('language-trainer');
    expect(applied.scriptsInstalled).toContain('progress-store');
  });

  it('rejects a tampered bundle (sha256 mismatch)', async () => {
    const { buffer } = await packProjectTypeBundle(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    const parsed = readGzlBundle(buffer);
    // Corrupt one item file.
    const key = [...parsed.files.keys()].find((k) => k.endsWith('about.md'))!;
    parsed.files.set(key, Buffer.from('tampered'));
    const { ok, errors } = verifyGzlBundle(parsed);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/sha256 mismatch/);
  });

  it('rejects a bundle carrying a disallowed item kind', async () => {
    const parsed = {
      manifest: {
        schemaVersion: 1 as const,
        name: 'bad',
        description: '',
        items: [
          {
            kind: 'toolset' as const,
            id: 'x',
            version: '1.0.0',
            path: 'toolsets/x/x',
            sha256: 'a'.repeat(64),
          },
        ],
      },
      files: new Map<string, Buffer>([['items/toolsets/x/x/manifest.json', Buffer.from('{}')]]),
    };
    const { ok, errors } = verifyGzlBundle(parsed);
    expect(ok).toBe(false);
    expect(errors.join(' ')).toMatch(/unsupported item kind/);
  });
});
