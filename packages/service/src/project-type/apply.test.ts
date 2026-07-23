import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import { applyProjectType, preflightProjectType, renderProjectTypeTemplate } from './apply.js';

let home: string;
let dataDir: string;
let store: Store;
let catalog: CatalogService;

/** Write a catalog item's identity + one version folder under the temp data dir. */
async function writeItem(
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
    const dest = join(vdir, name);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content);
  }
}

/** A minimal, graph-valid embedded craftbook document (JSON encoding). */
const DAILY_LESSON_DOC = JSON.stringify({
  name: 'Daily Lesson',
  description: 'A short daily practice session with the trainer.',
  entryStepId: 'practice',
  steps: [
    {
      id: 'practice',
      name: 'Practice',
      prompt: 'Run a short practice session and record it with the progress store.',
      terminal: true,
    },
  ],
});

async function seedCatalog(): Promise<void> {
  // An http-mcp toolset the project type registers (just a URL — installs on
  // adoption).
  await writeItem(
    'toolsets',
    'web-search',
    {
      schemaVersion: 1,
      kind: 'toolset',
      id: 'web-search',
      name: 'Web Search',
      description: 'Search the web.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      runtime: { kind: 'http-mcp', url: 'https://example.com/mcp' },
      tools: [],
      config: [],
    },
  );

  // Gilde gezel-templates the project type creates (two — the first
  // voorman:true entry wins the voorman slot).
  await writeItem(
    'gezel-templates',
    'trainer',
    {
      schemaVersion: 1,
      kind: 'gezel-template',
      id: 'trainer',
      name: 'Language Trainer',
      description: 'A patient language tutor.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      role: 'Language Trainer',
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      about: 'about.md',
      suggestedTools: [],
    },
    { 'about.md': 'You are a warm, patient language tutor.' },
  );
  await writeItem(
    'gezel-templates',
    'coach',
    {
      schemaVersion: 1,
      kind: 'gezel-template',
      id: 'coach',
      name: 'Practice Coach',
      description: 'Keeps the practice cadence honest.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
      role: 'Practice Coach',
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      about: 'about.md',
      suggestedTools: [],
    },
    { 'about.md': 'You keep the student accountable, kindly.' },
  );

  // The project type itself.
  await writeItem(
    'project-types',
    'language-trainer',
    {
      schemaVersion: 1,
      kind: 'project-type',
      id: 'language-trainer',
      name: 'Language Trainer',
      description: 'Practice a language with a patient tutor who tracks your progress.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      extends: 'content-writing',
      tabVisibility: { overview: false, approvals: false },
      params: { type: 'object', properties: { language: { type: 'string' } } },
      aboutTemplate: 'about.md',
      missionTemplate: 'mission.md',
      gezels: [{ templateId: 'trainer', voorman: true }, { templateId: 'coach' }],
      scripts: { 'progress-store': 'export const meta = { name: "progress-store" };\n' },
      tools: [{ name: 'advance_level', description: 'Advance.', script: 'progress-store' }],
      pages: { entry: 'dashboard/index.html' },
      toolsets: [{ id: 'web-search', need: 'suggested' }],
      schedules: [{ cron: '0 18 * * *', craftbook: 'daily-lesson', consent: 'ask' }],
      craftbooks: ['daily-lesson'],
      workspaceSeed: ['progress.json'],
    },
    {
      'about.md': 'A project to learn {{language}} with a patient tutor.',
      'mission.md': 'Reach conversational fluency in {{language}}.',
      'progress.json': '{"language":"{{language}}","level":1}\n',
      'craftbooks/daily-lesson.json': DAILY_LESSON_DOC,
    },
  );

  // A solo (ambachtsman) project type with a custom lead label — the shape
  // checkers/games use: a single roster gezel, no separate voorman, and a
  // domain word ("Opponent") in place of "Ambachtsman".
  await writeItem(
    'project-types',
    'solo-game',
    {
      schemaVersion: 1,
      kind: 'project-type',
      id: 'solo-game',
      name: 'Solo Game',
      description: 'A single-gezel game you play against one opponent.',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    },
    '1.0.0',
    {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      mode: 'solo',
      leadLabel: 'Opponent',
      leanProfile: true,
      gezels: [{ templateId: 'trainer', voorman: true }],
    },
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pt-apply-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'pt-apply-data-'));
  store = new Store({ home });
  await store.ensureLayout();
  catalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);
  await seedCatalog();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('renderProjectTypeTemplate', () => {
  it('substitutes known params and leaves unknown placeholders intact', () => {
    expect(renderProjectTypeTemplate('Learn {{language}} now', { language: 'Spanish' })).toBe(
      'Learn Spanish now',
    );
    expect(renderProjectTypeTemplate('Hi {{missing}}', { language: 'Spanish' })).toBe(
      'Hi {{missing}}',
    );
    expect(renderProjectTypeTemplate('n={{ n }}', { n: 3 })).toBe('n=3');
  });
});

describe('applyProjectType', () => {
  it('applies a solo type: maps manifest mode + leadLabel onto the project', async () => {
    const project = await store.createProject({ name: 'Game' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'solo-game' },
    );
    // Single-gezel roster: the one gezel is the lead (the ambachtsman).
    expect(applied.gezelsCreated).toHaveLength(1);
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);

    // The manifest's solo shape + custom label land on the project — this
    // also exercises the catalog resolution carrying `mode`/`leadLabel`
    // through `mergeIdentityAndVersion` (noIndex fixture walks per-file).
    const detail = await store.getProject(project.id);
    expect(detail?.mode).toBe('solo');
    expect(detail?.leadLabel).toBe('Opponent');
    expect(detail?.leanProfile).toBe(true);
  });

  it('reuses one gezel across lean-profile projects instead of minting a new one each time', async () => {
    const p1 = await store.createProject({ name: 'Game 1' });
    const a1 = await applyProjectType(
      { store, catalog, home },
      { projectId: p1.id, typeId: 'solo-game' },
    );
    const p2 = await store.createProject({ name: 'Game 2' });
    const a2 = await applyProjectType(
      { store, catalog, home },
      { projectId: p2.id, typeId: 'solo-game' },
    );

    // The SAME recurring opponent, not a fresh one per game — and only one
    // global gezel from that template ever exists.
    expect(a2.gezelsCreated[0]?.id).toBe(a1.gezelsCreated[0]?.id);
    const fromTemplate = (await store.listGezels()).filter((g) => g.templateId === 'trainer');
    expect(fromTemplate).toHaveLength(1);
    // Both projects point their lead at that same reused gezel — no
    // "which one is the opponent?" ambiguity.
    expect((await store.getProject(p1.id))?.voormanGezelId).toBe(a1.gezelsCreated[0]?.id);
    expect((await store.getProject(p2.id))?.voormanGezelId).toBe(a1.gezelsCreated[0]?.id);
  });

  it('materializes gezel + voorman + scripts + seed + provenance', async () => {
    const project = await store.createProject({ name: 'Learn Spanish' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Spanish' } },
    );

    // Report reflects what happened + what was deferred.
    expect(applied.version).toBe('1.0.0');
    expect(applied.aboutRendered).toBe(true);
    expect(applied.missionRendered).toBe(true);
    expect(applied.scriptsInstalled).toEqual(['progress-store']);
    expect(applied.workspaceSeeded).toEqual(['progress.json']);
    // Two-gezel crew: the first voorman:true entry wins the voorman slot.
    expect(applied.gezelsCreated).toHaveLength(2);
    expect(applied.gezelsCreated[0]?.templateId).toBe('trainer');
    expect(applied.gezelsCreated[0]?.voorman).toBe(true);
    expect(applied.gezelsCreated[1]?.templateId).toBe('coach');
    expect(applied.gezelsCreated[1]?.voorman).toBe(false);
    // The http-mcp toolset installs on adoption into the project scope.
    expect(applied.toolsetsInstalled).toEqual(['web-search']);
    // Script-backed tools are type-owned references: bound live per-session,
    // nothing to install or defer.
    expect(applied.toolsBound).toEqual(['advance_level']);
    // The embedded craftbook copy-installs into the project workspace with a
    // provenance sidecar; deferred.craftbooks now carries failures only.
    expect(applied.craftbooksInstalled).toEqual(['daily-lesson']);
    expect(applied.deferred).toEqual({
      toolsets: [],
      craftbooks: [],
      pages: true,
      schedules: 0,
    });
    const installedBook = await store.getProjectCraftbook(project.id, 'daily-lesson');
    expect(installedBook?.name).toBe('Daily Lesson');
    expect(installedBook?.steps).toHaveLength(1);
    const sidecar = await store.readProjectCraftbookProvenance(project.id, 'daily-lesson');
    expect(sidecar?.installedBy).toBe('project-type');
    expect(sidecar?.typeId).toBe('language-trainer');
    expect(sidecar?.typeVersion).toBe('1.0.0');
    expect(sidecar?.contentHash?.startsWith('sha256:')).toBe(true);

    // consent:'ask' → a PAUSED schedule host with origin provenance, a
    // snapshotted spawn craftbook from the project-installed copy, and a
    // pending schedule-approval question attached to it. Never silently armed.
    expect(applied.schedulesCreated).toEqual([
      {
        ref: `${project.id}/1`,
        craftbook: 'daily-lesson',
        cron: '0 18 * * *',
        consent: 'ask',
        status: 'paused',
        created: true,
      },
    ]);
    const hosts = await store.listProjectTasks(project.id);
    expect(hosts).toHaveLength(1);
    const host = hosts[0]!;
    expect(host.status).toBe('paused');
    expect(host.origin).toEqual({
      kind: 'project-type-schedule',
      typeId: 'language-trainer',
      scheduleKey: 'daily-lesson',
    });
    expect(host.cron?.expression).toBe('0 18 * * *');
    expect(host.cron?.nextTickAt).toBeTruthy();
    expect(host.spawnsCraftbook?.entryStepId).toBe('practice');
    expect(host.assignee).toEqual({ kind: 'gezel', gezelId: applied.gezelsCreated[0]?.id });
    const questions = await store.listProjectQuestions(project.id);
    const approval = questions.find((q) => q.intent?.kind === 'schedule-approval');
    expect(approval?.taskRef).toBe(host.ref);
    expect(approval?.answer).toBeUndefined();
    expect(approval?.sessionId).toBe('');
    const projectToolsets = await store.listInstalledToolsets({
      kind: 'project',
      projectId: project.id,
    });
    expect(projectToolsets.map((t) => t.toolsetId)).toEqual(['web-search']);

    // Provenance + inherited taxonomy id + voorman are stamped on the project.
    const detail = await store.getProject(project.id);
    expect(detail?.projectType?.id).toBe('language-trainer');
    expect(detail?.projectType?.version).toBe('1.0.0');
    expect(detail?.projectType?.source).toBe('bundled');
    expect(detail?.projectType?.params).toEqual({ language: 'Spanish' });
    expect(detail?.projectType?.appliedAt).toBeTruthy();
    expect(detail?.projectTypeId).toBe('content-writing');
    expect(detail?.voormanGezelId).toBe(applied.gezelsCreated[0]?.id);
    expect(detail?.tabVisibility).toEqual({ overview: false, approvals: false });

    // Seed file rendered with the param (no leftover placeholder).
    const workspaceDir = await store.projectWorkspaceDir(project.id);
    const seed = await readFile(join(workspaceDir, 'progress.json'), 'utf8');
    expect(seed).toContain('"language":"Spanish"');
    expect(seed).not.toContain('{{');

    // Script installed with the project-type provenance marker.
    const scriptBody = await readFile(
      projectScriptFile(home, project.id, 'progress-store'),
      'utf8',
    );
    expect(scriptBody.startsWith('// @gezel-project-type: language-trainer@1.0.0\n')).toBe(true);
    expect(scriptBody).toContain('export const meta');
  });

  it('re-applying is idempotent for scripts (unchanged body no-ops)', async () => {
    const project = await store.createProject({ name: 'Learn French' });
    const first = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'French' } },
    );
    expect(first.scriptsInstalled).toEqual(['progress-store']);
    const second = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'French' } },
    );
    // Same body already on disk → the installer reports no re-install.
    expect(second.scriptsInstalled).toEqual([]);
    // Same craftbook content + provenance → skip, nothing newly installed.
    expect(second.craftbooksInstalled).toEqual([]);
    expect(second.deferred.craftbooks).toEqual([]);
    expect(await store.getProjectCraftbook(project.id, 'daily-lesson')).not.toBeNull();
    // The schedule host is matched by origin, not duplicated; the pending
    // question is not re-posted.
    expect(second.schedulesCreated).toEqual([
      expect.objectContaining({ craftbook: 'daily-lesson', created: false, status: 'paused' }),
    ]);
    expect(await store.listProjectTasks(project.id)).toHaveLength(1);
    const questions = await store.listProjectQuestions(project.id);
    expect(questions.filter((q) => q.intent?.kind === 'schedule-approval')).toHaveLength(1);
  });

  it('re-apply respects a user arm/disarm decision and refreshes a changed cron', async () => {
    const project = await store.createProject({ name: 'Cadence' });
    const first = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Italian' } },
    );
    const hostRef = first.schedulesCreated[0]!.ref;
    const num = Number(hostRef.split('/').at(-1));

    // User arms the host from the Tasks view.
    const tasks = new TaskManager(store);
    await tasks.setStatus(project.id, num, 'active');

    // Manifest cron changes on a new version → simulate by re-applying after
    // bumping the seeded schedule (rewrite the version manifest in place).
    const typeDir = join(dataDir, 'project-types', 'la', 'language-trainer', 'versions', '1.0.0');
    const manifestPath = join(typeDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.schedules = [{ cron: '30 7 * * 1', craftbook: 'daily-lesson', consent: 'ask' }];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const second = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Italian' } },
    );
    expect(second.schedulesCreated[0]).toMatchObject({
      ref: hostRef,
      cron: '30 7 * * 1',
      created: false,
      // The user's arm decision stands — re-apply never re-pauses.
      status: 'active',
    });
    const host = (await store.listProjectTasks(project.id)).find((t) => t.ref === hostRef);
    expect(host?.status).toBe('active');
    expect(host?.cron?.expression).toBe('30 7 * * 1');
  });

  it("consent 'auto' arms on adoption; 'disabled' stays paused with no question", async () => {
    for (const [consent, expectedStatus, expectQuestion] of [
      ['auto', 'active', false],
      ['disabled', 'paused', false],
    ] as const) {
      const typeId = `sched-${consent}`;
      await writeItem(
        'project-types',
        typeId,
        {
          schemaVersion: 1,
          kind: 'project-type',
          id: typeId,
          name: `Sched ${consent}`,
          description: `Schedule with consent ${consent}.`,
          tags: [],
          maintainer: { name: 'Test' },
          yankedVersions: [],
        },
        '1.0.0',
        {
          schemaVersion: 1,
          version: '1.0.0',
          releasedAt: '2026-07-06T00:00:00Z',
          craftbooks: ['daily-lesson'],
          schedules: [{ cron: '0 9 * * *', craftbook: 'daily-lesson', consent }],
        },
        { 'craftbooks/daily-lesson.json': DAILY_LESSON_DOC },
      );
      const project = await store.createProject({ name: `Sched ${consent}` });
      const applied = await applyProjectType(
        { store, catalog, home },
        { projectId: project.id, typeId },
      );
      expect(applied.schedulesCreated[0]?.status).toBe(expectedStatus);
      const host = (await store.listProjectTasks(project.id))[0];
      expect(host?.status).toBe(expectedStatus);
      const questions = await store.listProjectQuestions(project.id);
      expect(questions.some((q) => q.intent?.kind === 'schedule-approval')).toBe(expectQuestion);
    }
  });

  it('re-applying leaves a user-modified installed craftbook alone', async () => {
    const project = await store.createProject({ name: 'Learn Dutch' });
    await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Dutch' } },
    );
    const book = await store.getProjectCraftbook(project.id, 'daily-lesson');
    await store.writeProjectCraftbook(project.id, {
      ...book!,
      steps: [{ ...book!.steps[0]!, prompt: 'My own custom practice routine.' }],
    });

    const second = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Dutch' } },
    );
    expect(second.craftbooksInstalled).toEqual([]);
    const kept = await store.getProjectCraftbook(project.id, 'daily-lesson');
    expect(kept?.steps[0]?.prompt).toBe('My own custom practice routine.');
  });

  it('tolerates an unresolvable craftbook id on existing-project apply', async () => {
    await writeItem(
      'project-types',
      'ghost-books',
      {
        schemaVersion: 1,
        kind: 'project-type',
        id: 'ghost-books',
        name: 'Ghost Books',
        description: 'Declares a craftbook that resolves nowhere.',
        tags: [],
        maintainer: { name: 'Test' },
        yankedVersions: [],
      },
      '1.0.0',
      {
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-07-06T00:00:00Z',
        craftbooks: ['ghost'],
        schedules: [{ cron: '0 9 * * *', craftbook: 'ghost', consent: 'auto' }],
      },
    );
    const project = await store.createProject({ name: 'Ghostly' });
    const applied = await applyProjectType(
      { store, catalog, home },
      { projectId: project.id, typeId: 'ghost-books' },
    );
    expect(applied.craftbooksInstalled).toEqual([]);
    expect(applied.deferred.craftbooks).toEqual(['ghost']);
    // The schedule can't snapshot a spawn book that resolves nowhere — it
    // lands in the failed count instead of throwing the whole apply.
    expect(applied.schedulesCreated).toEqual([]);
    expect(applied.deferred.schedules).toBe(1);
    expect(await store.listProjectTasks(project.id)).toHaveLength(0);
  });

  it('preflight rejects a type whose craftbook resolves nowhere', async () => {
    await writeItem(
      'project-types',
      'ghost-books',
      {
        schemaVersion: 1,
        kind: 'project-type',
        id: 'ghost-books',
        name: 'Ghost Books',
        description: 'Declares a craftbook that resolves nowhere.',
        tags: [],
        maintainer: { name: 'Test' },
        yankedVersions: [],
      },
      '1.0.0',
      {
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-07-06T00:00:00Z',
        craftbooks: ['ghost'],
      },
    );
    await expect(preflightProjectType({ catalog }, { typeId: 'ghost-books' })).rejects.toThrow(
      /craftbook ghost resolves nowhere/,
    );
  });

  it('preflight rejects a tool bound to an undeclared script or a builtin name', async () => {
    const base = {
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      scripts: { store: 'export const meta = { name: "store" };\n' },
    };
    await writeItem(
      'project-types',
      'bad-tool-script',
      {
        schemaVersion: 1,
        kind: 'project-type',
        id: 'bad-tool-script',
        name: 'Bad Tool Script',
        description: 'Tool references a script the manifest does not declare.',
        tags: [],
        maintainer: { name: 'Test' },
        yankedVersions: [],
      },
      '1.0.0',
      { ...base, tools: [{ name: 'do_thing', description: 'x', script: 'missing' }] },
    );
    await expect(preflightProjectType({ catalog }, { typeId: 'bad-tool-script' })).rejects.toThrow(
      /references undeclared script/,
    );

    await writeItem(
      'project-types',
      'bad-tool-name',
      {
        schemaVersion: 1,
        kind: 'project-type',
        id: 'bad-tool-name',
        name: 'Bad Tool Name',
        description: 'Tool name collides with a builtin.',
        tags: [],
        maintainer: { name: 'Test' },
        yankedVersions: [],
      },
      '1.0.0',
      { ...base, tools: [{ name: 'run_script', description: 'x', script: 'store' }] },
    );
    await expect(preflightProjectType({ catalog }, { typeId: 'bad-tool-name' })).rejects.toThrow(
      /collides with a builtin tool/,
    );
  });

  it('throws when the project type is unknown', async () => {
    const project = await store.createProject({ name: 'Nope' });
    await expect(
      applyProjectType({ store, catalog, home }, { projectId: project.id, typeId: 'ghost' }),
    ).rejects.toThrow(/not found/);
  });
});
