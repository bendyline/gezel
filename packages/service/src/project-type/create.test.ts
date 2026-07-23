import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import {
  gezelDir,
  projectCreateTransactionsRoot,
  projectDir,
  projectLocalDir,
  projectScriptFile,
} from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import {
  createTypedProject,
  listTypedProjectStagingRoots,
  recoverTypedProjectCreations,
} from './create.js';

let home: string;
let externalRoot: string;
let store: Store;
let history: HistoryManager;
let catalog: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typed-project-create-home-'));
  externalRoot = await mkdtemp(join(tmpdir(), 'typed-project-create-external-'));
  history = new HistoryManager(home);
  store = new Store({
    home,
    history,
    external: {
      projects: join(externalRoot, 'projects'),
      gezels: join(externalRoot, 'gezels'),
    },
  });
  await store.ensureLayout();
  catalog = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
});

const request = {
  name: 'Spanish Practice',
  projectType: {
    typeId: 'language-trainer',
    params: { language: 'Spanish' },
  },
} as const;

describe('createTypedProject', () => {
  it('stages and commits a complete typed project across externalized roots', async () => {
    const response = await createTypedProject({ store, catalog }, request);
    const { project, applied } = response;

    expect(project.projectType?.id).toBe('language-trainer');
    expect(project.about).toContain('Spanish');
    expect(project.missionObjectives).toContain('Spanish');
    expect(applied.gezelsCreated).toHaveLength(1);
    expect(project.voormanGezelId).toBe(applied.gezelsCreated[0]?.id);
    expect(await store.listProjects()).toHaveLength(1);

    // Metadata/scripts/workspace remain local; prose/artifacts and the
    // generated gezel follow the configured external roots.
    await expect(
      stat(join(projectLocalDir(home, project.id), 'project.json')),
    ).resolves.toBeDefined();
    await expect(
      stat(projectScriptFile(home, project.id, 'progress-store')),
    ).resolves.toBeDefined();
    await expect(
      stat(join(projectDir(home, project.id, store.externalFolders), 'documents', 'about.md')),
    ).resolves.toBeDefined();
    await expect(
      stat(gezelDir(home, applied.gezelsCreated[0]!.id, store.externalFolders)),
    ).resolves.toBeDefined();
    expect(await listTypedProjectStagingRoots(home)).toEqual([]);

    const events = await history.listEvents({ projectId: project.id });
    expect(events.filter((event) => event.kind === 'project.created')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'project.updated')).toHaveLength(1);
  });

  it('preflight failure publishes nothing and records no history', async () => {
    await expect(
      createTypedProject(
        { store, catalog },
        { name: 'Missing Type', projectType: { typeId: '__missing__' } },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_TYPE_INVALID', status: 400 });

    expect(await store.listProjects()).toEqual([]);
    expect(await store.listGezels()).toEqual([]);
    expect(await history.listEvents()).toEqual([]);
    expect(await listTypedProjectStagingRoots(home)).toEqual([]);
  });

  it('a failure after apply but before commit removes the isolated stage', async () => {
    await expect(
      createTypedProject(
        {
          store,
          catalog,
          hooks: { beforeCommit: () => Promise.reject(new Error('injected before commit')) },
        },
        request,
      ),
    ).rejects.toThrow('injected before commit');

    expect(await store.listProjects()).toEqual([]);
    expect(await store.listGezels()).toEqual([]);
    expect(await history.listEvents()).toEqual([]);
    expect(await listTypedProjectStagingRoots(home)).toEqual([]);
  });

  it('rolls back already-published transaction-owned paths on promotion failure', async () => {
    let publishedGezelId = '';
    await expect(
      createTypedProject(
        {
          store,
          catalog,
          hooks: {
            afterCommitStep: (step) => {
              if (step.kind !== 'gezel') return;
              publishedGezelId = step.id;
              throw new Error('injected promotion failure');
            },
          },
        },
        request,
      ),
    ).rejects.toThrow('injected promotion failure');

    expect(publishedGezelId).not.toBe('');
    expect(await store.getGezel(publishedGezelId)).toBeNull();
    expect(await store.listProjects()).toEqual([]);
    expect(await history.listEvents()).toEqual([]);
    expect(await listTypedProjectStagingRoots(home)).toEqual([]);
  });

  it('publishes schedule hosts and consent questions with the atomic commit', async () => {
    // Temp-catalog fixture: the shipped language-trainer declares no
    // schedules yet, and this test is about the STAGING path — hosts and
    // questions written against the staging store must surface through the
    // real store only after the publish.
    const dataDir = await mkdtemp(join(tmpdir(), 'typed-create-sched-data-'));
    const writeFixtureItem = async (
      kindDir: string,
      id: string,
      identity: object,
      versionBody: object,
      files: Record<string, string> = {},
    ) => {
      const itemDir = join(dataDir, kindDir, id.slice(0, 2), id);
      const vdir = join(itemDir, 'versions', '1.0.0');
      await mkdir(vdir, { recursive: true });
      await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(identity, null, 2));
      await writeFile(join(vdir, 'manifest.json'), JSON.stringify(versionBody, null, 2));
      for (const [name, content] of Object.entries(files)) {
        const dest = join(vdir, name);
        await mkdir(join(dest, '..'), { recursive: true });
        await writeFile(dest, content);
      }
    };
    await writeFixtureItem(
      'gezel-templates',
      'keeper',
      {
        schemaVersion: 1,
        kind: 'gezel-template',
        id: 'keeper',
        name: 'Keeper',
        description: 'Keeps the cadence.',
        tags: [],
        maintainer: { name: 'Test' },
        yankedVersions: [],
        role: 'Keeper',
      },
      {
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-07-06T00:00:00Z',
        about: 'about.md',
        suggestedTools: [],
      },
      { 'about.md': 'You keep the cadence.' },
    );
    await writeFixtureItem(
      'project-types',
      'cadence-type',
      {
        schemaVersion: 1,
        kind: 'project-type',
        id: 'cadence-type',
        name: 'Cadence',
        description: 'A type with a consent-gated weekly schedule.',
        tags: [],
        maintainer: { name: 'Test' },
        yankedVersions: [],
      },
      {
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-07-06T00:00:00Z',
        gezels: [{ templateId: 'keeper', voorman: true }],
        craftbooks: ['weekly-check'],
        schedules: [{ cron: '0 17 * * 5', craftbook: 'weekly-check', consent: 'ask' }],
      },
      {
        'craftbooks/weekly-check.json': JSON.stringify({
          name: 'Weekly Check',
          entryStepId: 'run',
          steps: [{ id: 'run', name: 'Run', prompt: 'Do the weekly check.', terminal: true }],
        }),
      },
    );
    const { BundledSource } = await import('@bendyline/gezel-catalog');
    const fixtureCatalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);

    try {
      const { project, applied } = await createTypedProject(
        { store, catalog: fixtureCatalog },
        { name: 'Cadence Project', projectType: { typeId: 'cadence-type' } },
      );

      expect(applied.craftbooksInstalled).toEqual(['weekly-check']);
      expect(applied.schedulesCreated).toEqual([
        expect.objectContaining({ craftbook: 'weekly-check', status: 'paused', created: true }),
      ]);
      // Everything staged rode the atomic publish: the REAL store sees the
      // paused host, its provenance, and the pending consent question.
      const hosts = await store.listProjectTasks(project.id);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.status).toBe('paused');
      expect(hosts[0]?.origin?.kind).toBe('project-type-schedule');
      const questions = await store.listProjectQuestions(project.id);
      expect(questions.some((q) => q.intent?.kind === 'schedule-approval')).toBe(true);
      expect(await store.getProjectCraftbook(project.id, 'weekly-check')).not.toBeNull();
      expect(await listTypedProjectStagingRoots(home)).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('never overwrites a real project root materialized outside the coordinator', async () => {
    await expect(
      createTypedProject(
        {
          store,
          catalog,
          hooks: {
            beforeCommit: async () => {
              const target = projectLocalDir(home, 'spanish-practice');
              await mkdir(target, { recursive: true });
              await writeFile(join(target, 'sentinel.txt'), 'external writer');
            },
          },
        },
        request,
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_CREATE_CONFLICT', status: 409 });

    expect(
      await readFile(join(projectLocalDir(home, 'spanish-practice'), 'sentinel.txt'), 'utf8'),
    ).toBe('external writer');
    expect(await store.listProjects()).toEqual([]);
    expect(await store.listGezels()).toEqual([]);
  });
});

describe('typed project transaction recovery', () => {
  const marker = (operationId: string) => `${JSON.stringify({ operationId }, null, 2)}\n`;

  it('rolls back a crash after a gezel publish but before the project commit point', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const projectId = 'crash-project';
    const gezelId = 'crash-gezel';
    const operationRoot = join(projectCreateTransactionsRoot(home), operationId);
    const gezelTarget = gezelDir(home, gezelId, store.externalFolders);
    const externalTarget = projectDir(home, projectId, store.externalFolders);
    const localTarget = projectLocalDir(home, projectId);
    const gezelHidden = join(
      store.externalFolders!.gezels!,
      '.gezel-create-staging',
      operationId,
      gezelId,
    );
    const externalHidden = join(
      store.externalFolders!.projects!,
      '.gezel-create-staging',
      operationId,
      projectId,
    );
    const localHidden = join(home, 'projects', '.gezel-create-staging', operationId, projectId);
    const steps = [
      { kind: 'gezel', id: gezelId, hidden: gezelHidden, target: gezelTarget },
      {
        kind: 'project-external',
        id: projectId,
        hidden: externalHidden,
        target: externalTarget,
      },
      { kind: 'project', id: projectId, hidden: localHidden, target: localTarget },
    ];

    await mkdir(gezelTarget, { recursive: true });
    await writeFile(join(gezelTarget, '.gezel-create-operation.json'), marker(operationId));
    await mkdir(localHidden, { recursive: true });
    await writeFile(join(localHidden, '.gezel-create-operation.json'), marker(operationId));
    await mkdir(operationRoot, { recursive: true });
    await writeFile(
      join(operationRoot, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId,
        projectId,
        createdAt: new Date().toISOString(),
        phase: 'committing',
        steps,
      }),
    );

    await recoverTypedProjectCreations(store);

    await expect(stat(gezelTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(operationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(join(home, 'projects', '.gezel-create-staging', operationId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(home, 'projects', '.gezel-create-staging'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a tampered journal and never deletes its out-of-scope target', async () => {
    const operationId = '22222222-2222-4222-8222-222222222222';
    const projectId = 'tampered-project';
    const operationRoot = join(projectCreateTransactionsRoot(home), operationId);
    const victim = join(externalRoot, 'must-not-delete');
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, 'sentinel.txt'), 'keep me');
    await writeFile(join(victim, '.gezel-create-operation.json'), marker(operationId));
    await mkdir(operationRoot, { recursive: true });
    await writeFile(
      join(operationRoot, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId,
        projectId,
        createdAt: new Date().toISOString(),
        phase: 'committing',
        steps: [
          {
            kind: 'project',
            id: projectId,
            hidden: join(operationRoot, 'fake-hidden'),
            target: victim,
          },
        ],
      }),
    );

    await recoverTypedProjectCreations(store);

    expect(await readFile(join(victim, 'sentinel.txt'), 'utf8')).toBe('keep me');
    await expect(stat(operationRoot)).resolves.toBeDefined();
  });

  it('classifies every target before rollback and touches nothing when one is ambiguous', async () => {
    const operationId = '33333333-3333-4333-8333-333333333333';
    const projectId = 'ambiguous-project';
    const gezelId = 'owned-gezel';
    const operationRoot = join(projectCreateTransactionsRoot(home), operationId);
    const gezelTarget = gezelDir(home, gezelId, store.externalFolders);
    const externalTarget = projectDir(home, projectId, store.externalFolders);
    const localTarget = projectLocalDir(home, projectId);
    const gezelHidden = join(
      store.externalFolders!.gezels!,
      '.gezel-create-staging',
      operationId,
      gezelId,
    );
    const externalHidden = join(
      store.externalFolders!.projects!,
      '.gezel-create-staging',
      operationId,
      projectId,
    );
    const localHidden = join(home, 'projects', '.gezel-create-staging', operationId, projectId);
    const steps = [
      { kind: 'gezel', id: gezelId, hidden: gezelHidden, target: gezelTarget },
      {
        kind: 'project-external',
        id: projectId,
        hidden: externalHidden,
        target: externalTarget,
      },
      { kind: 'project', id: projectId, hidden: localHidden, target: localTarget },
    ];

    await mkdir(gezelTarget, { recursive: true });
    await writeFile(join(gezelTarget, '.gezel-create-operation.json'), marker(operationId));
    await writeFile(join(gezelTarget, 'sentinel.txt'), 'owned but must remain');
    await mkdir(localTarget, { recursive: true });
    await writeFile(join(localTarget, 'sentinel.txt'), 'pre-existing and unowned');
    await mkdir(operationRoot, { recursive: true });
    await writeFile(
      join(operationRoot, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId,
        projectId,
        createdAt: new Date().toISOString(),
        phase: 'committing',
        steps,
      }),
    );

    await recoverTypedProjectCreations(store);

    expect(await readFile(join(gezelTarget, 'sentinel.txt'), 'utf8')).toBe('owned but must remain');
    expect(await readFile(join(localTarget, 'sentinel.txt'), 'utf8')).toBe(
      'pre-existing and unowned',
    );
    await expect(stat(operationRoot)).resolves.toBeDefined();
  });
});
