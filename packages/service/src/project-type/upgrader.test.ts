import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import { ProjectTypeUpgrader, StaleProjectTypeUpgradeError } from './upgrader.js';

let home: string;
let dataDir: string;
let store: Store;

async function writeVersion(version: string, page: string): Promise<void> {
  const itemDir = join(dataDir, 'project-types', 'ro', 'roster');
  const vdir = join(itemDir, 'versions', version);
  await mkdir(join(vdir, 'pages', 'roster'), { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'project-type',
      id: 'roster',
      name: 'Shift Roster',
      description: 'Plan who works when.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    }),
  );
  await writeFile(
    join(vdir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version,
      releasedAt: '2026-11-01T00:00:00Z',
      scripts: { 'roster-store': 'export const meta = { name: "roster-store" };\n' },
      tools: [{ name: 'add_shift', description: 'Add a shift.', script: 'roster-store' }],
      pages: { entry: 'roster/index.html' },
      workspaceSeed: ['staff.json'],
    }),
  );
  await writeFile(join(vdir, 'staff.json'), '{"version":1,"staff":[]}\n');
  await writeFile(join(vdir, 'pages', 'roster', 'index.html'), page);
}

function catalogAs(id: string): CatalogService {
  return new CatalogService([new BundledSource({ dataDir, noIndex: true, id })]);
}

async function projectAt100(catalog: CatalogService, name: string): Promise<string> {
  const project = await store.createProject({ name });
  await applyProjectType({ store, catalog, home }, { projectId: project.id, typeId: 'roster' });
  return project.id;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pt-upgrader-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'pt-upgrader-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  await writeVersion('1.0.0', '<h1>Old</h1>');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('ProjectTypeUpgrader', () => {
  it('updates stale Gilde projects and announces each one', async () => {
    const catalog = catalogAs('bundled');
    const projectId = await projectAt100(catalog, 'Cafe');
    await writeVersion('1.1.0', '<h1>New</h1>');
    const events: unknown[] = [];
    const history: string[] = [];
    const reset: string[] = [];
    const upgrader = new ProjectTypeUpgrader({
      store,
      catalog,
      home,
      chatEvents: { publishProjectEvent: (_id, event) => events.push(event) },
      history: {
        log: async (event) => {
          history.push(event.kind);
        },
      },
      resetProjectSessions: async (id) => {
        reset.push(id);
      },
    });

    expect(await upgrader.sweep('test')).toEqual({ updated: [projectId], waiting: [] });
    expect((await store.getProject(projectId))?.projectType?.version).toBe('1.1.0');
    expect(events).toEqual([{ type: 'project_updated', projectId, reason: 'project-type' }]);
    expect(history).toEqual(['project.type.updated']);
    expect(reset).toEqual([projectId]);
    expect(await upgrader.sweep('again')).toEqual({ updated: [], waiting: [] });
  });

  it('waits while a turn runs in the project, then updates on the retry', async () => {
    const catalog = catalogAs('bundled');
    const projectId = await projectAt100(catalog, 'Busy');
    await writeVersion('1.1.0', '<h1>New</h1>');
    let busy = true;
    const upgrader = new ProjectTypeUpgrader({
      store,
      catalog,
      home,
      isProjectBusy: () => busy,
      retryMs: 60_000,
    });
    try {
      expect(await upgrader.sweep('test')).toEqual({ updated: [], waiting: [projectId] });
      busy = false;
      expect(await upgrader.sweep('retry', new Set([projectId]))).toEqual({
        updated: [projectId],
        waiting: [],
      });
    } finally {
      upgrader.stop();
    }
  });

  it('never updates an app from outside Gezel’s catalog on its own', async () => {
    const catalog = catalogAs('local');
    const projectId = await projectAt100(catalog, 'Private app');
    await writeVersion('1.1.0', '<h1>New</h1>');
    const upgrader = new ProjectTypeUpgrader({ store, catalog, home });

    expect((await upgrader.sweep('test')).updated).toEqual([]);
    const plan = await upgrader.plan(projectId);
    expect(plan?.needsOk).toEqual([{ kind: 'other-source', items: ['local'] }]);
    await upgrader.upgrade(projectId, '1.1.0');
    expect((await store.getProject(projectId))?.projectType?.version).toBe('1.1.0');
  });

  it('skips pinned and archived projects, and refuses a stale approval', async () => {
    const catalog = catalogAs('bundled');
    const pinned = await store.createProject({ name: 'Pinned' });
    await applyProjectType(
      { store, catalog, home },
      { projectId: pinned.id, typeId: 'roster', version: '1.0.0', pin: true },
    );
    const archived = await projectAt100(catalog, 'Archived');
    await store.updateProject(archived, { archived: true });
    await writeVersion('1.1.0', '<h1>New</h1>');
    const upgrader = new ProjectTypeUpgrader({ store, catalog, home });

    expect((await upgrader.sweep('test')).updated).toEqual([]);
    await expect(upgrader.upgrade(pinned.id, '1.0.5')).rejects.toBeInstanceOf(
      StaleProjectTypeUpgradeError,
    );
  });

  it('does nothing with automatic updates turned off', async () => {
    const catalog = catalogAs('bundled');
    await projectAt100(catalog, 'Off');
    await writeVersion('1.1.0', '<h1>New</h1>');
    const upgrader = new ProjectTypeUpgrader({ store, catalog, home, automaticUpdates: false });
    expect(await upgrader.sweep('test')).toEqual({ updated: [], waiting: [] });
  });
});
