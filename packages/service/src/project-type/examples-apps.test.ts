/**
 * The contract that keeps `examples/apps/` honest: every sample source
 * folder must validate with ZERO findings (errors and warnings alike —
 * the samples are the exemplar bar, not merely passing), pack, survive
 * the same verify/import pipeline a real install runs, and apply against
 * the real Store + catalog. When the app format grows a rule, this suite
 * is what forces the samples to keep teaching it correctly.
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import { packGezappFromSource, validateGezappSource } from './gezapp-source.js';
import { importGezapp, readGezapp, verifyGezapp } from './gezapp.js';

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'examples', 'apps');
const CREATED_AT = '2026-08-24T00:00:00.000Z';

async function sampleDirs(): Promise<string[]> {
  const entries = await readdir(EXAMPLES, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function freshInstall(sample: string): Promise<{
  home: string;
  store: Store;
  catalog: CatalogService;
  appId: string;
}> {
  const home = await mkdtemp(join(tmpdir(), 'gezel-examples-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store({ home });
  await store.ensureLayout();

  const packed = await packGezappFromSource(join(EXAMPLES, sample), { createdAt: CREATED_AT });
  const imported = await importGezapp({ home, catalog: new CatalogService() }, packed.buffer, {
    confirm: true,
  });
  expect(imported.installed?.appId).toBe(packed.manifest.entry.projectType);

  // The applied catalog reads the app back the way a running daemon does:
  // through the installed-ai-apps mount, ahead of the bundled tier.
  const catalog = new CatalogService(undefined, { localRoot: home });
  return { home, store, catalog, appId: packed.manifest.entry.projectType };
}

describe('examples/apps', () => {
  it('lists the three graded samples', async () => {
    expect(await sampleDirs()).toEqual([
      'example-habit-tracker',
      'example-journal',
      'example-reading-circle',
    ]);
  });

  it('every sample validates with zero findings and packs verifiably', async () => {
    for (const sample of await sampleDirs()) {
      const result = await validateGezappSource(join(EXAMPLES, sample));
      expect(result.findings, `${sample} must stay warning-clean`).toEqual([]);
      expect(result.ok).toBe(true);

      const packed = await packGezappFromSource(join(EXAMPLES, sample), {
        createdAt: CREATED_AT,
      });
      const parsed = readGezapp(packed.buffer);
      expect(verifyGezapp(parsed), sample).toEqual({ ok: true, errors: [] });
    }
  });

  it('example-journal installs and applies as a solo crew with params', async () => {
    const { home, store, catalog } = await freshInstall('example-journal');
    const project = await store.createProject({ name: 'Journal' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'example-journal' },
    );
    expect(applied.version).toBe('1.0.0');
    expect(applied.source).toBe('installed-ai-apps');
    expect(applied.gezelsCreated).toHaveLength(1);
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    expect(applied.aboutRendered).toBe(true);
    expect(applied.missionRendered).toBe(true);

    const detail = await store.getProject(project.id);
    expect(detail?.mode).toBe('solo');
    expect(detail?.leadLabel).toBe('Journalkeeper');
    // The default param rendered into the about text.
    expect(detail?.about).toContain('daily life');
  });

  it('example-habit-tracker installs scripts (both forms), tools, seeds, and a page', async () => {
    const { home, store, catalog } = await freshInstall('example-habit-tracker');
    const project = await store.createProject({ name: 'Habits' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'example-habit-tracker' },
    );
    // The sidecar-authored script and the inline one install identically.
    expect([...applied.scriptsInstalled].sort()).toEqual(['habit-store', 'streaks-report']);
    expect([...applied.toolsBound].sort()).toEqual(['get_streaks', 'log_habit', 'record_habit']);
    expect(applied.workspaceSeeded).toEqual(['habits.json']);
    await stat(projectScriptFile(home, project.id, 'habit-store'));

    const page = await catalog.readItemFile(
      'project-type',
      'example-habit-tracker',
      'pages/dashboard/index.html',
      'installed-ai-apps',
      '1.0.0',
    );
    expect(page?.toString('utf8')).toContain('gezel.tools.invoke');
  });

  it('example-reading-circle installs the crew, both craftbooks, and the schedule', async () => {
    const { home, store, catalog, appId } = await freshInstall('example-reading-circle');
    const project = await store.createProject({ name: 'Circle' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: appId },
    );
    expect(applied.gezelsCreated).toHaveLength(2);
    expect(applied.gezelsCreated[0]?.templateId).toBe('example-circle-host');
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    // The embedded type-private craftbook AND the craftbook-template item
    // both land as project-local copies.
    expect([...applied.craftbooksInstalled].sort()).toEqual([
      'example-reading-digest',
      'session-prep',
    ]);
    expect(applied.schedulesCreated).toHaveLength(1);
    expect(applied.workspaceSeeded).toEqual(['circle.json']);
  });

  it('example-reading-circle locks its required toolset dependency', async () => {
    const packed = await packGezappFromSource(join(EXAMPLES, 'example-reading-circle'), {
      createdAt: CREATED_AT,
    });
    const lock = packed.manifest.dependencies.find(
      (dependency) => dependency.kind === 'toolset' && dependency.id === 'web-search',
    );
    expect(lock?.required).toBe(true);
  });
});
