import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskSchema, isSharedLibraryProject } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigCorruptionError, Store, pickRoleBasedName } from './store.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lv-test-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ensureLayout', () => {
  it('creates the directory skeleton', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(home, 'gezels'))).toBe(true);
    expect(existsSync(join(home, 'projects'))).toBe(true);
    expect(existsSync(join(home, 'runtime'))).toBe(true);
    expect(existsSync(join(home, 'logs'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('repairs an existing per-user home to 0700', async () => {
    await chmod(home, 0o755);

    await store.ensureLayout();

    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform !== 'win32')(
    'leaves an explicitly non-private system home under installer policy',
    async () => {
      await chmod(home, 0o755);
      const systemStore = new Store({ home, privateUserHome: false });

      await systemStore.ensureLayout();

      expect((await stat(home)).mode & 0o777).toBe(0o755);
    },
  );
});

describe('config', () => {
  it('returns empty config initially', async () => {
    const cfg = await store.readConfig();
    expect(cfg).toEqual({});
  });

  it('writes and reads config', async () => {
    await store.writeConfig({ githubToken: 'ghp_test123' });
    const cfg = await store.readConfig();
    expect(cfg.githubToken).toBe('ghp_test123');
  });

  it('merges config fields', async () => {
    await store.writeConfig({ githubToken: 'abc' });
    await store.writeConfig({});
    const cfg = await store.readConfig();
    expect(cfg.githubToken).toBe('abc');
  });

  it('round-trips the supervisor remote-service config through unrelated writes', async () => {
    // `service:{url,token}` is read RAW by the Electron supervisor (Branch-1
    // remote mode). Before it joined the schema, readConfig stripped it and
    // the next settings save silently deleted the remote configuration.
    const service = { url: 'https://remote.example:6228', token: 'remote-token' };
    await store.writeConfig({ service });
    await store.writeConfig({ githubToken: 'unrelated-write' });
    const cfg = await store.readConfig();
    expect(cfg.service).toEqual(service);
    expect(cfg.githubToken).toBe('unrelated-write');
    await store.writeConfig({ service: null });
    expect((await store.readConfig()).service).toBeUndefined();
  });

  it('fails loudly and preserves a malformed config instead of overwriting it', async () => {
    const configPath = join(home, 'config.json');
    const malformed = '{ "provider": "openai", this is truncated';
    await writeFile(configPath, malformed, 'utf8');

    await expect(store.readConfig()).rejects.toBeInstanceOf(ConfigCorruptionError);
    await expect(store.writeConfig({ provider: 'mock' })).rejects.toBeInstanceOf(
      ConfigCorruptionError,
    );
    expect(await readFile(configPath, 'utf8')).toBe(malformed);
  });

  it('fails loudly and preserves syntactically valid config with an invalid schema', async () => {
    const configPath = join(home, 'config.json');
    const invalid = JSON.stringify({ provider: 42 }, null, 2);
    await writeFile(configPath, invalid, 'utf8');

    await expect(store.readConfig()).rejects.toBeInstanceOf(ConfigCorruptionError);
    expect(await readFile(configPath, 'utf8')).toBe(invalid);
  });
});

describe('agents', () => {
  it('creates and lists agents', async () => {
    const created = await store.createGezel({ name: 'Researcher' });
    expect(created.id).toBe('researcher');
    expect(created.name).toBe('Researcher');
    expect(created.about).toContain('# About this role');
    expect(created.about).not.toContain('Researcher');

    const list = await store.listGezels();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('researcher');
  });

  it('sanitizes icons again at the persistence boundary', async () => {
    const created = await store.createGezel({ name: 'Icon keeper' });
    const updated = await store.writeGezelIcon(
      created.id,
      '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>steal()</script><image href="https://attacker.test/pixel"/><path d="M0 0h1v1z" style="fill:red"/></svg>',
    );

    expect(updated.icon).toContain('<path d="M0 0h1v1z"/>');
    expect(updated.icon).not.toContain('script');
    expect(updated.icon).not.toContain('image');
    expect(updated.icon).not.toContain('attacker.test');
    const persisted = await readFile(join(home, 'gezels', created.id, 'icon.svg'), 'utf8');
    expect(persisted).toBe(updated.icon);

    await expect(
      store.writeGezelIcon(
        created.id,
        '<svg xmlns="http://www.w3.org/2000/svg"><script>only content</script></svg>',
      ),
    ).rejects.toThrow('invalid SVG icon');
  });

  it('gets agent detail with parsed markdown', async () => {
    await store.createGezel({ name: 'Helper' });
    const detail = await store.getGezel('helper');
    expect(detail).not.toBeNull();
    expect(detail!.parsed.frontmatter.name).toBe('Helper');
    expect(detail!.parsed.sections.length).toBeGreaterThan(0);
  });

  it('updates about.md', async () => {
    await store.createGezel({ name: 'Bot' });
    const updated = await store.updateGezelAbout('bot', '# Bot\n\nI am a bot.');
    expect(updated.about).toContain('I am a bot.');
  });

  it('renames an agent (folder + frontmatter)', async () => {
    await store.createGezel({ name: 'OldName' });
    const renamed = await store.renameGezel('oldname', 'NewName');
    expect(renamed.id).toBe('newname');
    expect(renamed.name).toBe('NewName');
    expect(await store.getGezel('oldname')).toBeNull();
    expect(await store.getGezel('newname')).not.toBeNull();
  });

  it('returns null for missing agent', async () => {
    expect(await store.getGezel('nonexistent')).toBeNull();
  });

  it('permanently deletes an agent and clears live project/config references', async () => {
    const { existsSync } = await import('node:fs');
    const created = await store.createGezel({ name: 'Maya' });
    await store.createProject({ name: 'Maya Project' });
    await store.updateProject('maya-project', { voormanGezelId: created.id });
    await store.writeConfig({
      klerkGezelId: created.id,
      boekwachterGezelId: created.id,
      keurmeesterGezelId: created.id,
    });

    const removed = await store.deleteGezel(created.id);
    expect(removed).toEqual({ id: 'maya', name: 'Maya' });
    expect(await store.getGezel(created.id)).toBeNull();
    expect(existsSync(join(home, 'gezels', created.id))).toBe(false);

    const project = await store.getProject('maya-project');
    expect(project?.voormanGezelId).toBeUndefined();
    expect(project?.gezelIds).not.toContain(created.id);
    const config = await store.readConfig();
    expect(config.klerkGezelId).toBeUndefined();
    expect(config.boekwachterGezelId).toBeUndefined();
    expect(config.keurmeesterGezelId).toBeUndefined();
  });

  it('throws when deleting a missing agent', async () => {
    await expect(store.deleteGezel('not-here')).rejects.toThrow(/not found/i);
  });

  it('designates a replacement when deleting the current Meester', async () => {
    const maya = await store.createGezel({ name: 'Maya' });
    const bob = await store.createGezel({ name: 'Bob' });
    await store.writeConfig({ meesterGezelId: maya.id });

    await store.deleteGezel(maya.id);

    expect((await store.readConfig()).meesterGezelId).toBe(bob.id);
    expect(await store.getGezel(bob.id)).not.toBeNull();
  });

  describe('roleBasedName', () => {
    it('derives from role on create', async () => {
      const g = await store.createGezel({ name: 'Mira', role: 'Visual designer' });
      expect(g.roleBasedName).toBe('visual-designer');
    });

    it('appends -2, -3 on collision', async () => {
      const a = await store.createGezel({ name: 'Mira', role: 'Designer' });
      const b = await store.createGezel({ name: 'Mara', role: 'Designer' });
      const c = await store.createGezel({ name: 'Mera', role: 'Designer' });
      expect(a.roleBasedName).toBe('designer');
      expect(b.roleBasedName).toBe('designer-2');
      expect(c.roleBasedName).toBe('designer-3');
    });

    it('falls back to gezel-N when role is absent', async () => {
      const a = await store.createGezel({ name: 'Alpha' });
      const b = await store.createGezel({ name: 'Beta' });
      expect(a.roleBasedName).toBe('gezel-1');
      expect(b.roleBasedName).toBe('gezel-2');
    });

    it('recomputes when role changes via raw markdown', async () => {
      const a = await store.createGezel({ name: 'Mira', role: 'Designer' });
      expect(a.roleBasedName).toBe('designer');
      const newSource = a.parsed.source.replace(/role: "Designer"/, 'role: "Visual designer"');
      const updated = await store.updateGezelMarkdown(a.id, newSource);
      expect(updated.role).toBe('Visual designer');
      expect(updated.roleBasedName).toBe('visual-designer');
    });

    it('keeps the slot free for itself when role is unchanged', async () => {
      const a = await store.createGezel({ name: 'Mira', role: 'Designer' });
      // Rewrite the markdown without changing role — roleBasedName must stay put.
      const updated = await store.updateGezelMarkdown(a.id, a.parsed.source);
      expect(updated.roleBasedName).toBe('designer');
    });

    it('is resolvable via @-mention through resolveGezel (case-insensitive)', async () => {
      const g = await store.createGezel({ name: 'Mira', role: 'Visual designer' });
      const all = await store.listGezels();
      const match = all.find((x) => x.roleBasedName === 'visual-designer');
      expect(match?.id).toBe(g.id);
    });
  });
});

describe('pickRoleBasedName (pure)', () => {
  it('returns the slug when not taken', () => {
    expect(pickRoleBasedName('Visual designer', new Set())).toBe('visual-designer');
  });

  it('appends -2 / -3 on collisions', () => {
    expect(pickRoleBasedName('Designer', new Set(['designer']))).toBe('designer-2');
    expect(pickRoleBasedName('Designer', new Set(['designer', 'designer-2']))).toBe('designer-3');
  });

  it('uses gezel-N when role is empty', () => {
    expect(pickRoleBasedName(undefined, new Set())).toBe('gezel-1');
    expect(pickRoleBasedName('', new Set(['gezel-1']))).toBe('gezel-2');
  });

  it('uses gezel-N when role slugifies to empty', () => {
    expect(pickRoleBasedName('!!!', new Set())).toBe('gezel-1');
  });
});

describe('agents — settings', () => {
  it('sets, persists, and clears the font override via updateGezelSettings', async () => {
    await store.createGezel({ name: 'Stylist' });
    expect((await store.getGezel('stylist'))!.font).toBeUndefined();

    const withFont = await store.updateGezelSettings('stylist', { font: 'pt-serif' });
    expect(withFont.font).toBe('pt-serif');
    expect((await store.getGezel('stylist'))!.font).toBe('pt-serif');

    const untouched = await store.updateGezelSettings('stylist', {});
    expect(untouched.font).toBe('pt-serif');

    const cleared = await store.updateGezelSettings('stylist', { font: null });
    expect(cleared.font).toBeUndefined();
    expect((await store.getGezel('stylist'))!.font).toBeUndefined();
  });

  it('sets, persists, and clears the indexed-context policy', async () => {
    await store.createGezel({ name: 'Researcher' });
    const policy = { mode: 'lean' as const, maxTokens: 240, sources: ['workspace' as const] };

    expect(
      (await store.updateGezelSettings('researcher', { retrieval: policy })).retrieval,
    ).toEqual(policy);
    expect((await store.getGezel('researcher'))!.retrieval).toEqual(policy);
    expect((await store.updateGezelSettings('researcher', {})).retrieval).toEqual(policy);
    expect(
      (await store.updateGezelSettings('researcher', { retrieval: null })).retrieval,
    ).toBeUndefined();
  });
});

describe('projects', () => {
  it('creates with artifacts + workspace dirs', async () => {
    const created = await store.createProject({ name: 'My Project' });
    expect(created.id).toBe('my-project');
    const { existsSync } = await import('node:fs');
    const dir = join(home, 'projects', 'my-project');
    expect(existsSync(join(dir, 'artifacts'))).toBe(true);
    expect(existsSync(join(dir, 'workspace'))).toBe(true);
    expect(existsSync(join(dir, 'project.json'))).toBe(true);
  });

  it('serializes concurrent same-name creation so neither project is overwritten', async () => {
    const [first, second] = await Promise.all([
      store.createProject({ name: 'Same Project', description: 'first' }),
      store.createProject({ name: 'Same Project', description: 'second' }),
    ]);
    expect(new Set([first.id, second.id])).toEqual(new Set(['same-project', 'same-project-2']));
    expect((await store.listProjects()).map((project) => project.description).sort()).toEqual([
      'first',
      'second',
    ]);
  });

  it('seeds the default project with catch-all about + mission objectives', async () => {
    await store.ensureDefaultProject();
    const detail = await store.getProject('default');
    expect(detail!.about).toContain('catch-all project');
    expect(detail!.missionObjectives).toContain('Do not pursue coherence between items');
  });

  it('backfills the default docs on installs created before them', async () => {
    await store.createProject({ name: 'Default' });
    expect((await store.getProject('default'))!.about).toBeUndefined();
    await store.ensureDefaultProject();
    expect((await store.getProject('default'))!.about).toContain('catch-all project');
  });

  it('never overwrites an edited default about', async () => {
    await store.ensureDefaultProject();
    await store.writeProjectDoc('default', 'about.md', 'Mine now.');
    await store.ensureDefaultProject();
    expect((await store.getProject('default'))!.about).toBe('Mine now.');
  });

  it('reads project.json metadata', async () => {
    await store.createProject({ name: 'Demo' });
    const detail = await store.getProject('demo');
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('Demo');
    expect(detail!.packages).toEqual([]);
  });

  it('persists and clears an explicit project maker-mark override', async () => {
    const created = await store.createProject({ name: 'Design', icon: 'palette' });
    expect(created.icon).toBe('palette');
    expect((await store.getProject(created.id))?.icon).toBe('palette');

    const cleared = await store.updateProject(created.id, { icon: null });
    expect(cleared.icon).toBeUndefined();
    expect((await store.getProject(created.id))?.icon).toBeUndefined();
  });

  it('stores a creation-time workingDir and disables Meester progress check-ins', async () => {
    await store.createProject({ name: 'External', workingDir: '/tmp/ext' });
    const detail = await store.getProject('external');
    expect(detail!.workingDir).toBe('/tmp/ext');
    expect(detail!.nudgeConfig).toEqual({ enabled: false });
  });

  it('updates working directory', async () => {
    await store.createProject({ name: 'Proj' });
    const updated = await store.updateProjectWorkingDir('proj', '/new/path');
    expect(updated.workingDir).toBe('/new/path');
    const cleared = await store.updateProjectWorkingDir('proj', undefined);
    expect(cleared.workingDir).toBeUndefined();
  });

  it('persists one-way project links, validates targets, and prunes deleted targets', async () => {
    const projectA = await store.createProject({ name: 'Project A' });
    const projectB = await store.createProject({ name: 'Project B' });

    const linked = await store.updateProject(projectA.id, {
      linkedProjectIds: [projectB.id],
    });
    expect(linked.linkedProjectIds).toEqual([projectB.id]);
    expect(await store.linkedProjectIds(projectA.id)).toEqual([projectB.id]);
    expect(await store.projectLinksTo(projectA.id, projectB.id)).toBe(true);
    expect(await store.projectLinksTo(projectA.id, projectA.id)).toBe(false);
    expect(await store.projectLinksTo(projectB.id, projectA.id)).toBe(false);

    await expect(
      store.updateProject(projectA.id, { linkedProjectIds: [projectA.id] }),
    ).rejects.toThrow(/cannot link to itself/i);
    await expect(
      store.updateProject(projectA.id, { linkedProjectIds: ['missing'] }),
    ).rejects.toThrow(/not found/i);
    await expect(
      store.updateProject(projectA.id, { linkedProjectIds: [projectB.id, projectB.id] }),
    ).rejects.toThrow(/duplicates/i);
    await expect(
      store.updateProject(projectA.id, {
        linkedProjectIds: Array.from({ length: 33 }, (_, index) => `project-${index}`),
      }),
    ).rejects.toThrow(/at most 32/i);

    await store.ensureSharedProject();
    const shared = (await store.listProjects()).find(isSharedLibraryProject);
    expect(shared).toBeDefined();
    await expect(
      store.updateProject(projectA.id, { linkedProjectIds: [shared!.id] }),
    ).rejects.toThrow(/shared document library/i);

    await store.deleteProject(projectB.id);
    expect((await store.getProject(projectA.id))?.linkedProjectIds).toBeUndefined();
    expect(await store.linkedProjectIds(projectA.id)).toEqual([]);
  });

  it('writes about.md + missionObjectives.md at creation when supplied', async () => {
    await store.createProject({
      name: 'Docs',
      about: 'About text for the Docs project.',
      missionObjectives: '- Ship docs\n- Be clear',
    });
    const detail = await store.getProject('docs');
    expect(detail!.about).toBe('About text for the Docs project.');
    expect(detail!.missionObjectives).toBe('- Ship docs\n- Be clear');
  });

  it('omits about + missionObjectives when the caller skips them', async () => {
    await store.createProject({ name: 'Bare' });
    const detail = await store.getProject('bare');
    expect(detail!.about).toBeUndefined();
    expect(detail!.missionObjectives).toBeUndefined();
  });

  it('persists `mode: solo` when supplied; omits the field for crew (default)', async () => {
    await store.createProject({ name: 'Job One', mode: 'solo' });
    await store.createProject({ name: 'Crew One', mode: 'crew' });
    await store.createProject({ name: 'Default One' });
    const job = await store.getProject('job-one');
    const crew = await store.getProject('crew-one');
    const defaultProj = await store.getProject('default-one');
    expect(job!.mode).toBe('solo');
    // `crew` is the default — we don't write the field when it's the default
    // so that existing projects on disk (no `mode` field) parse identically.
    expect(crew!.mode).toBeUndefined();
    expect(defaultProj!.mode).toBeUndefined();
  });

  it('archives a project as inactive and restores it without reactivating ambient work', async () => {
    const created = await store.createProject({ name: 'Finished work' });

    const archived = await store.updateProject(created.id, { archived: true });
    expect(archived.archived).toBe(true);
    expect(archived.status).toBe('inactive');

    // Status cannot be reactivated while the project remains buried.
    const stillArchived = await store.updateProject(created.id, { status: 'active' });
    expect(stillArchived.archived).toBe(true);
    expect(stillArchived.status).toBe('inactive');

    const restored = await store.updateProject(created.id, { archived: false });
    expect(restored.archived).toBeUndefined();
    expect(restored.status).toBe('inactive');

    const reactivated = await store.updateProject(created.id, { status: 'active' });
    expect(reactivated.status).toBe('active');
  });
});

describe('deleteProject', () => {
  it('safe delete removes the record but preserves workspace + artifacts', async () => {
    const { existsSync } = await import('node:fs');
    await store.createProject({ name: 'Keeper' });
    const ws = await store.projectWorkspaceDir('keeper');
    await writeFile(join(ws, 'notes.txt'), 'important', 'utf8');
    await store.writeProjectArtifact('keeper', 'out.txt', 'result');

    const res = await store.deleteProject('keeper');
    expect(res).toMatchObject({ removedWorkspace: false, workspaceSource: 'internal' });

    expect(await store.getProject('keeper')).toBeNull();
    expect((await store.listProjects()).some((p) => p.id === 'keeper')).toBe(false);
    // Files survive on disk.
    expect(existsSync(join(ws, 'notes.txt'))).toBe(true);
    expect(existsSync(join(home, 'projects', 'keeper', 'artifacts', 'out.txt'))).toBe(true);
  });

  it('full delete removes the internal workspace + artifacts when opted in', async () => {
    const { existsSync } = await import('node:fs');
    await store.createProject({ name: 'Gone' });
    const ws = await store.projectWorkspaceDir('gone');
    await writeFile(join(ws, 'notes.txt'), 'bye', 'utf8');

    const res = await store.deleteProject('gone', { removeWorkspace: true });
    expect(res.removedWorkspace).toBe(true);
    expect(await store.getProject('gone')).toBeNull();
    expect(existsSync(join(home, 'projects', 'gone'))).toBe(false);
  });

  it('never removes an external workingDir even when removeWorkspace is set', async () => {
    const { existsSync } = await import('node:fs');
    const ext = await mkdtemp(join(tmpdir(), 'lv-ext-'));
    await writeFile(join(ext, 'repo.txt'), 'user code', 'utf8');
    await store.createProject({ name: 'Linked', workingDir: ext });

    const res = await store.deleteProject('linked', { removeWorkspace: true });
    // Workspace is external → the flag is ignored.
    expect(res).toMatchObject({ removedWorkspace: false, workspaceSource: 'workingDir' });
    expect(existsSync(join(ext, 'repo.txt'))).toBe(true);
    expect(await store.getProject('linked')).toBeNull();
    await rm(ext, { recursive: true, force: true });
  });

  it('refuses to delete the default project', async () => {
    await store.createProject({ name: 'Default' }, { id: 'default' });
    await expect(store.deleteProject('default')).rejects.toThrow(/default project/i);
    expect(await store.getProject('default')).not.toBeNull();
  });

  it('throws for a missing project', async () => {
    await expect(store.deleteProject('nope')).rejects.toThrow(/not found/i);
  });

  it('does not re-adopt preserved files: a same-named project claims a fresh id', async () => {
    const { existsSync } = await import('node:fs');
    const first = await store.createProject({ name: 'Recycle' });
    expect(first.id).toBe('recycle');
    const ws = await store.projectWorkspaceDir('recycle');
    await writeFile(join(ws, 'old.txt'), 'stale', 'utf8');
    await store.deleteProject('recycle');

    const second = await store.createProject({ name: 'Recycle' });
    expect(second.id).toBe('recycle-2');
    const ws2 = await store.projectWorkspaceDir(second.id);
    expect(existsSync(join(ws2, 'old.txt'))).toBe(false);
  });
});

describe('project gezel roster', () => {
  it('addGezelToProject adds idempotently and returns whether the entry was new', async () => {
    await store.createProject({ name: 'RosterProj' });
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    const first = await store.addGezelToProject('rosterproj', 'maya');
    const second = await store.addGezelToProject('rosterproj', 'maya');
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    const project = await store.getProject('rosterproj');
    expect(project!.gezelIds).toEqual(['maya']);
  });

  it('addGezelToProject is permissive: a missing gezel id is added without throwing', async () => {
    // Existence checks belong at the MCP / HTTP boundary; the store
    // path is the low-level write that auto-add hooks call from the
    // chat hot path. A stale id (gezel was deleted between task
    // creation and the auto-add fire) shouldn't crash the loop.
    await store.createProject({ name: 'RosterProj' });
    const result = await store.addGezelToProject('rosterproj', 'ghost');
    expect(result.added).toBe(true);
    const project = await store.getProject('rosterproj');
    expect(project!.gezelIds).toContain('ghost');
  });

  it('addGezelToProject is a no-op when the project does not exist', async () => {
    const result = await store.addGezelToProject('no-such-project', 'maya');
    expect(result.added).toBe(false);
  });

  it('removeGezelFromProject drops the entry idempotently', async () => {
    await store.createProject({ name: 'RosterProj' });
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    await store.addGezelToProject('rosterproj', 'maya');
    const first = await store.removeGezelFromProject('rosterproj', 'maya');
    const second = await store.removeGezelFromProject('rosterproj', 'maya');
    expect(first.removed).toBe(true);
    expect(second.removed).toBe(false);
    const project = await store.getProject('rosterproj');
    expect(project!.gezelIds).toEqual([]);
  });

  it('updateProject auto-adds the new voorman to the roster', async () => {
    await store.createProject({ name: 'RosterProj' });
    await store.createGezel({ name: 'Leo', role: 'Voorman' });
    await store.updateProject('rosterproj', { voormanGezelId: 'leo' });
    const project = await store.getProject('rosterproj');
    expect(project!.voormanGezelId).toBe('leo');
    expect(project!.gezelIds).toContain('leo');
  });

  it('updateProject does NOT add anyone when voormanGezelId is cleared', async () => {
    await store.createProject({ name: 'RosterProj' });
    await store.createGezel({ name: 'Leo', role: 'Voorman' });
    await store.updateProject('rosterproj', { voormanGezelId: 'leo' });
    await store.updateProject('rosterproj', { voormanGezelId: null });
    const project = await store.getProject('rosterproj');
    expect(project!.voormanGezelId).toBeUndefined();
    // Leo stays on the roster — the voorman pointer cleared, but the
    // roster is purely additive on the auto-add side; explicit removal
    // is the only way out.
    expect(project!.gezelIds).toContain('leo');
  });
});

describe('project artifacts', () => {
  it('writes, reads, lists, and deletes artifacts', async () => {
    await store.createProject({ name: 'ArtTest' });
    await store.writeProjectArtifact('arttest', 'report.md', '# Report\n\nDone.');
    const content = await store.readProjectArtifact('arttest', 'report.md');
    expect(content).toContain('# Report');

    const files = await store.listProjectArtifacts('arttest');
    expect(files.find((f) => f.name === 'report.md')).toBeTruthy();

    await store.deleteProjectArtifact('arttest', 'report.md');
    expect(await store.readProjectArtifact('arttest', 'report.md')).toBeNull();
  });

  it('blocks path traversal', async () => {
    await store.createProject({ name: 'Traverse' });
    await expect(
      store.writeProjectArtifact('traverse', '../../etc/passwd', 'hacked'),
    ).rejects.toThrow('traversal');
  });

  it('reports byte size for a file, and null for directories, misses, and escapes', async () => {
    await store.createProject({ name: 'SizeTest' });
    // Multi-byte on purpose: the viewer needs on-disk bytes, not string length.
    await store.writeProjectArtifact('sizetest', 'sub/report.md', 'héllo');

    expect(await store.projectArtifactSize('sizetest', 'sub/report.md')).toBe(6);
    expect(await store.projectArtifactSize('sizetest', 'sub')).toBeNull();
    expect(await store.projectArtifactSize('sizetest', 'missing.md')).toBeNull();
    expect(await store.projectArtifactSize('sizetest', '../../etc/passwd')).toBeNull();
  });

  it('keeps connector corpora read-only to gezels without blocking user edits', async () => {
    await store.createProject({ name: 'ConnectorArtifacts' });
    await expect(
      store.writeProjectArtifact(
        'connectorartifacts',
        'data/work-mail/inbox/001--hello--deadbeef.md',
        'tampered',
        { initiatedByGezel: true },
      ),
    ).rejects.toMatchObject({ code: 'connector-corpus-readonly' });
    await expect(
      store.writeProjectArtifact(
        'connectorartifacts',
        'data/work-mail/_actions/_drafts/action.md',
        'draft',
        { initiatedByGezel: true },
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.writeProjectArtifact(
        'connectorartifacts',
        'data/work-mail/inbox/001--hello--deadbeef.md',
        'user correction',
      ),
    ).resolves.toBeUndefined();
  });

  it('denies every write into the reserved artifacts/shadow cache but allows reads and deletes', async () => {
    await store.createProject({ name: 'ShadowArtifacts' });
    await expect(
      store.writeProjectArtifact('shadowartifacts', 'shadow/docs/spec.docx_files/spec.md', 'x', {
        initiatedByGezel: true,
      }),
    ).rejects.toMatchObject({ code: 'shadow-readonly' });
    // Unconditional: user-initiated and prefix/traversal variants are equally denied.
    await expect(
      store.writeProjectArtifact('shadowartifacts', 'artifacts/shadow/note.md', 'x'),
    ).rejects.toMatchObject({ code: 'shadow-readonly' });
    await expect(
      store.writeProjectArtifactBinary(
        'shadowartifacts',
        'docs/../shadow/note.md',
        Buffer.from('x'),
      ),
    ).rejects.toMatchObject({ code: 'shadow-readonly' });
    // The cache is deletable (it self-heals on the next index pass).
    await expect(store.deleteProjectArtifact('shadowartifacts', 'shadow')).resolves.toBeUndefined();
  });

  it('hides the shadow tree from listings and fuzzy resolve but serves explicit reads', async () => {
    await store.createProject({ name: 'ShadowList' });
    const artifactsDir = store.projectArtifactsDir('shadowlist');
    const companion = join(artifactsDir, 'shadow', 'docs', 'spec.docx_files');
    await mkdir(companion, { recursive: true });
    await writeFile(join(companion, 'spec.md'), '# Converted');
    await store.writeProjectArtifact('shadowlist', 'report.md', '# Report');

    const rootListing = await store.listProjectArtifacts('shadowlist');
    expect(rootListing.some((e) => e.name === 'shadow')).toBe(false);
    const recursive = await store.listProjectArtifactsRecursive('shadowlist');
    expect(recursive.some((e) => e.path.startsWith('shadow'))).toBe(false);

    // Fuzzy basename resolve must not surface shadow twins…
    const fuzzy = await store.resolveProjectArtifact('shadowlist', 'spec.md');
    expect(fuzzy.kind).toBe('missing');
    // …while an explicit path read still works.
    const explicit = await store.readProjectArtifact(
      'shadowlist',
      'shadow/docs/spec.docx_files/spec.md',
    );
    expect(explicit).toContain('# Converted');
  });

  it('strips redundant artifacts/ prefix on write so files do not nest', async () => {
    await store.createProject({ name: 'Prefix' });
    await store.writeProjectArtifact('prefix', 'artifacts/report.md', 'x');
    await store.writeProjectArtifact('prefix', 'artifacts/artifacts/deep.md', 'y');
    const files = await store.listProjectArtifactsRecursive('prefix');
    const paths = files
      .filter((f) => !f.isDirectory)
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(['deep.md', 'report.md']);
  });

  it('scopes a recursive artifact walk to subpath and keeps paths root-relative', async () => {
    await store.createProject({ name: 'ScopedWalk' });
    await store.writeProjectArtifact('scopedwalk', 'data/pulls/pr-1/files/a.md', 'a');
    await store.writeProjectArtifact('scopedwalk', 'data/pulls/pr-1/files/b.md', 'b');
    await store.writeProjectArtifact('scopedwalk', 'data/pulls/pr-2/files/c.md', 'c');
    await store.writeProjectArtifact('scopedwalk', 'notes/unrelated.md', 'n');

    const scoped = await store.listProjectArtifactsRecursive('scopedwalk', {
      subpath: 'data/pulls/pr-1',
    });
    const paths = scoped
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['data/pulls/pr-1/files/a.md', 'data/pulls/pr-1/files/b.md']);
    // Root-relative paths are directly readable — the whole point of scoping.
    expect(await store.readProjectArtifact('scopedwalk', paths[0]!)).toBe('a');

    // The redundant prefix is tolerated here exactly as it is on read/write.
    const prefixed = await store.listProjectArtifactsRecursive('scopedwalk', {
      subpath: 'artifacts/data/pulls/pr-1/',
    });
    expect(prefixed.filter((entry) => !entry.isDirectory)).toHaveLength(2);

    // An escaping subpath yields nothing rather than climbing out of the drawer.
    expect(
      await store.listProjectArtifactsRecursive('scopedwalk', { subpath: '../../etc' }),
    ).toEqual([]);
  });

  it('scopes a recursive workspace walk to subpath, matching the artifacts twin', async () => {
    await store.createProject({ name: 'ScopedWs' });
    await store.writeProjectWorkspaceFile('scopedws', 'src/deep/a.ts', 'a');
    await store.writeProjectWorkspaceFile('scopedws', 'src/deep/b.ts', 'b');
    await store.writeProjectWorkspaceFile('scopedws', 'docs/readme.md', 'r');

    const scoped = await store.listProjectWorkspaceRecursive('scopedws', { subpath: 'src' });
    const paths = scoped
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path)
      .sort();
    expect(paths).toEqual(['src/deep/a.ts', 'src/deep/b.ts']);
    expect(await store.readProjectWorkspaceFile('scopedws', paths[0]!)).toBe('a');
    expect(await store.listProjectWorkspaceRecursive('scopedws', { subpath: '../..' })).toEqual([]);
  });

  it('resolveProjectArtifact returns exact match when path hits', async () => {
    await store.createProject({ name: 'Resolve1' });
    await store.writeProjectArtifact('resolve1', 'reports/summary.md', 'hello');
    const res = await store.resolveProjectArtifact('resolve1', 'reports/summary.md');
    expect(res.kind).toBe('found');
    if (res.kind === 'found') {
      expect(res.fuzzy).toBe(false);
      expect(res.path).toBe('reports/summary.md');
      expect(res.content).toBe('hello');
    }
  });

  it('resolveProjectArtifact falls back to basename match when exact misses', async () => {
    await store.createProject({ name: 'Resolve2' });
    await store.writeProjectArtifact('resolve2', 'reports/ux_spec.md', 'spec body');
    const res = await store.resolveProjectArtifact('resolve2', 'ux_spec.md');
    expect(res.kind).toBe('found');
    if (res.kind === 'found') {
      expect(res.fuzzy).toBe(true);
      expect(res.path).toBe('reports/ux_spec.md');
      expect(res.content).toBe('spec body');
    }
  });

  it('resolveProjectArtifact basename match is case-insensitive', async () => {
    // Write at a nested path so the exact-match attempt genuinely misses
    // on case-sensitive filesystems (Linux CI) — on case-insensitive
    // filesystems (macOS/Windows) exact resolves directly. Either way,
    // content should come back.
    await store.createProject({ name: 'Resolve3' });
    await store.writeProjectArtifact('resolve3', 'nested/design_brief.md', 'brief');
    const res = await store.resolveProjectArtifact('resolve3', 'DESIGN_BRIEF.md');
    expect(res.kind).toBe('found');
    if (res.kind === 'found') {
      expect(res.content).toBe('brief');
      expect(res.fuzzy).toBe(true);
    }
  });

  it('resolveProjectArtifact returns ambiguous when multiple files share a basename', async () => {
    await store.createProject({ name: 'Resolve4' });
    await store.writeProjectArtifact('resolve4', 'a/notes.md', '1');
    await store.writeProjectArtifact('resolve4', 'b/notes.md', '2');
    const res = await store.resolveProjectArtifact('resolve4', 'notes.md');
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates.sort()).toEqual(['a/notes.md', 'b/notes.md']);
    }
  });

  it('resolveProjectArtifact returns missing when no match', async () => {
    await store.createProject({ name: 'Resolve5' });
    const res = await store.resolveProjectArtifact('resolve5', 'nope.md');
    expect(res.kind).toBe('missing');
  });

  it('resolveProjectArtifact rescues already-nested artifacts/artifacts/ files', async () => {
    await store.createProject({ name: 'Rescue' });
    // Simulate the broken state: write directly to the bare path
    // (bypassing normalization) the way older code left files behind.
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const broken = join(store.projectArtifactsDir('rescue'), 'artifacts');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'design_brief.md'), 'legacy', 'utf8');
    const res = await store.resolveProjectArtifact('rescue', 'artifacts/design_brief.md');
    expect(res.kind).toBe('found');
    if (res.kind === 'found') {
      expect(res.content).toBe('legacy');
    }
  });
});

describe('project workspace', () => {
  it('uses a suffixed id instead of overwriting an existing project with the same name', async () => {
    const first = await store.createProject({
      name: 'Same Name',
      github: { url: 'https://github.com/example/first' },
    });
    const second = await store.createProject({ name: 'Same Name' });

    expect(first.id).toBe('same-name');
    expect(second.id).toBe('same-name-2');
    expect((await store.getProject(first.id))?.github?.url).toBe(
      'https://github.com/example/first',
    );
    expect((await store.getProject(second.id))?.github).toBeUndefined();
  });

  it('uses internal workspace when no workingDir set', async () => {
    await store.createProject({ name: 'Internal' });
    const dir = await store.projectWorkspaceDir('internal');
    expect(dir).toContain('workspace');
  });

  it('uses external dir when workingDir is set', async () => {
    await store.createProject({ name: 'Ext', workingDir: '/tmp' });
    const dir = await store.projectWorkspaceDir('ext');
    expect(dir).toBe('/tmp');
  });

  it('listProjectWorkspaceRecursiveDetailed forwards withStats to the walker', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await store.createProject({ name: 'Stats' });
    const dir = await store.projectWorkspaceDir('stats');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'file.txt'), 'x');

    const plain = await store.listProjectWorkspaceRecursiveDetailed('stats');
    expect(plain.entries.every((e) => e.mtimeMs === undefined)).toBe(true);

    const detailed = await store.listProjectWorkspaceRecursiveDetailed('stats', {
      withStats: true,
    });
    const file = detailed.entries.find((e) => e.path === 'sub/file.txt');
    const folder = detailed.entries.find((e) => e.path === 'sub');
    expect(file?.mtimeMs).toBeTypeOf('number');
    expect(folder?.mtimeMs).toBeUndefined();
  });

  it('points at github.checkoutDir when github-linked and clone has landed', async () => {
    // Simulate a github-linked project whose clone has populated.
    await store.createProject({ name: 'Cloned', github: { url: 'https://github.com/foo/bar' } });
    await store.updateProjectGitHub('cloned', {
      url: 'https://github.com/foo/bar',
      checkoutDir: '/var/tmp/my-clone',
    });
    const dir = await store.projectWorkspaceDir('cloned');
    expect(dir).toBe('/var/tmp/my-clone');
  });

  it('skips workspace bootstrap when project is created with github url', async () => {
    const { existsSync } = await import('node:fs');
    await store.createProject({
      name: 'NoBootstrap',
      github: { url: 'https://github.com/foo/bar' },
    });
    const wsPath = join(home, 'projects', 'nobootstrap', 'workspace');
    // The dir is created (mkdir on line ~986) but the bootstrap files
    // must NOT be seeded — they'd be the user's mystery "two files".
    expect(existsSync(join(wsPath, 'package.json'))).toBe(false);
    expect(existsSync(join(wsPath, 'tsconfig.json'))).toBe(false);
  });

  it('seeds bootstrap files for non-github projects with no workingDir (regression guard)', async () => {
    const { existsSync } = await import('node:fs');
    await store.createProject({ name: 'WithBootstrap' });
    const wsPath = join(home, 'projects', 'withbootstrap', 'workspace');
    expect(existsSync(join(wsPath, 'package.json'))).toBe(true);
  });

  // Read/write path parity. Phase 1 of the workspace-fs unification:
  // `projectWorkspaceDir` and `assertWorkspaceWritable` must resolve to
  // the SAME directory under every shape. The pre-refactor divergence
  // (reads hit github.checkoutDir, writes fell back to internal workspace)
  // caused writeFile to silently land in a different place than stat
  // looked, which destroyed Ainhoa's squisq review.
  describe('read/write path parity', () => {
    it('agree on internal projects (no workingDir, no github)', async () => {
      await store.createProject({ name: 'PInternal' });
      const readDir = await store.projectWorkspaceDir('pinternal');
      const writeGate = await store.assertWorkspaceWritable('pinternal');
      expect(writeGate.ok).toBe(true);
      if (writeGate.ok) expect(writeGate.workspaceDir).toBe(readDir);
    });

    it('agree on github-linked-no-workingDir projects (the squisq bug case)', async () => {
      await store.createProject({
        name: 'PCloned',
        github: { url: 'https://github.com/foo/bar' },
      });
      // Simulate the clone landing — this is what GitManager.persistCheckoutDir
      // does after `git clone` succeeds.
      await store.updateProjectGitHub('pcloned', {
        url: 'https://github.com/foo/bar',
        checkoutDir: '/var/tmp/cloned-repo',
      });
      const readDir = await store.projectWorkspaceDir('pcloned');
      const writeGate = await store.assertWorkspaceWritable('pcloned');
      expect(readDir).toBe('/var/tmp/cloned-repo');
      expect(writeGate.ok).toBe(true);
      if (writeGate.ok) {
        // Pre-refactor this would have been the internal workspace dir.
        // The whole point of Phase 1 is this assertion holds.
        expect(writeGate.workspaceDir).toBe(readDir);
      }
    });

    it('agrees on external workingDir + writes denied without managed-write consent', async () => {
      await store.createProject({ name: 'PExternal', workingDir: '/tmp/some-user-folder' });
      const readDir = await store.projectWorkspaceDir('pexternal');
      const writeGate = await store.assertWorkspaceWritable('pexternal');
      expect(readDir).toBe('/tmp/some-user-folder');
      expect(writeGate.ok).toBe(false);
      if (!writeGate.ok) {
        expect(writeGate.reason).toBe('external-consent-required');
        // The denial still names the same directory the reader sees, so
        // the model can give the user actionable "enable managed writes
        // on /tmp/some-user-folder" guidance.
        expect(writeGate.workingDir).toBe(readDir);
      }
    });

    it('agrees on external workingDir with managed writes allowed', async () => {
      await store.createProject({
        name: 'PExternalAllow',
        workingDir: '/tmp/blessed-folder',
      });
      await store.updateProject('pexternalallow', { managedWorkspaceWritePolicy: 'allow' });
      const readDir = await store.projectWorkspaceDir('pexternalallow');
      const writeGate = await store.assertWorkspaceWritable('pexternalallow');
      expect(writeGate.ok).toBe(true);
      if (writeGate.ok) {
        expect(writeGate.workspaceDir).toBe(readDir);
        expect(writeGate.external).toBe(true);
      }
    });

    it('denies gezel-initiated writes on an internal workspace with managed writes denied', async () => {
      await store.createProject({ name: 'PInternalOff' });
      await store.updateProject('pinternaloff', { managedWorkspaceWritePolicy: 'deny' });
      const gate = await store.assertWorkspaceWritable('pinternaloff', {
        initiatedByGezel: true,
      });
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.reason).toBe('disabled-by-project');
      // App-internal / user-initiated writes stay exempt — the flag is a
      // gezel switch, not a filesystem lock.
      const userGate = await store.assertWorkspaceWritable('pinternaloff');
      expect(userGate.ok).toBe(true);
    });

    it('translates the legacy boolean update into the named policy', async () => {
      await store.createProject({ name: 'PLegacyWriteFlag' });
      const updated = await store.updateProject('plegacywriteflag', { allowGezelWrites: false });
      expect(updated.managedWorkspaceWritePolicy).toBe('deny');
      expect(updated.allowGezelWrites).toBeUndefined();
    });

    it('persists project-level Claude CLI permission posture', async () => {
      await store.createProject({ name: 'PClaudeAccess' });
      const updated = await store.updateProject('pclaudeaccess', {
        claudePermissionMode: 'plan',
      });
      expect(updated.claudePermissionMode).toBe('plan');
      expect((await store.getProject('pclaudeaccess'))?.claudePermissionMode).toBe('plan');
    });

    it('internal workspaces stay writable for gezels by default', async () => {
      await store.createProject({ name: 'PInternalDefault' });
      const gate = await store.assertWorkspaceWritable('pinternaldefault', {
        initiatedByGezel: true,
      });
      expect(gate.ok).toBe(true);
    });
  });

  it('does not reserve data/ inside the workspace for connector corpora', async () => {
    await store.createProject({ name: 'PData' });
    await expect(
      store.writeProjectWorkspaceFile('pdata', 'data/app-state.json', '{}', { gezelId: 'g1' }),
    ).resolves.toBeUndefined();
  });

  // Phase 2 one-shot migration: existing projects with a legacy `gh/`
  // checkout get the clone moved into the workspace dir. We simulate
  // the legacy state by hand (no real git involved — just the on-disk
  // shape + project metadata that pre-Phase-2 code would have
  // produced) and assert the post-migration shape.
  describe('legacy gh/ migration', () => {
    it('moves gh/ contents into workspace/ and updates checkoutDir', async () => {
      const { existsSync } = await import('node:fs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      // Build a project in the legacy shape: github-linked with
      // checkoutDir pointing at the (still-existing) gh/ sibling.
      await store.createProject({
        name: 'LegacyClone',
        github: { url: 'https://github.com/foo/bar' },
      });
      const projectDir = join(home, 'projects', 'legacyclone');
      const legacyGh = join(projectDir, 'gh');
      const workspaceDir = join(projectDir, 'workspace');
      await mkdir(legacyGh, { recursive: true });
      await writeFile(join(legacyGh, 'README.md'), '# legacy repo\n', 'utf8');
      await mkdir(join(legacyGh, 'src'), { recursive: true });
      await writeFile(join(legacyGh, 'src', 'index.ts'), 'export {};\n', 'utf8');
      // Set checkoutDir to the legacy location to mimic the pre-Phase-2
      // ensureClone outcome.
      await store.updateProjectGitHub('legacyclone', {
        url: 'https://github.com/foo/bar',
        checkoutDir: legacyGh,
      });
      // Pre-condition: gh/ has content, workspace/ has bootstrap files only
      // (or doesn't exist — createProject with github skipped bootstrap).
      expect(existsSync(join(legacyGh, 'README.md'))).toBe(true);

      // Re-run ensureLayout to trigger the migration.
      await store.ensureLayout();

      // Post-condition: gh/ is gone, workspace/ has the cloned content,
      // checkoutDir now points at workspace.
      expect(existsSync(legacyGh)).toBe(false);
      expect(existsSync(join(workspaceDir, 'README.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'src', 'index.ts'))).toBe(true);
      const migrated = await store.getProject('legacyclone');
      expect(migrated?.github?.checkoutDir).toBe(workspaceDir);
    });

    it('skips migration when workspace has user content', async () => {
      const { existsSync } = await import('node:fs');
      const { writeFile, mkdir } = await import('node:fs/promises');
      await store.createProject({
        name: 'LegacyCloneUserContent',
        github: { url: 'https://github.com/foo/bar' },
      });
      const projectDir = join(home, 'projects', 'legacycloneusercontent');
      const legacyGh = join(projectDir, 'gh');
      const workspaceDir = join(projectDir, 'workspace');
      await mkdir(legacyGh, { recursive: true });
      await writeFile(join(legacyGh, 'README.md'), 'repo readme\n', 'utf8');
      // Seed user content in workspace beyond bootstrap files — should
      // block the migration to avoid data loss.
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, 'my-notes.md'), 'user wrote this\n', 'utf8');
      await store.updateProjectGitHub('legacycloneusercontent', {
        url: 'https://github.com/foo/bar',
        checkoutDir: legacyGh,
      });
      await store.ensureLayout();
      // Migration should NOT have moved gh/ → workspace/. Both still exist.
      expect(existsSync(join(legacyGh, 'README.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'my-notes.md'))).toBe(true);
      const unmigrated = await store.getProject('legacycloneusercontent');
      expect(unmigrated?.github?.checkoutDir).toBe(legacyGh);
    });
  });
});

describe('memories', () => {
  it('appends and reads daily memories', async () => {
    await store.createGezel({ name: 'MemBot' });
    await store.appendMemory('gezel', 'membot', 'User likes bullet points.');
    await store.appendMemory('gezel', 'membot', 'Project uses TypeScript.');

    const today = new Date().toISOString().slice(0, 10);
    const days = await store.listMemoryDays('gezel', 'membot');
    expect(days).toContain(today);

    const content = await store.readMemoryDay('gezel', 'membot', today);
    expect(content).toContain('bullet points');
    expect(content).toContain('TypeScript');
    // New appends always carry the kind suffix (default 'fact').
    expect(content).toMatch(/^## \d{2}:\d{2} \[fact\]$/m);
  });

  it('appends with an explicit kind suffix', async () => {
    await store.createGezel({ name: 'MemBot3' });
    await store.appendMemory('gezel', 'membot3', 'User prefers terse replies.', 'pref');
    const today = new Date().toISOString().slice(0, 10);
    const content = await store.readMemoryDay('gezel', 'membot3', today);
    expect(content).toMatch(/^## \d{2}:\d{2} \[pref\]$/m);
  });

  it('reads recent memories across days', async () => {
    await store.createGezel({ name: 'MemBot2' });
    await store.appendMemory('gezel', 'membot2', 'Fact one.');
    const recent = await store.readRecentMemories('gezel', 'membot2', 7);
    expect(recent).toContain('Fact one.');
  });

  it('growth.json round-trips and defaults to level 1', async () => {
    await store.createGezel({ name: 'Grower' });
    const fresh = await store.readGezelGrowth('grower');
    expect(fresh.level).toBe(1);
    expect(fresh.xp).toBe(0);

    await store.writeGezelGrowth('grower', {
      ...fresh,
      level: 3,
      xp: 400,
      signals: { memoryXp: 300, lessonsXp: 30, taskXp: 60, consultXp: 10 },
    });
    const read = await store.readGezelGrowth('grower');
    expect(read.level).toBe(3);
    expect(read.xp).toBe(400);

    // Summary inlines the lightweight growth chip.
    const detail = await store.getGezel('grower');
    expect(detail?.growth).toEqual({ level: 3 });
  });

  it('quarantines a corrupt growth.json and recovers defaults', async () => {
    await store.createGezel({ name: 'Corrupt' });
    const { writeFile: wf, mkdir: md, readdir: rd } = await import('node:fs/promises');
    const { dirname: dn, join: jn } = await import('node:path');
    const path = jn(home, 'gezels', 'corrupt', 'growth.json');
    await md(dn(path), { recursive: true });
    await wf(path, 'not json at all', 'utf8');
    const state = await store.readGezelGrowth('corrupt');
    expect(state.level).toBe(1);
    const files = await rd(dn(path));
    expect(files.some((f) => f.startsWith('growth.json.corrupt-'))).toBe(true);
  });

  it('quarantines an unparseable session file so scans stop re-reading it', async () => {
    await store.createGezel({ name: 'Sessioneer' });
    const { writeFile: wf, mkdir: md, readdir: rd } = await import('node:fs/promises');
    const { join: jn } = await import('node:path');
    const dir = jn(home, 'gezels', 'sessioneer', 'sessions');
    await md(dir, { recursive: true });
    // The all-NUL artifact a pre-atomic-write crash leaves behind.
    await wf(jn(dir, 'dead.json'), Buffer.alloc(64, 0));

    // First scan skips the corrupt file and quarantines it.
    const first = await store.listSessions({ gezelId: 'sessioneer' });
    expect(first).toEqual([]);
    let files = await rd(dir);
    expect(files).not.toContain('dead.json');
    expect(files.some((f) => f.startsWith('dead.json.corrupt-'))).toBe(true);

    // Second scan no longer sees a `.json` to re-read, so no new quarantine.
    const before = files.filter((f) => f.startsWith('dead.json.corrupt-')).length;
    await store.listSessions({ gezelId: 'sessioneer' });
    files = await rd(dir);
    expect(files.filter((f) => f.startsWith('dead.json.corrupt-')).length).toBe(before);
  });

  it('adds and removes traits with slot-cap and duplicate guards', async () => {
    await store.createGezel({ name: 'Traity' });
    const detail = await store.addGezelTrait('traity', {
      id: 'trait-1',
      text: 'Write failing tests before implementation.',
      adoptedAt: '2026-06-11T00:00:00Z',
      source: 'levelup',
    });
    expect(detail.parsed.frontmatter.traits).toHaveLength(1);
    expect(detail.traits?.[0]?.text).toContain('failing tests');

    await expect(
      store.addGezelTrait('traity', {
        id: 'trait-2',
        text: '  write FAILING tests before implementation.  ',
        adoptedAt: '2026-06-11T00:00:00Z',
      }),
    ).rejects.toThrow(/equivalent trait/);

    const after = await store.removeGezelTrait('traity', 'trait-1');
    expect(after.parsed.frontmatter.traits).toBeUndefined();

    await expect(store.removeGezelTrait('traity', 'trait-1')).rejects.toThrow(/no trait/);
  });

  it('enforces the 8-trait slot cap', async () => {
    await store.createGezel({ name: 'Full' });
    for (let i = 0; i < 8; i++) {
      await store.addGezelTrait('full', {
        id: `trait-${i}`,
        text: `Distinct standing behavior number ${i}.`,
        adoptedAt: '2026-06-11T00:00:00Z',
      });
    }
    await expect(
      store.addGezelTrait('full', {
        id: 'trait-9',
        text: 'One trait too many.',
        adoptedAt: '2026-06-11T00:00:00Z',
      }),
    ).rejects.toThrow(/8 traits/);
  });

  it('reads a legacy summary.md left on disk', async () => {
    await store.createGezel({ name: 'SumBot' });
    // Nothing writes summary.md anymore; simulate a legacy file.
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    const { dirname: dn } = await import('node:path');
    const path = store.memorySummaryPath('gezel', 'sumbot');
    await md(dn(path), { recursive: true });
    await wf(path, '# Summary\n\nConsolidated facts.', 'utf8');
    const summary = await store.readMemorySummary('gezel', 'sumbot');
    expect(summary).toContain('Consolidated facts');
  });
});

describe('project tasks storage', () => {
  it('allocates monotonic per-project task nums', async () => {
    await store.createProject({ name: 'Alpha' });
    const a1 = await store.nextProjectTaskNum('alpha');
    const a2 = await store.nextProjectTaskNum('alpha');
    expect(a1).toBe(1);
    expect(a2).toBe(2);
    // Concurrent allocations never collide.
    const batch = await Promise.all(
      Array.from({ length: 10 }, () => store.nextProjectTaskNum('alpha')),
    );
    expect(new Set(batch).size).toBe(10);
  });

  it('nums are per-project', async () => {
    await store.createProject({ name: 'Alpha' });
    await store.createProject({ name: 'Beta' });
    const a = await store.nextProjectTaskNum('alpha');
    const b = await store.nextProjectTaskNum('beta');
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('writeTask / readTask / listProjectTasks round-trip', async () => {
    await store.createProject({ name: 'Alpha' });
    const task = {
      projectId: 'alpha',
      num: 1,
      ref: 'alpha/1',
      title: 'First',
      status: 'active' as const,
      assignee: { kind: 'user' as const },
      craftbook: {
        id: 'cb-1',
        name: 'cb',
        steps: [{ id: 'p1', name: 'Phase 1', createdAt: '2026-04-14T00:00:00Z' }],
        entryStepId: 'p1',
        createdAt: '2026-04-14T00:00:00Z',
        updatedAt: '2026-04-14T00:00:00Z',
      },
      activeStepId: 'p1',
      createdAt: '2026-04-14T00:00:00Z',
      updatedAt: '2026-04-14T00:00:00Z',
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask(task);
    const got = await store.readTask('alpha', 1);
    expect(got?.title).toBe('First');
    const list = await store.listProjectTasks('alpha');
    expect(list).toHaveLength(1);
  });

  it('writes a role-based default about prompt without self identity metadata', async () => {
    const created = await store.createGezel({ name: 'Wren', role: 'Developer', gender: 'male' });

    expect(created.about).toContain('for the "Developer" role');
    expect(created.about).not.toContain('Wren');
    expect(created.about).not.toMatch(/\b(?:he|him|his)\b/i);
  });

  it('readTask migrates a legacy phases/activePhaseId task to craftbook', async () => {
    await store.createProject({ name: 'Alpha' });
    // Task shape from before the `phases` → `craftbook` rename.
    const legacy = {
      projectId: 'alpha',
      num: 1,
      ref: 'alpha/1',
      title: 'Legacy task',
      status: 'complete',
      assignee: { kind: 'gezel', gezelId: 'leo' },
      phases: [
        {
          id: 'core',
          name: 'Core',
          createdAt: '2026-04-20T02:55:33.311Z',
          description: 'Build it',
          suggestedGezelId: 'leo',
          completedAt: '2026-04-20T03:12:26.400Z',
        },
        {
          id: 'polish',
          name: 'Polish',
          createdAt: '2026-04-20T02:55:33.311Z',
          completedAt: '2026-04-20T03:12:47.484Z',
        },
      ],
      activePhaseId: 'polish',
      createdAt: '2026-04-20T02:55:33.311Z',
      updatedAt: '2026-04-20T03:12:54.355Z',
      createdBy: { kind: 'user' },
    };
    const dir = join(home, 'projects', 'alpha', 'tasks', '1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'task.json'), JSON.stringify(legacy, null, 2));

    const got = await store.readTask('alpha', 1);
    expect(got).not.toBeNull();
    // The migrated task validates against the current schema...
    expect(TaskSchema.safeParse(got).success).toBe(true);
    // ...with phases mapped onto a linear craftbook and the active
    // phase carried over as the active step.
    expect(got?.craftbook.steps.map((s) => s.id)).toEqual(['core', 'polish']);
    expect(got?.craftbook.entryStepId).toBe('core');
    expect(got?.craftbook.steps[0]?.next).toBe('polish');
    expect(got?.craftbook.steps[1]?.terminal).toBe(true);
    expect(got?.craftbook.steps[0]?.completedAt).toBe('2026-04-20T03:12:26.400Z');
    expect(got?.activeStepId).toBe('polish');
    // Legacy keys are dropped from the returned object.
    expect((got as Record<string, unknown>).phases).toBeUndefined();
    expect((got as Record<string, unknown>).activePhaseId).toBeUndefined();
  });

  it('writeTask stores description in about.md, not task.json', async () => {
    await store.createProject({ name: 'Alpha' });
    const task = {
      projectId: 'alpha',
      num: 1,
      ref: 'alpha/1',
      title: 'First',
      description: '# Why\n\nThis explains the purpose.',
      status: 'active' as const,
      assignee: { kind: 'user' as const },
      craftbook: {
        id: 'cb-1',
        name: 'cb',
        steps: [{ id: 'p1', name: 'Phase 1', createdAt: '2026-04-14T00:00:00Z' }],
        entryStepId: 'p1',
        createdAt: '2026-04-14T00:00:00Z',
        updatedAt: '2026-04-14T00:00:00Z',
      },
      activeStepId: 'p1',
      createdAt: '2026-04-14T00:00:00Z',
      updatedAt: '2026-04-14T00:00:00Z',
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask(task);

    const onDiskJson = JSON.parse(
      await readFile(join(home, 'projects', 'alpha', 'tasks', '1', 'task.json'), 'utf8'),
    );
    expect(onDiskJson.description).toBeUndefined();

    const aboutMd = await readFile(
      join(home, 'projects', 'alpha', 'tasks', '1', 'about.md'),
      'utf8',
    );
    expect(aboutMd).toBe('# Why\n\nThis explains the purpose.');

    const got = await store.readTask('alpha', 1);
    expect(got?.description).toBe('# Why\n\nThis explains the purpose.');
  });

  it('writeTask deletes about.md when description cleared', async () => {
    await store.createProject({ name: 'Alpha' });
    const base = {
      projectId: 'alpha',
      num: 1,
      ref: 'alpha/1',
      title: 'First',
      status: 'active' as const,
      assignee: { kind: 'user' as const },
      craftbook: {
        id: 'cb-1',
        name: 'cb',
        steps: [{ id: 'p1', name: 'Phase 1', createdAt: '2026-04-14T00:00:00Z' }],
        entryStepId: 'p1',
        createdAt: '2026-04-14T00:00:00Z',
        updatedAt: '2026-04-14T00:00:00Z',
      },
      activeStepId: 'p1',
      createdAt: '2026-04-14T00:00:00Z',
      updatedAt: '2026-04-14T00:00:00Z',
      createdBy: { kind: 'user' as const },
    };
    await store.writeTask({ ...base, description: 'first version' });
    await store.writeTask({ ...base, description: '' });

    const got = await store.readTask('alpha', 1);
    expect(got?.description).toBeUndefined();

    // Only a missing file is ignorable. A real filesystem failure must reach
    // the caller instead of reporting a successful clear that later reappears.
    await mkdir(join(home, 'projects', 'alpha', 'tasks', '1', 'about.md'));
    await expect(store.writeTask(base)).rejects.toBeDefined();
  });

  it('notes append/list/delete with phase filter', async () => {
    await store.createProject({ name: 'Alpha' });
    expect(await store.listTaskNotes('alpha', 1)).toEqual([]);
    const noteA = {
      id: 'a',
      at: '2026-04-29T10:00:00.000Z',
      author: { kind: 'user' as const },
      text: 'first',
    };
    const noteB = {
      id: 'b',
      at: '2026-04-29T11:00:00.000Z',
      author: { kind: 'gezel' as const, gezelId: 'mara', name: 'Mara' },
      stepId: 'design',
      text: 'design scratch',
    };
    const noteC = {
      id: 'c',
      at: '2026-04-29T12:00:00.000Z',
      author: { kind: 'user' as const },
      text: 'second',
    };
    await store.appendTaskNote('alpha', 1, noteA);
    await store.appendTaskNote('alpha', 1, noteB);
    await store.appendTaskNote('alpha', 1, noteC);

    const all = await store.listTaskNotes('alpha', 1);
    expect(all.map((n) => n.id)).toEqual(['c', 'b', 'a']);

    const designOnly = await store.listTaskNotes('alpha', 1, 'design');
    expect(designOnly.map((n) => n.id)).toEqual(['b']);

    const removed = await store.deleteTaskNote('alpha', 1, 'b');
    expect(removed?.id).toBe('b');
    expect((await store.listTaskNotes('alpha', 1)).map((n) => n.id)).toEqual(['c', 'a']);

    expect(await store.deleteTaskNote('alpha', 1, 'nonexistent')).toBeNull();
  });

  it('updateTaskNote rewrites text in place and preserves other fields', async () => {
    await store.createProject({ name: 'Alpha' });
    await store.appendTaskNote('alpha', 1, {
      id: 'n1',
      at: '2026-04-29T10:00:00.000Z',
      author: { kind: 'gezel', gezelId: 'mara', name: 'Mara' },
      stepId: 'design',
      text: 'first draft',
    });
    await store.appendTaskNote('alpha', 1, {
      id: 'n2',
      at: '2026-04-29T11:00:00.000Z',
      author: { kind: 'user' },
      text: 'untouched',
    });

    const updated = await store.updateTaskNote('alpha', 1, 'n1', 'final draft');
    expect(updated?.text).toBe('final draft');
    // Surrounding fields stick — id, at, author, phaseId all survive.
    expect(updated?.id).toBe('n1');
    expect(updated?.at).toBe('2026-04-29T10:00:00.000Z');
    expect(updated?.stepId).toBe('design');
    expect(updated?.author).toEqual({ kind: 'gezel', gezelId: 'mara', name: 'Mara' });

    // The other note in the file is unaffected.
    const all = await store.listTaskNotes('alpha', 1);
    expect(all.find((n) => n.id === 'n2')?.text).toBe('untouched');

    // Unknown id → null, no rewrite.
    expect(await store.updateTaskNote('alpha', 1, 'nope', 'x')).toBeNull();
  });
});

describe('store history hooks', () => {
  it('logs gezel.created when HistoryManager is wired', async () => {
    const { HistoryManager } = await import('../history/manager.js');
    const history = new HistoryManager(home);
    const wired = new Store({ home, history });
    await wired.ensureLayout();
    await wired.createGezel({ name: 'Logged', role: 'Tester' });
    const events = await history.listEvents({ kinds: ['gezel.created'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatch(/Logged/);
  });

  it('logs project.created when HistoryManager is wired', async () => {
    const { HistoryManager } = await import('../history/manager.js');
    const history = new HistoryManager(home);
    const wired = new Store({ home, history });
    await wired.ensureLayout();
    const proj = await wired.createProject({ name: 'Proj One' });
    const events = await history.listEvents({ kinds: ['project.created'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.projectId).toBe(proj.id);
  });

  it('persists project nudge overrides and logs them only when changed', async () => {
    const { HistoryManager } = await import('../history/manager.js');
    const history = new HistoryManager(home);
    const wired = new Store({ home, history });
    await wired.ensureLayout();
    const proj = await wired.createProject({ name: 'Ambient Project' });
    const nudgeConfig = { enabled: false, slowIntervalMs: 12 * 60 * 60_000 };

    const updated = await wired.updateProject(proj.id, { nudgeConfig });
    expect(updated.nudgeConfig).toEqual(nudgeConfig);
    expect((await wired.getProject(proj.id))?.nudgeConfig).toEqual(nudgeConfig);

    let events = await history.listEvents({ kinds: ['project.updated'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.details?.changed).toEqual(['nudgeConfig']);

    await wired.updateProject(proj.id, { nudgeConfig: { ...nudgeConfig } });
    events = await history.listEvents({ kinds: ['project.updated'] });
    expect(events).toHaveLength(1);
  });
});

describe('local craftbook templates — inline scripts round-trip', () => {
  const book = (scripts?: Record<string, string>) => ({
    id: 'demo-book',
    name: 'Demo Book',
    version: '1.0.0',
    basedOn: { name: 'Upstream demo', url: 'https://example.com/upstream-demo' },
    steps: [{ id: 'build', name: 'Build', terminal: true }],
    entryStepId: 'build',
    ...(scripts ? { scripts } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('persists the scripts map to scripts/*.ts files and hydrates it back', async () => {
    await store.writeLocalCraftbookTemplate(
      book({
        checkIt: 'export const meta = { name: "checkIt", description: "a demo gate check" };',
      }),
    );
    const file = join(
      home,
      'craftbook-templates',
      'de',
      'demo-book',
      'versions',
      '1.0.0',
      'scripts',
      'checkIt.ts',
    );
    expect(await readFile(file, 'utf8')).toContain('checkIt');
    const loaded = await store.getLocalCraftbookTemplate('demo-book');
    expect(loaded?.scripts?.checkIt).toContain('demo gate check');
    expect(loaded?.basedOn).toEqual({
      name: 'Upstream demo',
      url: 'https://example.com/upstream-demo',
    });
  });

  it('full-replace semantics: names dropped from the map are deleted; undefined leaves the dir alone', async () => {
    await store.writeLocalCraftbookTemplate(
      book({
        a: 'export const meta = { name: "a", description: "script a here" };',
        b: 'export const meta = { name: "b", description: "script b here" };',
      }),
    );
    // Re-save with only `a` → `b.ts` is deleted.
    await store.writeLocalCraftbookTemplate(
      book({ a: 'export const meta = { name: "a", description: "script a v2 here" };' }),
    );
    let loaded = await store.getLocalCraftbookTemplate('demo-book');
    expect(loaded?.scripts && Object.keys(loaded.scripts)).toEqual(['a']);
    expect(loaded?.scripts?.a).toContain('v2');
    // Re-save with no scripts field at all → dir untouched.
    await store.writeLocalCraftbookTemplate(book());
    loaded = await store.getLocalCraftbookTemplate('demo-book');
    expect(loaded?.scripts && Object.keys(loaded.scripts)).toEqual(['a']);
  });
});
