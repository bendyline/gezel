import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { applyProjectType } from './apply.js';
import {
  ProjectTypeUpgradeNeedsOkError,
  applyProjectTypeUpdate,
  planProjectTypeUpgrade,
} from './upgrade.js';

let home: string;
let dataDir: string;
let store: Store;
let catalog: CatalogService;
let historyKinds: string[];

const deps = () => ({ store, catalog, home });

const IDENTITY = {
  schemaVersion: 1,
  kind: 'project-type',
  id: 'roster',
  name: 'Shift Roster',
  description: 'Plan who works when.',
  tags: [],
  maintainer: { name: 'Test' },
  yankedVersions: [],
};

const SCRIPT_V1 = 'export const meta = { name: "roster-store" };\n// v1\n';

function versionBody(version: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version,
    releasedAt: '2026-11-01T00:00:00Z',
    params: {
      type: 'object',
      properties: { business: { type: 'string', default: 'the business' } },
    },
    aboutTemplate: 'about.md',
    missionTemplate: 'mission.md',
    indexingEnabled: false,
    gezels: [{ templateId: 'scheduler', voorman: true }],
    scripts: { 'roster-store': SCRIPT_V1 },
    tools: [{ name: 'add_shift', description: 'Add a shift.', script: 'roster-store' }],
    pages: { entry: 'roster/index.html' },
    workspaceSeed: ['staff.json'],
    ...extra,
  };
}

const FILES_V1 = {
  'about.md': 'Scheduling for {{business}}.',
  'mission.md': 'Every shift covered at {{business}}.',
  'staff.json': '{"version":1,"staff":[]}\n',
  'pages/roster/index.html': '<h1>Old roster</h1>',
};

async function writeVersion(
  id: string,
  identity: object,
  version: string,
  body: object,
  files: Record<string, string>,
): Promise<void> {
  const itemDir = join(dataDir, 'project-types', id.slice(0, 2), id);
  const vdir = join(itemDir, 'versions', version);
  await mkdir(vdir, { recursive: true });
  await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(identity, null, 2));
  await writeFile(join(vdir, 'manifest.json'), JSON.stringify(body, null, 2));
  for (const [name, content] of Object.entries(files)) {
    const dest = join(vdir, name);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content);
  }
}

async function writeTemplate(id: string, role: string): Promise<void> {
  const itemDir = join(dataDir, 'gezel-templates', id.slice(0, 2), id);
  const vdir = join(itemDir, 'versions', '1.0.0');
  await mkdir(vdir, { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'gezel-template',
      id,
      name: role,
      description: `${role}.`,
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      role,
    }),
  );
  await writeFile(
    join(vdir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-11-01T00:00:00Z',
      about: 'about.md',
      suggestedTools: [],
    }),
  );
  await writeFile(join(vdir, 'about.md'), `You are the ${role}.`);
}

/** A project made with Shift Roster 1.0.0, before any newer version existed. */
async function rosterProjectAt100(name = 'Cafe'): Promise<string> {
  await writeVersion('roster', IDENTITY, '1.0.0', versionBody('1.0.0'), FILES_V1);
  const project = await store.createProject({ name });
  await applyProjectType(deps(), {
    projectId: project.id,
    typeId: 'roster',
    params: { business: 'a café' },
  });
  return project.id;
}

/** Shift Roster 1.1.0: the same app with a new page, unless `extra` says otherwise. */
async function publish110(
  extra: Record<string, unknown> = {},
  files: Record<string, string> = {},
): Promise<void> {
  await writeVersion('roster', IDENTITY, '1.1.0', versionBody('1.1.0', extra), {
    ...FILES_V1,
    'pages/roster/index.html': '<h1>New roster</h1>',
    ...files,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pt-upgrade-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'pt-upgrade-data-'));
  historyKinds = [];
  const history = {
    log: async (event: { kind: string }) => {
      historyKinds.push(event.kind);
    },
  } as unknown as HistoryManager;
  store = new Store({ home, history });
  await store.ensureLayout();
  catalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);
  await writeTemplate('scheduler', 'Shift Scheduler');
  await writeTemplate('helper', 'Floor Helper');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('app updates', () => {
  it('says an update waits for the person where the sweep never runs', async () => {
    const projectId = await rosterProjectAt100();
    await publish110();
    await store.updateProject(projectId, { archived: true });
    // The panel would otherwise say "An update is being applied." forever.
    expect(await planProjectTypeUpgrade(deps(), projectId)).toMatchObject({
      automatic: false,
      needsOk: [],
    });
  });

  it('moves a page-only update on its own and leaves the data alone', async () => {
    const projectId = await rosterProjectAt100();
    const ws = await store.projectWorkspaceDir(projectId);
    await writeFile(join(ws, 'staff.json'), '{"version":1,"staff":["Joe"]}\n');
    const before = await store.getProject(projectId);
    await publish110();

    const plan = await planProjectTypeUpgrade(deps(), projectId);
    expect(plan).toMatchObject({
      typeName: 'Shift Roster',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      automatic: true,
      needsOk: [],
    });
    expect(plan?.changes.page).toBe(true);
    expect(plan?.changes.scripts).toEqual([{ name: 'roster-store', change: 'replace' }]);
    expect(plan?.changes.about).toBe('unchanged');

    historyKinds = [];
    const applied = await applyProjectTypeUpdate(deps(), { projectId });
    expect(applied.upgradedFrom).toBe('1.0.0');
    expect(applied.version).toBe('1.1.0');
    expect(applied.seedsSkipped).toEqual(['staff.json']);

    const after = await store.getProject(projectId);
    expect(after?.projectType).toMatchObject({
      id: 'roster',
      version: '1.1.0',
      source: 'bundled',
      params: { business: 'a café' },
      appliedAt: before?.projectType?.appliedAt,
    });
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.about).toBe('Scheduling for a café.');
    expect(await readFile(join(ws, 'staff.json'), 'utf8')).toBe('{"version":1,"staff":["Joe"]}\n');
    const script = await readFile(projectScriptFile(home, projectId, 'roster-store'), 'utf8');
    expect(script).toBe(`// @gezel-project-type: roster@1.1.0\n${SCRIPT_V1}`);
    // An update is not the person editing their about, mission or crew lead.
    expect(historyKinds).not.toContain('project.about.updated');
    expect(historyKinds).not.toContain('project.mission.updated');
    expect(historyKinds).not.toContain('project.voorman.changed');

    const overlay = await store.readProjectTypeOverlay(projectId);
    expect(overlay?.typeVersion).toBe('1.1.0');
    expect(overlay?.scripts?.map((s) => s.typeVersion)).toEqual(['1.1.0']);
    expect(await planProjectTypeUpgrade(deps(), projectId)).toBeNull();
  });

  it('re-applying the type a project runs moves it forward and keeps changed data', async () => {
    const projectId = await rosterProjectAt100();
    const ws = await store.projectWorkspaceDir(projectId);
    await writeFile(join(ws, 'staff.json'), '{"version":1,"staff":["Ana"]}\n');
    await publish110();

    const applied = await applyProjectType(deps(), { projectId, typeId: 'roster' });
    expect(applied.version).toBe('1.1.0');
    expect(await readFile(join(ws, 'staff.json'), 'utf8')).toContain('Ana');
    expect((await store.getProject(projectId))?.projectType?.params).toEqual({
      business: 'a café',
    });
  });

  it('replaces an about the app wrote and keeps one the person edited', async () => {
    const files = { 'about.md': 'Shift planning for {{business}}.' };
    const untouched = await rosterProjectAt100('Untouched');
    const edited = await rosterProjectAt100('Edited');
    await store.updateProject(edited, { about: 'Our own words.' });
    await publish110({}, files);

    expect((await planProjectTypeUpgrade(deps(), untouched))?.changes.about).toBe('replace');
    expect((await planProjectTypeUpgrade(deps(), edited))?.changes.about).toBe('keep-edited');
    await applyProjectTypeUpdate(deps(), { projectId: untouched });
    await applyProjectTypeUpdate(deps(), { projectId: edited });
    expect((await store.getProject(untouched))?.about).toBe('Shift planning for a café.');
    expect((await store.getProject(edited))?.about).toBe('Our own words.');
  });

  it('tells an app-written about from an edited one without an overlay record', async () => {
    const projectId = await rosterProjectAt100();
    const overlay = await store.readProjectTypeOverlay(projectId);
    await store.writeProjectTypeOverlay(projectId, { ...overlay!, docs: undefined });
    await publish110({}, { 'about.md': 'Shift planning for {{business}}.' });
    expect((await planProjectTypeUpgrade(deps(), projectId))?.changes.about).toBe('replace');
  });

  it('waits for the person before replacing an edited script, then saves a copy', async () => {
    const projectId = await rosterProjectAt100();
    const scriptPath = projectScriptFile(home, projectId, 'roster-store');
    const edited = `${await readFile(scriptPath, 'utf8')}// my tweak\n`;
    await writeFile(scriptPath, edited);
    await publish110();

    const plan = await planProjectTypeUpgrade(deps(), projectId);
    expect(plan?.automatic).toBe(false);
    expect(plan?.needsOk).toEqual([{ kind: 'edited-script', items: ['roster-store'] }]);
    await expect(applyProjectTypeUpdate(deps(), { projectId })).rejects.toBeInstanceOf(
      ProjectTypeUpgradeNeedsOkError,
    );
    expect(await readFile(scriptPath, 'utf8')).toBe(edited);

    const applied = await applyProjectTypeUpdate(deps(), { projectId, personApproved: true });
    expect(applied.scriptsBackedUp).toEqual([
      { name: 'roster-store', path: 'app-updates/roster/1.0.0/roster-store.ts' },
    ]);
    const backup = await readFile(
      join(store.projectArtifactsDir(projectId), 'app-updates/roster/1.0.0/roster-store.ts'),
      'utf8',
    );
    expect(backup).toBe(edited);
    expect(await readFile(scriptPath, 'utf8')).toBe(
      `// @gezel-project-type: roster@1.1.0\n${SCRIPT_V1}`,
    );
  });

  it('recognizes a script the app shipped even without an overlay record', async () => {
    const projectId = await rosterProjectAt100();
    const overlay = await store.readProjectTypeOverlay(projectId);
    await store.writeProjectTypeOverlay(projectId, { ...overlay!, scripts: undefined });
    await publish110();
    const plan = await planProjectTypeUpgrade(deps(), projectId);
    expect(plan?.changes.scripts).toEqual([{ name: 'roster-store', change: 'replace' }]);
    expect(plan?.automatic).toBe(true);
  });

  it('never re-hires crew the person removed, and asks before adding new crew', async () => {
    const projectId = await rosterProjectAt100();
    const lead = (await store.getProject(projectId))?.voormanGezelId;
    expect(lead).toBeTruthy();
    await store.updateProject(projectId, { voormanGezelId: null });
    await store.removeGezelFromProject(projectId, lead!);
    await publish110({
      gezels: [
        { templateId: 'scheduler', voorman: true },
        { templateId: 'helper', voorman: false },
      ],
    });

    const plan = await planProjectTypeUpgrade(deps(), projectId);
    expect(plan?.needsOk).toEqual([{ kind: 'new-crew', items: ['helper'] }]);
    const gezelsBefore = (await store.listGezels()).length;
    const applied = await applyProjectTypeUpdate(deps(), { projectId, personApproved: true });
    expect(applied.gezelsCreated.map((g) => g.templateId)).toEqual(['helper']);
    expect((await store.listGezels()).length).toBe(gezelsBefore + 1);
    expect((await store.getProject(projectId))?.gezelIds).not.toContain(lead);
  });

  it('writes a new seed and keeps one the person changed', async () => {
    const projectId = await rosterProjectAt100();
    const ws = await store.projectWorkspaceDir(projectId);
    await writeFile(join(ws, 'staff.json'), '{"version":1,"staff":["Mo"]}\n');
    await publish110(
      { workspaceSeed: ['staff.json', 'rules.json'] },
      { 'rules.json': '{"version":1,"rules":[]}\n' },
    );

    const plan = await planProjectTypeUpgrade(deps(), projectId);
    expect(plan?.changes.seeds).toEqual([
      { path: 'staff.json', state: 'keep-modified' },
      { path: 'rules.json', state: 'new' },
    ]);
    await applyProjectTypeUpdate(deps(), { projectId });
    expect(await readFile(join(ws, 'rules.json'), 'utf8')).toBe('{"version":1,"rules":[]}\n');
    expect(await readFile(join(ws, 'staff.json'), 'utf8')).toContain('Mo');
  });

  it('never brings back a data file the person deleted', async () => {
    const projectId = await rosterProjectAt100();
    const ws = await store.projectWorkspaceDir(projectId);
    await rm(join(ws, 'staff.json'));
    await publish110();
    await applyProjectTypeUpdate(deps(), { projectId });
    await expect(readFile(join(ws, 'staff.json'), 'utf8')).rejects.toThrow();
  });

  it('moves an app-managed setting only while the project holds the old value', async () => {
    const kept = await rosterProjectAt100('Kept');
    const moved = await rosterProjectAt100('Moved');
    await store.updateProject(kept, { leadLabel: 'Boss' });
    await publish110({ indexingEnabled: true, leadLabel: 'Scheduler' });

    expect((await planProjectTypeUpgrade(deps(), moved))?.changes.settings).toEqual([
      'leadLabel',
      'indexingEnabled',
    ]);
    expect((await planProjectTypeUpgrade(deps(), kept))?.changes.settings).toEqual([
      'indexingEnabled',
    ]);
    await applyProjectTypeUpdate(deps(), { projectId: moved });
    await applyProjectTypeUpdate(deps(), { projectId: kept });
    expect((await store.getProject(moved))?.leadLabel).toBe('Scheduler');
    expect((await store.getProject(moved))?.indexingEnabled).toBe(true);
    expect((await store.getProject(kept))?.leadLabel).toBe('Boss');
  });

  it('stays inside the major version and skips a version that needs an unknown param', async () => {
    const projectId = await rosterProjectAt100();
    await writeVersion('roster', IDENTITY, '2.0.0', versionBody('2.0.0'), FILES_V1);
    expect(await planProjectTypeUpgrade(deps(), projectId)).toBeNull();

    await publish110({
      params: {
        type: 'object',
        properties: {
          business: { type: 'string', default: 'the business' },
          city: { type: 'string' },
        },
      },
    });
    expect(await planProjectTypeUpgrade(deps(), projectId)).toBeNull();
  });

  it('asks before moving a pinned project', async () => {
    await writeVersion('roster', IDENTITY, '1.0.0', versionBody('1.0.0'), FILES_V1);
    const project = await store.createProject({ name: 'Pinned' });
    await applyProjectType(deps(), {
      projectId: project.id,
      typeId: 'roster',
      version: '1.0.0',
      pin: true,
    });
    await publish110();

    const plan = await planProjectTypeUpgrade(deps(), project.id);
    expect(plan?.needsOk).toEqual([{ kind: 'pinned', items: ['1.0.0'] }]);
    await applyProjectTypeUpdate(deps(), { projectId: project.id, personApproved: true });
    expect((await store.getProject(project.id))?.projectType?.pinned).toBeUndefined();
  });

  it('asks before writing new files into a folder Gezel holds no write grant for', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'pt-upgrade-folder-'));
    try {
      await writeVersion('roster', IDENTITY, '1.0.0', versionBody('1.0.0'), FILES_V1);
      const project = await store.createProject({ name: 'Folder', workingDir: folder });
      await applyProjectType(deps(), { projectId: project.id, typeId: 'roster' });
      await publish110(
        { workspaceSeed: ['staff.json', 'rules.json'] },
        { 'rules.json': '{"version":1,"rules":[]}\n' },
      );
      const plan = await planProjectTypeUpgrade(deps(), project.id);
      expect(plan?.needsOk).toEqual([{ kind: 'folder-write', items: ['rules.json'] }]);
      await applyProjectTypeUpdate(deps(), { projectId: project.id, personApproved: true });
      expect(await readFile(join(folder, 'rules.json'), 'utf8')).toContain('rules');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('finishes an update that stopped part way', async () => {
    const projectId = await rosterProjectAt100();
    await publish110();
    // As if the script step ran and the process stopped before the stamp.
    await writeFile(
      projectScriptFile(home, projectId, 'roster-store'),
      `// @gezel-project-type: roster@1.1.0\n${SCRIPT_V1}`,
    );
    const plan = await planProjectTypeUpgrade(deps(), projectId);
    expect(plan?.changes.scripts).toEqual([{ name: 'roster-store', change: 'unchanged' }]);
    expect(plan?.automatic).toBe(true);
    await applyProjectTypeUpdate(deps(), { projectId });
    expect((await store.getProject(projectId))?.projectType?.version).toBe('1.1.0');
  });
});
