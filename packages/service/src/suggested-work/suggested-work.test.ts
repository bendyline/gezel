import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCraftbookResolver } from '../craftbook/resolve.js';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import { NIGHT_SHIFT_HEARTBEAT_CRON } from '../tasks/schedule-host.js';
import {
  type SuggestedWorkDeps,
  disableSuggestedWork,
  dismissSuggestedWork,
  enableSuggestedWork,
} from './enable.js';
import { resolveSuggestedWork } from './resolve.js';

let home: string;
let dataDir: string;
let store: Store;
let catalog: CatalogService;
let tasks: TaskManager;
let deps: SuggestedWorkDeps;

async function writeIdentityAndVersion(
  kindDir: string,
  id: string,
  identity: object,
  version: string,
  versionBody: object,
  files: Record<string, string> = {},
): Promise<void> {
  const itemDir = join(dataDir, kindDir, id.slice(0, 2), id);
  const vdir = join(itemDir, 'versions', version);
  await mkdir(vdir, { recursive: true });
  await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(identity, null, 2));
  await writeFile(join(vdir, 'manifest.json'), JSON.stringify(versionBody, null, 2));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(vdir, name), content);
  }
}

/** A V2 single-document catalog craftbook template. */
async function writeCraftbookTemplate(id: string, name: string): Promise<void> {
  const itemDir = join(dataDir, 'craftbook-templates', id.slice(0, 2), id);
  const vdir = join(itemDir, 'versions', '1.0.0');
  await mkdir(vdir, { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'craftbook-template',
      id,
      name,
      description: `${name} recurring background run.`,
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    }),
  );
  await writeFile(
    join(vdir, 'craftbook.json'),
    JSON.stringify({
      name,
      description: `${name} recurring background run.`,
      entryStepId: 'run',
      steps: [
        {
          id: 'run',
          name: 'Run',
          prompt: 'Do the recurring run and write the report artifact.',
          terminal: true,
        },
      ],
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
    }),
  );
}

async function seedCatalog(): Promise<void> {
  await writeCraftbookTemplate('security-code-review', 'Security Code Review');
  await writeCraftbookTemplate('weekly-pipeline-review', 'Weekly Pipeline Review');

  await writeIdentityAndVersion(
    'gezel-templates',
    'veiligheidsmeester',
    {
      schemaVersion: 1,
      kind: 'gezel-template',
      id: 'veiligheidsmeester',
      name: 'Veiligheidsmeester',
      description: 'Chief Security Officer for the crew.',
      tags: ['security'],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      role: 'Chief Security Officer',
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      about: 'about.md',
      suggestedTools: [],
      suggestedCraftbooks: [
        {
          craftbookId: 'security-code-review',
          runMode: 'night-shift',
          reason: 'Keeps an eye on new code overnight.',
        },
      ],
    },
    { 'about.md': 'You find the doors that are actually unlocked.' },
  );

  // A template WITHOUT suggestions — fuzzy role fallback must never
  // attribute suggestions through it.
  await writeIdentityAndVersion(
    'gezel-templates',
    'copywriter',
    {
      schemaVersion: 1,
      kind: 'gezel-template',
      id: 'copywriter',
      name: 'Copywriter',
      description: 'Writes crisp copy.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      role: 'Copywriter',
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      about: 'about.md',
      suggestedTools: [],
    },
    { 'about.md': 'You write crisp copy.' },
  );

  await writeIdentityAndVersion(
    'project-types',
    'pipeline-type',
    {
      schemaVersion: 1,
      kind: 'project-type',
      id: 'pipeline-type',
      name: 'Pipeline Type',
      description: 'A type with a weekly review schedule.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      schedules: [
        {
          cron: '0 17 * * 5',
          craftbook: 'weekly-pipeline-review',
          consent: 'ask',
          overlap: 'skip',
        },
      ],
      craftbooks: ['weekly-pipeline-review'],
    },
  );
}

async function seedSecurityGezelOnProject(): Promise<{ projectId: string; gezelId: string }> {
  const project = await store.createProject({ name: 'Shipping App' });
  const gezel = await store.createGezel({
    name: 'Rik',
    role: 'Chief Security Officer',
    about: 'Security specialist.',
    templateId: 'veiligheidsmeester',
    templateVersion: '1.0.0',
  });
  await store.addGezelToProject(project.id, gezel.id, { source: 'manual' });
  return { projectId: project.id, gezelId: gezel.id };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'suggested-work-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'suggested-work-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);
  await seedCatalog();
  tasks = new TaskManager(store);
  tasks.setCraftbookResolver(makeCraftbookResolver(store, catalog));
  deps = { store, catalog, tasks };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('resolveSuggestedWork', () => {
  it('surfaces a roster gezel template suggestion as a virtual item', async () => {
    const { projectId, gezelId } = await seedSecurityGezelOnProject();
    const items = await resolveSuggestedWork(deps, projectId);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.key).toBe('gezel-template:veiligheidsmeester:security-code-review');
    expect(item?.state).toBe('suggested');
    expect(item?.runMode).toBe('night-shift');
    expect(item?.craftbookName).toBe('Security Code Review');
    expect(item?.reason).toContain('overnight');
    expect(item?.source).toMatchObject({ kind: 'gezel-template', gezelId, gezelName: 'Rik' });
    expect(item?.taskRef).toBeUndefined();
  });

  it('attributes suggestions through the role-name fuzzy fallback only for templates that declare them', async () => {
    const project = await store.createProject({ name: 'Fallback' });
    // No templateId provenance — must fuzzy-match on role.
    const cso = await store.createGezel({
      name: 'Saskia',
      role: 'Chief Security Officer',
      about: 'Hand-made security lead.',
    });
    const writer = await store.createGezel({
      name: 'Wout',
      role: 'Copywriter',
      about: 'Hand-made writer.',
    });
    await store.addGezelToProject(project.id, cso.id, { source: 'manual' });
    await store.addGezelToProject(project.id, writer.id, { source: 'manual' });

    const items = await resolveSuggestedWork(deps, project.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toMatchObject({
      kind: 'gezel-template',
      templateId: 'veiligheidsmeester',
      gezelId: cso.id,
    });
  });

  it('surfaces adopted project-type schedules and overlays their existing hosts', async () => {
    const project = await store.createProject({ name: 'Typed' });
    await store.updateProject(project.id, {
      projectType: {
        id: 'pipeline-type',
        version: '1.0.0',
        source: 'bundled',
        appliedAt: new Date().toISOString(),
      },
    });
    const items = await resolveSuggestedWork(deps, project.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'project-type:pipeline-type:weekly-pipeline-review',
      runMode: 'scheduled',
      cron: '0 17 * * 5',
      state: 'suggested',
    });
  });

  it('applies the dismissal overlay to virtual items', async () => {
    const { projectId } = await seedSecurityGezelOnProject();
    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    await dismissSuggestedWork(deps, { projectId, key, dismissed: true });
    const items = await resolveSuggestedWork(deps, projectId);
    expect(items[0]?.state).toBe('dismissed');
    await dismissSuggestedWork(deps, { projectId, key, dismissed: false });
    const again = await resolveSuggestedWork(deps, projectId);
    expect(again[0]?.state).toBe('suggested');
  });

  it('keeps an origin-stamped host listed after its sponsor leaves the roster', async () => {
    const { projectId, gezelId } = await seedSecurityGezelOnProject();
    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    await enableSuggestedWork(deps, { projectId, key });
    await store.removeGezelFromProject(projectId, gezelId);
    const items = await resolveSuggestedWork(deps, projectId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key, state: 'enabled', orphaned: true });
    expect(items[0]?.taskRef).toBeDefined();
  });
});

describe('enable / disable / dismiss', () => {
  it('materializes a night-shift host: active, heartbeat cron, night flags, origin stamp', async () => {
    const { projectId, gezelId } = await seedSecurityGezelOnProject();
    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    const { item, task } = await enableSuggestedWork(deps, { projectId, key });
    expect(item.state).toBe('enabled');
    expect(task.status).toBe('active');
    expect(task.nightShift).toEqual({ enabled: true, onceADay: true });
    expect(task.cron?.expression).toBe(NIGHT_SHIFT_HEARTBEAT_CRON);
    expect(task.cron?.overlap).toBe('skip');
    expect(task.spawnsCraftbook?.id).toBe('security-code-review');
    expect(task.origin).toEqual({
      kind: 'gezel-suggested-craftbook',
      templateId: 'veiligheidsmeester',
      suggestionKey: 'security-code-review',
    });
    expect(task.assignee).toEqual({ kind: 'gezel', gezelId });
  });

  it('disable pauses the host; re-enable resurrects the SAME task', async () => {
    const { projectId } = await seedSecurityGezelOnProject();
    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    const first = await enableSuggestedWork(deps, { projectId, key });

    const disabled = await disableSuggestedWork(deps, { projectId, key });
    expect(disabled.state).toBe('paused');
    const paused = await tasks.getByRef(first.task.ref);
    expect(paused?.status).toBe('paused');

    const second = await enableSuggestedWork(deps, { projectId, key });
    expect(second.task.ref).toBe(first.task.ref);
    expect(second.task.status).toBe('active');
    const all = await store.listProjectTasks(projectId);
    expect(all.filter((t) => t.spawnsCraftbook?.id === 'security-code-review')).toHaveLength(1);
  });

  it('enabling un-dismisses', async () => {
    const { projectId } = await seedSecurityGezelOnProject();
    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    await dismissSuggestedWork(deps, { projectId, key, dismissed: true });
    await enableSuggestedWork(deps, { projectId, key });
    const project = await store.getProject(projectId);
    expect(project?.suggestedWorkDismissed ?? []).not.toContain(key);
  });

  it('recreates a host after deletion (fresh ref, same origin identity)', async () => {
    const { projectId } = await seedSecurityGezelOnProject();
    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    const first = await enableSuggestedWork(deps, { projectId, key });
    await tasks.setStatus(projectId, first.task.num, 'canceled');

    const items = await resolveSuggestedWork(deps, projectId);
    expect(items[0]?.state).toBe('suggested');

    const second = await enableSuggestedWork(deps, { projectId, key });
    expect(second.task.ref).not.toBe(first.task.ref);
    expect(second.task.origin).toEqual(first.task.origin);
  });

  it('enable on a project-type item with a pending approval question arms the host and answers the question', async () => {
    const project = await store.createProject({ name: 'Typed' });
    await store.updateProject(project.id, {
      projectType: {
        id: 'pipeline-type',
        version: '1.0.0',
        source: 'bundled',
        appliedAt: new Date().toISOString(),
      },
    });
    // Simulate what adoption does for consent:'ask' — a paused host with
    // its origin stamp and a pending schedule-approval question.
    const host = await tasks.create(
      project.id,
      {
        title: 'Schedule: weekly-pipeline-review',
        description:
          'Recurring craftbook run installed by the "pipeline-type" project type. Cron (UTC): 0 17 * * 5.',
        assignee: { kind: 'user' },
        steps: [{ name: 'Wait for schedule', prompt: 'Host placeholder step for the schedule.' }],
        spawnsCraftbookId: 'weekly-pipeline-review',
        cron: { expression: '0 17 * * 5', overlap: 'skip' },
        createdBy: { kind: 'user' },
      },
      {
        origin: {
          kind: 'project-type-schedule',
          typeId: 'pipeline-type',
          scheduleKey: 'weekly-pipeline-review',
        },
      },
    );
    await tasks.setStatus(project.id, host.num, 'paused');
    await store.writeQuestion({
      id: 'q-1',
      projectId: project.id,
      gezelId: '',
      sessionId: '',
      prompt: 'Enable the weekly pipeline review?',
      choices: ['Enable schedule', 'Keep paused'],
      allowWriteIn: false,
      multiSelect: false,
      taskRef: host.ref,
      intent: {
        kind: 'schedule-approval',
        typeId: 'pipeline-type',
        craftbookId: 'weekly-pipeline-review',
        cron: '0 17 * * 5',
        overlap: 'skip',
      },
      createdAt: new Date().toISOString(),
    });

    const key = 'project-type:pipeline-type:weekly-pipeline-review';
    const before = await resolveSuggestedWork(deps, project.id);
    expect(before[0]).toMatchObject({ key, state: 'paused', pendingQuestionId: 'q-1' });

    const { task } = await enableSuggestedWork(deps, { projectId: project.id, key });
    expect(task.ref).toBe(host.ref);
    expect(task.status).toBe('active');
    const questions = await store.listProjectQuestions(project.id);
    expect(questions.find((q) => q.id === 'q-1')?.answer?.selectedChoices).toEqual([0]);
  });

  it('adopts an existing same-craftbook host instead of double-scheduling', async () => {
    const { projectId } = await seedSecurityGezelOnProject();
    // A hand-made night host for the same book, no suggested-work origin.
    const handMade = await tasks.create(projectId, {
      title: 'My own security review',
      description:
        'A hand-created recurring night host for the security-code-review craftbook, made in the Tasks view.',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait for schedule', prompt: 'Host placeholder step for the schedule.' }],
      spawnsCraftbookId: 'security-code-review',
      cron: { expression: NIGHT_SHIFT_HEARTBEAT_CRON, overlap: 'skip' },
      nightShift: { enabled: true, onceADay: true },
      createdBy: { kind: 'user' },
    });

    const key = 'gezel-template:veiligheidsmeester:security-code-review';
    const { task } = await enableSuggestedWork(deps, { projectId, key });
    expect(task.ref).toBe(handMade.ref);
    const all = await store.listProjectTasks(projectId);
    expect(all.filter((t) => t.spawnsCraftbook?.id === 'security-code-review')).toHaveLength(1);
  });
});
