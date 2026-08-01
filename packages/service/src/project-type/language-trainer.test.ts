import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';

/**
 * End-to-end exercise of the SHIPPED Language Trainer bundled project type
 * (gilde data/project-types/la/language-trainer). Uses the real
 * default CatalogService so a break in the committed manifest, gezel template,
 * scripts, or seed files fails here. See docs/project-types.md.
 */

let home: string;
let store: Store;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lang-trainer-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Language Trainer bundled project type', () => {
  it('resolves from the bundled catalog', async () => {
    const detail = await catalog.get('project-type', 'language-trainer');
    expect(detail).not.toBeNull();
    if (!detail || detail.manifest.kind !== 'project-type') throw new Error('did not resolve');
    expect(detail.manifest.extends).toBe('content-writing');
    expect(detail.manifest.meesterManaged).toBe(false);
    expect(detail.manifest.gezels[0]?.templateId).toBe('language-trainer');
    expect(detail.manifest.pages?.entry).toBe('dashboard/index.html');
    expect(Object.keys(detail.manifest.scripts ?? {})).toContain('progress-store');
  });

  it('applies onto a project: trainer voorman, script, seed, rendered docs', async () => {
    const project = await store.createProject({ name: 'Learn Spanish' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Spanish' } },
    );

    // A Language Trainer gezel is created and set as voorman.
    expect(applied.gezelsCreated).toHaveLength(1);
    expect(applied.gezelsCreated[0]?.templateId).toBe('language-trainer');
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    const detail = await store.getProject(project.id);
    expect(detail?.voormanGezelId).toBe(applied.gezelsCreated[0]?.id);
    const trainer = await store.getGezel(applied.gezelsCreated[0]!.id);
    expect(trainer?.role).toBe('Language Trainer');

    // The progress-store script is installed with the project-type marker.
    expect(applied.scriptsInstalled).toContain('progress-store');
    const scriptBody = await readFile(
      projectScriptFile(home, project.id, 'progress-store'),
      'utf8',
    );
    expect(
      scriptBody.startsWith(`// @gezel-project-type: language-trainer@${applied.version}\n`),
    ).toBe(true);
    expect(scriptBody).toContain("name: 'progress-store'");

    // The seed lands in the workspace with the language substituted.
    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const seed = JSON.parse(await readFile(join(workspaceDir, 'progress.json'), 'utf8'));
    expect(seed.language).toBe('Spanish');
    expect(seed.level).toBe(1);

    // Provenance + inherited taxonomy id + rendered about (with the language).
    expect(detail?.projectType?.id).toBe('language-trainer');
    expect(detail?.projectTypeId).toBe('content-writing');
    expect(detail?.nudgeConfig?.enabled).toBe(false);
    expect(applied.aboutRendered).toBe(true);
    expect(applied.missionRendered).toBe(true);
    const about = await store.getProject(project.id);
    expect(about?.about ?? '').toContain('Spanish');
  });

  it('applies the language default when the caller passes no params', async () => {
    const project = await store.createProject({ name: 'Learn a language' });
    await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer' },
    );
    // The type's `language` param defaults to "Spanish"; the engine seeds it so
    // nothing renders a literal `{{language}}`.
    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const seed = JSON.parse(await readFile(join(workspaceDir, 'progress.json'), 'utf8'));
    expect(seed.language).toBe('Spanish');
    const detail = await store.getProject(project.id);
    expect(detail?.about ?? '').toContain('Spanish');
    expect(detail?.about ?? '').not.toContain('{{');
  });

  it('disables Meester progress checks without discarding existing nudge overrides', async () => {
    const project = await store.createProject({ name: 'Long-running practice' });
    await store.updateProject(project.id, {
      nudgeConfig: {
        rapidIntervalMs: 15 * 60_000,
        slowIntervalMs: 24 * 60 * 60_000,
        rapidAttemptsBeforeBackoff: 7,
      },
    });

    await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Dutch' } },
    );

    const detail = await store.getProject(project.id);
    expect(detail?.nudgeConfig).toEqual({
      rapidIntervalMs: 15 * 60_000,
      slowIntervalMs: 24 * 60 * 60_000,
      rapidAttemptsBeforeBackoff: 7,
      enabled: false,
    });
  });
});
