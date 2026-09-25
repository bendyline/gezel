import { describe, expect, it } from 'vitest';
import { initialPoppetjeForGezel, poppetjeFromSeed } from '../poppetje/seed.js';
import { isSharedLibraryProject } from '../shared-project.js';
import { pickRoleBasedName, slugifyEntityName } from './entities.js';
import {
  type PortableFileEntry,
  type PortableFileSystem,
  decodeText,
  encodeText,
  validatePortablePath,
} from './files.js';
import { MEESTER_ABOUT_MD } from './meester.js';
import { PortableStore } from './store.js';

/** Strict port: unlike permissive mocks, directory reads and absent lists fail. */
class MemoryFiles implements PortableFileSystem {
  readonly entries = new Map<string, Uint8Array | null>([['', null]]);
  fault: ((operation: string, path: string) => boolean) | undefined;
  private check(op: string, path: string) {
    validatePortablePath(path, op === 'list' || op === 'mkdir');
    if (this.fault?.(op, path)) throw new Error('Disk unavailable');
  }
  async read(path: string) {
    this.check('read', path);
    const value = this.entries.get(path);
    if (value === null) throw new Error('Cannot read directory');
    return value?.slice() ?? null;
  }
  async write(path: string, data: Uint8Array) {
    this.check('write', path);
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    if (this.entries.get(parent) !== null) throw new Error('Parent missing');
    if (this.entries.get(path) === null) throw new Error('Cannot replace directory');
    this.entries.set(path, data.slice());
  }
  async list(path: string): Promise<PortableFileEntry[]> {
    this.check('list', path);
    if (this.entries.get(path) !== null) throw new Error('Directory missing');
    const prefix = path ? `${path}/` : '';
    return [...this.entries].flatMap(([key, value]) => {
      const name = key.slice(prefix.length);
      return key.startsWith(prefix) && name && !name.includes('/')
        ? [
            {
              name,
              isDirectory: value === null,
              size: value?.byteLength ?? 0,
              mtime: Date.parse('2026-09-20T12:00:00Z'),
            },
          ]
        : [];
    });
  }
  async mkdir(path: string) {
    this.check('mkdir', path);
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (this.entries.has(current) && this.entries.get(current) !== null)
        throw new Error('File blocks directory');
      this.entries.set(current, null);
    }
  }
  async remove(path: string) {
    this.check('remove', path);
    for (const key of this.entries.keys())
      if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
  }
  async rename(from: string, to: string) {
    this.check('rename', from);
    validatePortablePath(to);
    if (!this.entries.has(from) || this.entries.has(to)) throw new Error('Invalid rename');
    for (const [key, value] of [...this.entries])
      if (key === from || key.startsWith(`${from}/`)) {
        this.entries.set(`${to}${key.slice(from.length)}`, value);
        this.entries.delete(key);
      }
  }
}
function fixture() {
  const files = new MemoryFiles();
  let id = 0;
  const options = { files, createId: () => `generated-${++id}`, now: () => '2026-09-20T12:00:00Z' };
  return { files, options, store: new PortableStore(options) };
}

describe('PortableStore ordinary product files', () => {
  it('uses the desktop Meester, project, crew, library, file and conversation model across reopen', async () => {
    const { files, store, options } = fixture();
    await store.ensureLayout();
    const config = await store.readConfig();
    const meester = (await store.getGezel(config.meesterGezelId!))!;
    expect(meester.about).toBe(MEESTER_ABOUT_MD);
    expect(meester.role).toBe('Meester');
    expect(meester.poppetje?.key).toBe(meester.id);
    const library = (await store.listProjects()).find(isSharedLibraryProject)!;
    expect(library.id).toBe(config.sharedProjectId);
    const project = await store.createProject({
      name: 'Autumn garden',
      about: 'A small courtyard',
      missionObjectives: 'Grow herbs',
    });
    const writer = await store.createGezel({
      name: 'Mara',
      role: 'Writer',
      about: 'Write clear plans.',
    });
    await store.addGezelToProject(project.id, writer.id);
    await store.updateProject(project.id, { voormanGezelId: writer.id });
    await store.writeFile('workspace', project.id, 'notes/garden.md', '# Garden\nMint and thyme');
    await store.writeFile('documents', undefined, 'house-style.md', 'Friendly and concise');
    expect(await store.readFile('workspace', library.id, 'house-style.md')).toBe(
      'Friendly and concise',
    );
    await store.writeFile('artifacts', project.id, 'plan.md', 'Plant in spring.');
    await store.renameFile('workspace', project.id, 'notes', 'research');
    const chat = await store.createSession({
      gezelId: writer.id,
      projectId: project.id,
      providerName: 'android-mlkit',
    });
    chat.messages.push(
      { role: 'user', content: 'Create a planting plan', at: options.now() },
      {
        id: 'reply-1',
        role: 'assistant',
        content: 'Plant in spring.',
        at: options.now(),
        providerId: 'android-mlkit',
        status: 'complete',
        stopReason: 'stop',
      },
    );
    await store.writeSession(chat);
    const reopened = new PortableStore(options);
    await reopened.ensureLayout();
    expect((await reopened.getProjectContext(project.id, writer.id)).project).toMatchObject({
      about: 'A small courtyard',
      missionObjectives: 'Grow herbs',
      voormanGezelId: writer.id,
    });
    expect((await reopened.getSession(writer.id, chat.id))?.messages.at(-1)).toMatchObject({
      content: 'Plant in spring.',
      status: 'complete',
      providerId: 'android-mlkit',
    });
    expect((await reopened.listSessions({ projectId: project.id }))[0]?.title).toBe(
      'Create planting plan',
    );
    expect(
      (await reopened.listFiles('workspace', project.id, '', true)).entries.map(
        (item) => item.path,
      ),
    ).toEqual(['research', 'research/garden.md']);
    expect(await reopened.readFile('artifacts', project.id, 'plan.md')).toBe('Plant in spring.');
    expect(files.entries.has(`projects/${project.id}/documents/about.md`)).toBe(true);
    expect(files.entries.has(`gezels/${writer.id}/sessions/${chat.id}.json`)).toBe(true);
    expect([...files.entries.keys()].some((path) => path.includes('state.json'))).toBe(false);
  });
  it('persists explicit appearance, pins grain identity and honors deterministic rerolls', async () => {
    const { store, files, options } = fixture();
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Mara', role: 'Writer', gender: 'female' });
    const customized = {
      ...gezel.poppetje!,
      key: 'some-other-gezel',
      shirt: '#123456',
    };
    // Use a supported palette change as well as a caller-supplied wrong key.
    const saved = await store.setGezelPoppetje(gezel.id, customized);
    expect(saved.key).toBe(gezel.id);
    expect(saved.shirt).toBe('#123456');
    const reopened = new PortableStore(options);
    expect(await reopened.getGezelPoppetje(gezel.id)).toEqual(saved);
    const rerolled = await reopened.rerollGezelPoppetje(gezel.id, { seed: 917 });
    expect(rerolled).toEqual(
      poppetjeFromSeed(917, { key: gezel.id, name: 'Mara', gender: 'female' }),
    );
    const stored = JSON.parse(decodeText((await files.read(`gezels/${gezel.id}/poppetje.json`))!));
    expect(stored).toEqual(rerolled);
    expect(stored).toHaveProperty('facialHair');
    expect(stored).toHaveProperty('hat');
    expect(stored).toHaveProperty('shirtPattern');
    await expect(reopened.rerollGezelPoppetje(gezel.id, { seed: 1.5 })).rejects.toThrow();
    expect(await reopened.getGezelPoppetje(gezel.id)).toEqual(rerolled);
    await reopened.updateGezelSettings(gezel.id, { name: 'Marianne' });
    expect(await reopened.getGezelPoppetje(gezel.id)).toEqual({ ...rerolled, name: 'Marianne' });
    expect(
      JSON.parse(decodeText((await files.read(`gezels/${gezel.id}/poppetje.json`))!)).name,
    ).toBe('Marianne');
  });
  it('regenerates missing or malformed appearance but does not swallow storage failures', async () => {
    const { store, files } = fixture();
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Nova', gender: 'female' });
    const path = `gezels/${gezel.id}/poppetje.json`;
    await files.remove(path);
    expect(await store.getGezelPoppetje(gezel.id)).toEqual(
      initialPoppetjeForGezel(gezel.id, 'Nova', 'female'),
    );
    await files.write(path, encodeText('{broken'));
    expect(await store.getGezelPoppetje(gezel.id)).toEqual(
      initialPoppetjeForGezel(gezel.id, 'Nova', 'female'),
    );
    files.fault = (op, source) => op === 'read' && source === path;
    await expect(store.getGezelPoppetje(gezel.id)).rejects.toThrow('Disk unavailable');
    files.fault = undefined;
    const before = await files.read(path);
    files.fault = (op, source) =>
      op === 'write' && /^\.transactions\/generated-\d+\/0$/.test(source);
    await expect(store.rerollGezelPoppetje(gezel.id, { seed: 111 })).rejects.toThrow(
      'Disk unavailable',
    );
    files.fault = undefined;
    expect(await files.read(path)).toEqual(before);
  });
  it('keeps shared-library identity distinct when a user project owns shared', async () => {
    const { files, store } = fixture();
    await files.mkdir('projects/shared');
    await files.write(
      'projects/shared/project.json',
      encodeText(
        JSON.stringify({
          id: 'shared',
          name: 'Shared garden',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        }),
      ),
    );
    await store.ensureLayout();
    expect(await store.sharedProjectId()).toBe('shared-library');
    expect(isSharedLibraryProject((await store.getProject('shared'))!)).toBe(false);
    await expect(store.deleteProject('shared-library')).rejects.toThrow('cannot be deleted');
    await expect(store.updateProject('shared-library', { archived: true })).rejects.toThrow();
    await expect(
      store.updateProject('shared', { properties: { 'gezel.sharedLibrary': '1' } }),
    ).rejects.toThrow('identity');
  });
  it('persists drafts and binary attachments without allowing generic writes to metadata', async () => {
    const { store, options } = fixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const draft = await store.createPromptDraft('default', {
      gezelId,
      content: '# Question\nWhat grows here?',
    });
    const attachment = `prompts/${draft.id}/message_files/photo.png`;
    const bytes = new Uint8Array([0, 255, 137, 1]);
    await store.writeFileBytes('artifacts', 'default', attachment, bytes, { createOnly: true });
    await expect(
      store.writeFileBytes('artifacts', 'default', attachment, bytes, { createOnly: true }),
    ).rejects.toThrow('already exists');
    await expect(
      store.writeFile('artifacts', 'default', `prompts/${draft.id}/draft.json`, '{}'),
    ).rejects.toThrow('metadata');
    const reopened = new PortableStore(options);
    expect(await reopened.readFileBytes('artifacts', 'default', attachment)).toEqual(bytes);
    expect(await reopened.getPromptDraft('default', draft.id)).toMatchObject({
      title: 'Question',
      hasFiles: true,
      fileCount: 1,
    });
    const chat = await reopened.createSession({ gezelId });
    await reopened.markPromptDraftSent('default', draft.id, chat.id);
    await expect(reopened.writePromptDraftContent('default', draft.id, 'Changed')).rejects.toThrow(
      'sent draft',
    );
    await expect(
      reopened.writeFileBytes('artifacts', 'default', attachment, bytes),
    ).rejects.toThrow('not editable');
    const reused = await reopened.duplicatePromptDraft('default', draft.id, { sessionId: null });
    expect(reused).toMatchObject({
      status: 'draft',
      sessionId: null,
      content: draft.content,
      fileCount: 1,
    });
    expect(reused.id).not.toBe(draft.id);
    expect(
      await reopened.readFileBytes(
        'artifacts',
        'default',
        `prompts/${reused.id}/message_files/photo.png`,
      ),
    ).toEqual(bytes);
    expect(
      (await reopened.listFiles('artifacts', 'default', `prompts/${reused.id}/message_files`))
        .entries,
    ).toHaveLength(1);
  });
  it('does not commit partially staged updates and recovers a published transaction after restart', async () => {
    const { store, files, options } = fixture();
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Garden', about: 'Before' });
    files.fault = (op, path) => op === 'write' && /^\.transactions\/generated-\d+\/1$/.test(path);
    await expect(
      store.updateProject(project.id, { name: 'After', about: 'After' }),
    ).rejects.toThrow('Disk unavailable');
    files.fault = undefined;
    expect(await store.getProject(project.id)).toMatchObject({ name: 'Garden', about: 'Before' });
    files.fault = (op, path) => op === 'write' && path.endsWith('/documents/about.md');
    await expect(
      store.updateProject(project.id, { name: 'After', about: 'After' }),
    ).rejects.toThrow('Disk unavailable');
    expect(files.entries.has('.transactions/pending.json')).toBe(true);
    files.fault = undefined;
    const reopened = new PortableStore(options);
    expect(await reopened.getProject(project.id)).toMatchObject({ name: 'After', about: 'After' });
    expect(files.entries.has('.transactions/pending.json')).toBe(false);
  });

  it('commits a sent draft and user message together, and enforces workspace write policy', async () => {
    const { store, files, options } = fixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const session = await store.createSession({ gezelId });
    const draft = await store.createPromptDraft('default', {
      gezelId,
      sessionId: session.id,
      content: 'A question',
    });
    session.messages.push({
      role: 'user',
      content: 'A question',
      at: options.now(),
      draftId: draft.id,
    });
    files.fault = (op, path) => op === 'write' && path.endsWith('/draft.json');
    await expect(store.writeSession(session, { sentDraftId: draft.id })).rejects.toThrow(
      'Disk unavailable',
    );
    files.fault = undefined;
    const reopened = new PortableStore(options);
    expect((await reopened.getSession(gezelId, session.id))?.messages).toHaveLength(1);
    expect(await reopened.getPromptDraft('default', draft.id)).toMatchObject({
      status: 'sent',
      sentSessionId: session.id,
    });
    await expect(reopened.writeSession(session, { sentDraftId: draft.id })).rejects.toThrow(
      'not available',
    );
    await reopened.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
    await expect(
      reopened.writeFile('workspace', 'default', 'blocked.md', 'Denied'),
    ).rejects.toThrow('disabled');
    await reopened.writeFile('artifacts', 'default', 'allowed.md', 'Allowed');
    expect(await reopened.readFile('artifacts', 'default', 'allowed.md')).toBe('Allowed');
  });
  it('serializes concurrent mutations and preserves workspace on default project removal', async () => {
    const { store } = fixture();
    await store.ensureLayout();
    const [a, b] = await Promise.all([
      store.createProject({ name: 'Same' }),
      store.createProject({ name: 'Same' }),
    ]);
    expect([a.id, b.id]).toEqual(['same', 'same-2']);
    await store.writeFile('workspace', a.id, 'keep.md', 'Keep me');
    await store.deleteProject(a.id);
    expect(await store.getProject(a.id)).toBeNull();
    expect((await store.createProject({ name: 'Same' })).id).toBe('same-3');
    await expect(store.deleteProject('default')).rejects.toThrow();
  });
  it('confines paths, rejects unsupported text and cannot poison storage through invalid destinations', async () => {
    const { store, files } = fixture();
    await store.ensureLayout();
    for (const path of [
      '../config.json',
      '/tmp/file',
      'a/../../x',
      'a\\b',
      'a//b',
      'a/.',
      'a/CON',
      'a/b.',
      'a\0b',
      'a'.repeat(256),
      '日'.repeat(86),
      '',
    ])
      await expect(store.writeFile('workspace', 'default', path, 'bad')).rejects.toThrow();
    await expect(store.createSession({ gezelId: '../escape' })).rejects.toThrow();
    await store.writeFile('workspace', 'default', 'blocker', 'existing');
    await expect(
      store.writeFile('workspace', 'default', 'blocker/child.md', 'bad'),
    ).rejects.toThrow();
    await store.makeFolder('workspace', 'default', 'folder');
    await expect(store.writeFile('workspace', 'default', 'folder', 'bad')).rejects.toThrow();
    await store.writeFileBytes('workspace', 'default', 'binary.dat', new Uint8Array([0xff, 0]));
    await expect(store.readFile('workspace', 'default', 'binary.dat')).rejects.toThrow();
    expect(files.entries.has('.transactions/pending.json')).toBe(false);
    expect(decodeText((await files.read('config.json'))!)).toContain('meesterGezelId');
  });
});

describe('desktop creation helper parity', () => {
  it('keeps slug and role suffix allocation stable', () => {
    expect(slugifyEntityName('  My Project! ')).toBe('my-project');
    expect(slugifyEntityName('x'.repeat(80))).toHaveLength(64);
    expect(pickRoleBasedName('Writer', new Set())).toBe('writer');
    expect(pickRoleBasedName('Writer', new Set(['writer', 'writer-2']))).toBe('writer-3');
    expect(pickRoleBasedName(undefined, new Set(['gezel-1']))).toBe('gezel-2');
  });
});

describe('damaged records do not take the product down', () => {
  it('quarantines unreadable JSON, skips schema drift, and still opens', async () => {
    const { files, store, options } = fixture();
    await store.ensureLayout();
    const gezel = await store.createGezel({ name: 'Reader', role: 'Writer' });
    const project = await store.createProject({ name: 'Work' });
    const good = await store.createSession({ gezelId: gezel.id, projectId: project.id });

    // One session file is truncated mid-write; another survives an older
    // schema. Neither is a reason to refuse to open the app.
    const torn = `gezels/${gezel.id}/sessions/torn.json`;
    const stale = `gezels/${gezel.id}/sessions/stale.json`;
    files.entries.set(torn, encodeText('{"id":"torn","messages":[{'));
    files.entries.set(stale, encodeText('{"id":"stale","fromAFutureBuild":true}'));

    const reopened = new PortableStore(options);
    await reopened.ensureLayout();
    const sessions = await reopened.listSessions({ gezelId: gezel.id });
    expect(sessions.map((session) => session.id)).toEqual([good.id]);

    // Invalid JSON is damage: set aside with its bytes intact for recovery.
    const quarantined = [...files.entries.keys()].filter((path) =>
      path.startsWith(`${torn}.corrupt-`),
    );
    expect(quarantined).toHaveLength(1);
    expect(decodeText(files.entries.get(quarantined[0]!)!)).toBe('{"id":"torn","messages":[{');
    expect(files.entries.has(torn)).toBe(false);

    // Valid JSON that misses the schema may be version skew: keep the file.
    expect(files.entries.has(stale)).toBe(true);
  });

  it('skips a gezel it cannot read rather than failing the roster', async () => {
    const { files, store, options } = fixture();
    await store.ensureLayout();
    const keep = await store.createGezel({ name: 'Keeper', role: 'Writer' });
    // A gezel directory whose record cannot be read at all: here the path is
    // itself a directory, which is how a half-finished sync can leave things.
    files.entries.set('gezels/broken', null);
    files.entries.set('gezels/broken/gezel.md', null);

    const reopened = new PortableStore(options);
    const roster = await reopened.listGezels();
    expect(roster.map((entry) => entry.id)).toContain(keep.id);
    expect(roster.map((entry) => entry.id)).not.toContain('broken');
  });
});

describe('a damaged transaction journal does not brick the product', () => {
  it('sets aside a committed journal whose staged bytes are gone, and keeps working', async () => {
    const { files, store, options } = fixture();
    await store.ensureLayout();
    await store.createProject({ name: 'Before' });

    // A journal that reached its commit point while the staged bytes did not
    // survive. Recovery runs before every store call, so throwing here used to
    // make the product permanently unopenable.
    files.entries.set('.transactions', null);
    files.entries.set(
      '.transactions/pending.json',
      encodeText(
        JSON.stringify({
          id: 'lost',
          writes: [{ path: 'projects/ghost/project.json', staged: '.transactions/lost/0' }],
          removes: [],
          directories: [],
          clears: [],
        }),
      ),
    );

    const reopened = new PortableStore(options);
    const projects = await reopened.listProjects();
    expect(projects.some((project) => project.name === 'Before')).toBe(true);
    // The journal is kept under a new name as evidence, not applied in part.
    expect(files.entries.has('.transactions/pending.json')).toBe(false);
    const setAside = [...files.entries.keys()].filter((path) =>
      path.startsWith('.transactions/unrecoverable-'),
    );
    expect(setAside).toHaveLength(1);
    expect(await reopened.listProjects()).toHaveLength(projects.length);
  });

  it('still refuses to import when three reviews are genuinely pending', async () => {
    const { files, store } = fixture();
    await store.ensureLayout();
    // Three complete reviews and one interrupted upload. The complete ones
    // reach the cap on their own; the interrupted directory must be swept
    // rather than counted, or interrupted uploads alone could lock the user out.
    files.entries.set('.restore', null);
    for (const id of ['one', 'two', 'three']) {
      files.entries.set(`.restore/${id}`, null);
      files.entries.set(`.restore/${id}/review.json`, encodeText('{}'));
    }
    files.entries.set('.restore/torn', null);
    files.entries.set('.restore/torn/archive.zip', encodeText('partial'));

    await expect(store.scanRestore(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /Cancel a pending restore review/,
    );
    // The interrupted upload is swept rather than counted.
    expect(files.entries.has('.restore/torn')).toBe(false);
  });
});
