import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { MACHINE_SHARED_MARKER } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

let root: string;
let userHome: string;
let sharedHome: string;
let previousSharedOverride: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-machine-shared-store-'));
  userHome = join(root, 'user');
  sharedHome = join(root, 'shared');
  previousSharedOverride = process.env.GEZEL_MACHINE_SHARED_HOME;
  delete process.env.GEZEL_MACHINE_SHARED_HOME;

  // Build a representative pre-split home before publishing it as shared.
  const legacy = new Store({ home: sharedHome });
  await legacy.ensureLayout();
  await legacy.createProject({ name: 'Shared Project' });
  await legacy.createGezel({ name: 'Ada', role: 'Developer' });
  const at = '2026-08-04T10:00:00.000Z';
  const session: ChatSession = {
    version: 1,
    id: 'legacy-session',
    gezelId: 'ada',
    projectId: 'shared-project',
    providerName: 'copilot',
    title: 'Legacy work',
    createdAt: at,
    lastActivityAt: at,
    messages: [{ role: 'user', content: 'preserve this', at }],
    providerState: {},
  };
  await legacy.writeSession(session);
  await legacy.writeMemoryDay('gezel', 'ada', '2026-08-04', 'legacy memory\n');
  await writeFile(join(sharedHome, MACHINE_SHARED_MARKER), `${JSON.stringify({ version: 1 })}\n`);
  process.env.GEZEL_MACHINE_SHARED_HOME = sharedHome;
});

afterEach(async () => {
  if (previousSharedOverride === undefined) delete process.env.GEZEL_MACHINE_SHARED_HOME;
  else process.env.GEZEL_MACHINE_SHARED_HOME = previousSharedOverride;
  await rm(root, { recursive: true, force: true });
});

describe('machine-shared Store mount', () => {
  it('merges shared entities and adopts legacy personal state into the user home', async () => {
    const store = new Store({ home: userHome });
    await store.ensureLayout();

    const projects = await store.listProjects();
    expect(projects).toEqual([
      expect.objectContaining({ id: 'shared-project', storageScope: 'machine-shared' }),
    ]);
    const gezels = await store.listGezels();
    expect(gezels).toEqual([
      expect.objectContaining({ id: 'ada', storageScope: 'machine-shared' }),
    ]);

    const session = await store.getSession('ada', 'legacy-session');
    expect(session?.messages[0]?.content).toBe('preserve this');
    expect(await store.readMemoryDay('gezel', 'ada', '2026-08-04')).toBe('legacy memory\n');
    expect(
      JSON.parse(
        await readFile(join(userHome, 'gezels', 'ada', '.machine-shared-import-v1.json'), 'utf8'),
      ),
    ).toMatchObject({ version: 1, sharedGezelId: 'ada' });

    await store.writeMemoryDay('gezel', 'ada', '2026-08-05', 'private memory\n');
    expect(
      await readFile(join(userHome, 'gezels', 'ada', 'memories', 'daily', '2026-08-05.md'), 'utf8'),
    ).toBe('private memory\n');
  });

  it('keeps new entities private and resolves collisions without touching shared definitions', async () => {
    const store = new Store({ home: userHome });
    await store.ensureLayout();
    const createdGezel = await store.createGezel({ name: 'Ada' });
    const createdProject = await store.createProject({ name: 'Shared Project' });

    expect(createdGezel.id).toBe('ada-2');
    expect(createdGezel.storageScope).toBeUndefined();
    expect(createdProject.id).toBe('shared-project-2');
    expect(createdProject.storageScope).toBeUndefined();
    expect(await readFile(join(sharedHome, 'gezels', 'ada', 'gezel.md'), 'utf8')).toContain(
      'name: "Ada"',
    );
  });

  it('renames a shared gezel without changing the cross-account id', async () => {
    const store = new Store({ home: userHome });
    await store.ensureLayout();
    const renamed = await store.renameGezel('ada', 'Ada Lovelace');
    expect(renamed).toMatchObject({
      id: 'ada',
      name: 'Ada Lovelace',
      storageScope: 'machine-shared',
    });
    expect(await store.getSession('ada', 'legacy-session')).not.toBeNull();
  });

  it('refuses account-local deletion of machine-shared entities', async () => {
    const store = new Store({ home: userHome });
    await store.ensureLayout();

    await expect(store.deleteGezel('ada')).rejects.toThrow(/cannot be removed/i);
    await expect(store.deleteProject('shared-project')).rejects.toMatchObject({
      reason: 'machine_shared',
    });
    expect(await store.getSession('ada', 'legacy-session')).not.toBeNull();
    expect(await store.getGezel('ada')).not.toBeNull();
    expect(await store.getProject('shared-project')).not.toBeNull();
  });
});
