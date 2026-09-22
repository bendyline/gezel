import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BACKUP_MANIFEST_KIND, BACKUP_SCHEMA_VERSION } from '../schemas/storage.js';
import { readBackupZip, writeBackupZip } from './backup-zip.js';
import { handlePortableDataRequest } from './data-routes.js';
import { decodeText, encodeText } from './files.js';
import { parseMemoryDay } from './memory-markdown.js';
import { PortableStore } from './store.js';
import { portableFixture } from './test-files.js';

describe('portable lexical source search and ordinary memories', () => {
  it('finds conversation content with the desktop message coordinate and excludes archived threads', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const session = await store.createSession({
      gezelId,
      projectId: 'default',
      title: 'A garden plan',
    });
    session.messages = [
      { id: 'first', role: 'user', content: 'Try thyme beside the gate.', at: session.createdAt },
    ];
    await store.writeSession(session);
    expect((await store.search({ query: 'thyme' })).results).toContainEqual(
      expect.objectContaining({
        kind: 'session',
        id: `session:${session.id}`,
        gezelId,
        projectId: 'default',
        line: 1,
      }),
    );
    expect((await store.search({ query: 'thyme', mode: 'names' })).results).toEqual([]);
    session.archived = true;
    await store.writeSession(session);
    expect((await store.search({ query: 'thyme' })).results).toEqual([]);
  });
  it('returns source locations from the scoped workspace, artifacts and library without crossing another project', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const garden = await store.createProject({ name: 'Garden' });
    const other = await store.createProject({ name: 'Private other' });
    await store.writeFile(
      'workspace',
      garden.id,
      'notes.md',
      '# Garden\n\nPlant thyme by the gate.',
    );
    await store.writeFile('artifacts', garden.id, 'plan.md', 'Thyme needs sun.');
    await store.writeFile('documents', undefined, 'guide.md', 'Thyme is a herb.');
    await store.writeFile('workspace', other.id, 'secret.md', 'Thyme in another project.');
    const found = await store.searchProject(garden.id, { query: 'THYME' });
    expect(found.results.map((hit) => hit.retrievalSource).sort()).toEqual([
      'artifacts',
      'shared',
      'workspace',
    ]);
    expect(found.results.find((hit) => hit.path === 'notes.md')).toMatchObject({
      line: 3,
      snippet: 'Plant thyme by the gate.',
    });
    expect(found.results.some((hit) => hit.path === 'secret.md')).toBe(false);
    expect((await store.searchDocuments({ q: 'thyme' })).engine).toBe('lexical');
    expect(
      (await store.search({ query: 'garden', mode: 'names' })).results.some(
        (hit) => hit.kind === 'project',
      ),
    ).toBe(true);
    await expect(
      store.searchProject(garden.id, { query: 'thyme', pathPrefix: '../' }),
    ).rejects.toThrow(/unsafe/);
    expect(
      (
        await store.searchProject(garden.id, {
          query: 'thyme',
          sources: ['artifacts'],
          includeShared: false,
        })
      ).results.map((hit) => hit.path),
    ).toEqual(['plan.md']);
  });
  it('marks unreadable source coverage incomplete and caps results rather than reporting a complete empty index', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    await store.writeFile('documents', undefined, 'one.md', 'needle one');
    await store.writeFile('documents', undefined, 'two.md', 'needle two');
    await store.writeFileBytes('documents', undefined, 'binary.md', new Uint8Array([0, 1, 2]));
    const found = await store.searchDocuments({ q: 'needle', maxResults: 1 });
    expect(found).toMatchObject({ engine: 'lexical', truncated: true, sourcesIncomplete: true });
    expect(found.results).toHaveLength(1);
  });
  it('persists the shared daily Markdown format, exact duplicate handling, lessons and lexical recall across reopen', async () => {
    const { store, options } = portableFixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    expect(
      await store.saveMemory({
        scope: 'gezel',
        id: gezelId,
        text: 'Use clear language.',
        kind: 'pref',
      }),
    ).toMatchObject({ status: 'saved', indexed: false });
    expect(
      await store.saveMemory({
        scope: 'gezel',
        id: gezelId,
        text: ' USE   clear language. ',
        kind: 'pref',
      }),
    ).toMatchObject({ status: 'duplicate' });
    await store.writeMemoryLessons(gezelId, 'Ask before making assumptions.');
    const reopened = new PortableStore(options);
    expect(await reopened.listMemoryDays('gezel', gezelId)).toEqual(['2026-09-20']);
    expect(parseMemoryDay(await reopened.readMemoryDay('gezel', gezelId, '2026-09-20'))).toEqual([
      { time: '12:00', kind: 'pref', text: 'Use clear language.' },
    ]);
    expect(await reopened.readMemoryLessons(gezelId)).toBe('Ask before making assumptions.');
    expect(
      await reopened.searchMemories({ gezelId, projectId: 'default', query: 'clear' }),
    ).toMatchObject({
      mode: 'lexical',
      results: [{ scope: 'gezel', kind: 'pref', text: 'Use clear language.' }],
    });
    await reopened.updateMemoryDay(
      'gezel',
      gezelId,
      '2026-09-20',
      '## 12:05 [decision]\n\nUse short sentences.\n',
    );
    expect(
      (await reopened.searchMemories({ gezelId, projectId: 'default', query: 'clear' })).results,
    ).toEqual([]);
  });
  it('rejects unsafe identity/day values, nonexistent owners and readonly project memory writes', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    for (const day of ['../config', '2026-02-30', '2026-13-01'])
      await expect(store.updateMemoryDay('gezel', gezelId, day, 'bad')).rejects.toThrow();
    await expect(
      store.saveMemory({ scope: 'project', id: '../default', text: 'bad' }),
    ).rejects.toThrow();
    await expect(store.readMemoryLessons('missing')).rejects.toThrow(/not be found/);
    await store.updateProject('default', { status: 'readonly' });
    await expect(
      store.saveMemory({ scope: 'project', id: 'default', text: 'bad' }),
    ).rejects.toThrow(/read-only/);
  });
});

describe('portable backup validation and transactional restore', () => {
  it('exports ordinary interoperable ZIP entries, excludes secrets, and restores text/binary/project/crew/session state', async () => {
    const source = portableFixture();
    await source.store.ensureLayout();
    const project = await source.store.createProject({ name: 'Field notes' });
    const gezel = await source.store.createGezel({ name: 'Ada', about: 'Take careful notes.' });
    await source.store.addGezelToProject(project.id, gezel.id);
    await source.store.writeFile('workspace', project.id, 'brief.md', 'Original brief');
    await source.store.writeFile(
      'workspace',
      project.id,
      'index/notes.md',
      'User-owned index folder',
    );
    await source.files.mkdir(`projects/${project.id}/_index`);
    await source.files.write(
      `projects/${project.id}/_index/derived.db`,
      encodeText('Derived cache'),
    );
    await source.store.writeFileBytes(
      'artifacts',
      project.id,
      'sample.bin',
      new Uint8Array([0, 1, 255]),
    );
    await source.store.writeFile('documents', undefined, 'guide.md', 'Original guide');
    await source.store.saveMemory({ scope: 'gezel', id: gezel.id, text: 'Keep notes.' });
    await source.store.writeMemoryLessons(gezel.id, 'Read the brief.');
    await source.store.writeConfig({
      openaiApiKey: 'must-not-export',
      service: { url: 'https://example.invalid', token: 'private-token' },
    });
    const session = await source.store.createSession({
      gezelId: gezel.id,
      projectId: project.id,
      providerName: 'llama-cpp',
    });
    session.messages.push({
      role: 'assistant',
      content: 'Keep looking.',
      at: source.options.now(),
    });
    await source.store.writeSession(session);
    const exported = await source.store.exportBackup();
    const entries = await readBackupZip(exported.bytes);
    expect([...entries.keys()]).toContain(`gezels/${gezel.id}/gezel.md`);
    expect([...entries.keys()].some((path) => path.endsWith('/_index/derived.db'))).toBe(false);
    expect(decodeText(entries.get('settings/config.json')!)).not.toMatch(
      /must-not-export|private-token|service/,
    );
    const target = portableFixture();
    await target.store.ensureLayout();
    const review = await target.store.scanRestore(exported.bytes);
    const restored = await target.store.confirmRestore(review.restoreId, {
      items: review.items.map((item) => ({
        kind: item.kind,
        id: item.id,
        action: item.conflict === 'exists' ? 'replace' : 'add',
      })),
      settings: true,
    });
    expect(restored.restored).toBeGreaterThan(1);
    const reopened = new PortableStore(target.options);
    expect(await reopened.readFile('workspace', project.id, 'brief.md')).toBe('Original brief');
    expect(await reopened.readFile('workspace', project.id, 'index/notes.md')).toBe(
      'User-owned index folder',
    );
    expect(await reopened.readFileBytes('artifacts', project.id, 'sample.bin')).toEqual(
      new Uint8Array([0, 1, 255]),
    );
    expect((await reopened.getProject(project.id))?.gezelIds).toContain(gezel.id);
    expect((await reopened.getSession(gezel.id, session.id))?.messages[0]?.content).toBe(
      'Keep looking.',
    );
    expect(await reopened.readMemoryLessons(gezel.id)).toBe('Read the brief.');
    expect((await reopened.readConfig()).service).toBeUndefined();
  });
  it('requires explicit replacement and keeps omitted workspaces during a content restore', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    await store.writeFile('workspace', 'default', 'kept.md', 'Before');
    await store.writeFile('artifacts', 'default', 'output.md', 'Old output');
    const backup = await store.exportBackup({ excludeWorkspaces: true });
    await store.writeFile('workspace', 'default', 'kept.md', 'Keep this newer working copy');
    await store.writeFile('artifacts', 'default', 'output.md', 'New output');
    const review = await store.scanRestore(backup.bytes);
    await expect(
      store.confirmRestore(review.restoreId, {
        items: [{ kind: 'project', id: 'default', action: 'add' }],
      }),
    ).rejects.toThrow(/replace/);
    expect(await store.readFile('artifacts', 'default', 'output.md')).toBe('New output');
    await store.confirmRestore(review.restoreId, {
      items: [{ kind: 'project', id: 'default', action: 'replace' }],
    });
    expect(await store.readFile('workspace', 'default', 'kept.md')).toBe(
      'Keep this newer working copy',
    );
    expect(await store.readFile('artifacts', 'default', 'output.md')).toBe('Old output');
  });
  it('rejects undeclared files, invalid entity schemas and changed reviewed bytes without changing product data', async () => {
    const { store, files } = portableFixture();
    await store.ensureLayout();
    await store.writeFile('documents', undefined, 'guide.md', 'Safe');
    const original = await store.exportBackup();
    const entries = await readBackupZip(original.bytes);
    entries.set('config.json', encodeText('{}'));
    await expect(store.scanRestore(writeBackupZip(entries))).rejects.toThrow(/undeclared/);
    entries.delete('config.json');
    const project = JSON.parse(decodeText(entries.get('projects/default/project.json')!));
    project.id = '../escape';
    entries.set('projects/default/project.json', encodeText(JSON.stringify(project)));
    await expect(store.scanRestore(writeBackupZip(entries))).rejects.toThrow();
    const review = await store.scanRestore(original.bytes);
    const staged = files.entries.get(`.restore/${review.restoreId}/archive.zip`) as Uint8Array;
    staged[20] = (staged[20] ?? 0) ^ 1;
    await expect(
      store.confirmRestore(review.restoreId, {
        items: [{ kind: 'document-root', id: 'documents', action: 'replace' }],
      }),
    ).rejects.toThrow(/changed/);
    expect(await store.readFile('documents', undefined, 'guide.md')).toBe('Safe');
  });
  it('publishes nothing before journal commit and recovers a committed restore after file/folder replacement failure', async () => {
    const { store, files, options } = portableFixture();
    await store.ensureLayout();
    await store.writeFile('documents', undefined, 'guide.md', 'Saved guide');
    const backup = await store.exportBackup();
    await store.deleteFile('documents', undefined, 'guide.md');
    await store.writeFile('documents', undefined, 'guide.md/note.txt', 'Current folder');
    const review = await store.scanRestore(backup.bytes);
    const selection = {
      items: [{ kind: 'document-root' as const, id: 'documents', action: 'replace' as const }],
    };
    files.fault = (op, path) => op === 'write' && path === '.transactions/pending.json';
    await expect(store.confirmRestore(review.restoreId, selection)).rejects.toThrow(/Disk/);
    files.fault = undefined;
    expect(await store.readFile('documents', undefined, 'guide.md/note.txt')).toBe(
      'Current folder',
    );
    files.fault = (op, path) => op === 'write' && path === 'documents/guide.md';
    await expect(store.confirmRestore(review.restoreId, selection)).rejects.toThrow(/Disk/);
    expect(files.entries.has('.transactions/pending.json')).toBe(true);
    files.fault = undefined;
    const reopened = new PortableStore(options);
    expect(await reopened.readFile('documents', undefined, 'guide.md')).toBe('Saved guide');
    expect(files.entries.has('.transactions/pending.json')).toBe(false);
    expect(files.entries.has(`.restore/${review.restoreId}`)).toBe(false);
  });
  it('verifies ZIP checksums, confinement, case collisions, links and size declarations', async () => {
    const valid = writeBackupZip(new Map([['notes/a.txt', encodeText('safe')]]));
    const corrupted = valid.slice();
    corrupted[30 + 'notes/a.txt'.length] = (corrupted[30 + 'notes/a.txt'.length] ?? 0) ^ 1;
    await expect(readBackupZip(corrupted)).rejects.toThrow(/checksum/);
    expect(() => writeBackupZip(new Map([['../escape', encodeText('bad')]]))).toThrow(/unsafe/);
    expect(() =>
      writeBackupZip(
        new Map([
          ['Notes.md', encodeText('a')],
          ['notes.md', encodeText('b')],
        ]),
      ),
    ).toThrow(/duplicate/);
    const central = 30 + 'notes/a.txt'.length + 4;
    const link = valid.slice();
    new DataView(link.buffer).setUint32(central + 38, 0xa1ff0000, true);
    await expect(readBackupZip(link)).rejects.toThrow(/linked/);
    const bomb = valid.slice();
    new DataView(bomb.buffer).setUint32(central + 24, 1024 * 1024 * 1024, true);
    await expect(readBackupZip(bomb)).rejects.toThrow(/size limit/);
  });

  it('reads DEFLATE entries produced by desktop ZIP writers and bounds their expansion', async () => {
    const source = encodeText('A desktop backup with a compressed document.');
    const name = 'notes/a.txt';
    const stored = writeBackupZip(new Map([[name, source]]));
    const headerEnd = 30 + name.length;
    const compressed = new Uint8Array(deflateRawSync(source));
    const centralOffset = headerEnd + compressed.length;
    const archive = new Uint8Array(stored.length - source.length + compressed.length);
    archive.set(stored.subarray(0, headerEnd));
    archive.set(compressed, headerEnd);
    archive.set(stored.subarray(headerEnd + source.length), centralOffset);
    const view = new DataView(archive.buffer);
    view.setUint16(8, 8, true);
    view.setUint32(18, compressed.length, true);
    view.setUint16(centralOffset + 10, 8, true);
    view.setUint32(centralOffset + 20, compressed.length, true);
    view.setUint32(archive.length - 22 + 16, centralOffset, true);
    expect((await readBackupZip(archive)).get(name)).toEqual(source);
    view.setUint32(centralOffset + 24, 1, true);
    await expect(readBackupZip(archive)).rejects.toThrow(/declared size/);
  });
  it('accepts a desktop-shaped archive that carries a history file', async () => {
    // Desktop backups list `settings/history.jsonl`; a phone never restores
    // it, but refusing the archive over it locked users out of every restore.
    const { store } = portableFixture();
    await store.ensureLayout();
    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: BACKUP_MANIFEST_KIND,
      createdAt: '2026-09-22T00:00:00.000Z',
      gezelVersion: '1.2.3',
      platform: 'darwin',
      externalFolders: null,
      secretsExcluded: true,
      items: [
        {
          kind: 'settings-file',
          id: 'config.json',
          label: 'Settings',
          entryPrefix: 'settings/config.json',
          bytes: 2,
          fileCount: 1,
        },
        {
          kind: 'settings-file',
          id: 'history.jsonl',
          label: 'History',
          entryPrefix: 'settings/history.jsonl',
          bytes: 17,
          fileCount: 1,
        },
      ],
    };
    const archive = writeBackupZip(
      new Map([
        ['manifest.json', encodeText(JSON.stringify(manifest))],
        ['settings/config.json', encodeText('{}')],
        ['settings/history.jsonl', encodeText('{"event":"boot"}\n')],
      ]),
    );
    const review = await store.scanRestore(archive);
    expect(review.items.map((item) => item.id).sort()).toEqual(['config.json', 'history.jsonl']);
    await store.confirmRestore(review.restoreId, { items: [], settings: true });
    expect(await store.readConfig()).toBeTruthy();
  });

  it('serves real search and backup routes and checks the restore activity guard before publishing', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    await store.writeFile('documents', undefined, 'note.md', 'Keyword');
    const route = (path: string, init: RequestInit = {}) => {
      const url = new URL(`https://local${path}`);
      return handlePortableDataRequest(store, new Request(url, init), url, {
        beforeRestore: () => {
          throw new Error('Conversation active');
        },
      });
    };
    const response = await route('/api/documents/search?q=Keyword');
    expect(await response?.json()).toMatchObject({
      engine: 'lexical',
      results: [{ path: 'note.md' }],
    });
    const exported = await route('/api/storage/backup/export', { method: 'POST', body: '{}' });
    const uploaded = await route('/api/storage/restore/upload', {
      method: 'POST',
      body: await exported!.arrayBuffer(),
    });
    const review = (await uploaded!.json()) as { restoreId: string };
    await expect(
      route(`/api/storage/restore/${review.restoreId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ kind: 'document-root', id: 'documents', action: 'replace' }],
        }),
      }),
    ).rejects.toThrow(/Conversation active/);
    expect(await store.readFile('documents', undefined, 'note.md')).toBe('Keyword');
  });
});
