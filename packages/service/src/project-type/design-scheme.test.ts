import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';

/**
 * Exercises the SHIPPED Design Scheme project type — the artifacts-oriented
 * counterpart to the Language Trainer (which is workspace-oriented). Its output
 * (color schemes + a gallery) lives under `artifacts/`, seeded on adoption.
 */

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'design-scheme-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Design Scheme bundled project type', () => {
  it('resolves with a designer gezel, gallery page, and artifact seeds', async () => {
    const detail = await catalog.get('project-type', 'design-scheme');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    expect(detail.manifest.extends).toBe('design-prototype');
    expect(detail.manifest.gezels[0]?.templateId).toBe('designer');
    expect(detail.manifest.pages?.entry).toBe('gallery/index.html');
    expect(detail.manifest.artifactsSeed).toContain('schemes/index.json');
    expect(Object.keys(detail.manifest.scripts ?? {})).toContain('scheme-store');
  });

  it('applies: designer voorman, scheme-store script, seeded artifacts', async () => {
    const project = await store.createProject({ name: 'Brand colors' });
    const applied = await applyProjectType(
      { store, catalog, home },
      {
        projectId: project.id,
        typeId: 'design-scheme',
        params: { brief: 'a calm meditation app' },
      },
    );

    expect(applied.gezelsCreated[0]?.templateId).toBe('designer');
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    const designer = await store.getGezel(applied.gezelsCreated[0]!.id);
    expect(designer?.role).toBe('Designer');

    expect(applied.scriptsInstalled).toContain('scheme-store');
    const scriptBody = await readFile(projectScriptFile(home, project.id, 'scheme-store'), 'utf8');
    expect(scriptBody.startsWith('// @gezel-project-type: design-scheme@1.0.0\n')).toBe(true);

    // The starter palette is seeded into the project's artifacts (not the
    // workspace) — the gallery page reads it from there.
    expect(applied.workspaceSeeded).toContain('artifacts/schemes/index.json');
    const artifactsDir = store.projectArtifactsDir(project.id);
    const index = JSON.parse(await readFile(join(artifactsDir, 'schemes', 'index.json'), 'utf8'));
    expect(index.schemes[0]?.name).toBe('Warm Dusk');

    // The brief param is substituted into the about.
    const detail = await store.getProject(project.id);
    expect(detail?.about ?? '').toContain('a calm meditation app');

    // Applies the brief default when no param is passed.
    const p2 = await store.createProject({ name: 'Brand colors 2' });
    await applyProjectType({ store, catalog, home }, { projectId: p2.id, typeId: 'design-scheme' });
    const d2 = await store.getProject(p2.id);
    expect(d2?.about ?? '').toContain('a new brand');
    expect(d2?.about ?? '').not.toContain('{{');
  });
});
