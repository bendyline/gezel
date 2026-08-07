import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession, InstalledToolset, Question, TerminalThread } from '@bendyline/gezel';
import {
  MACHINE_SHARED_MARKER,
  fallbackProjectIndexDir,
  projectContentIndexDbFile,
  projectHistoryFile,
  projectMemoryIndexDir,
  projectQuestionsFile,
  projectScriptsDir,
  projectTerminalsDir,
  projectToolsetsFile,
} from '@bendyline/gezel/paths';
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

  it('keeps runtime state account-private while project memories follow the shared project', async () => {
    const userAHome = join(root, 'user-a');
    const userBHome = join(root, 'user-b');
    const userA = new Store({ home: userAHome });
    const userB = new Store({ home: userBHome });
    await userA.ensureLayout();
    await userB.ensureLayout();

    // Pre-fix installs left executable selection and package bytes in this
    // cross-account-writable location. New daemons must ignore them.
    const forgedToolset: InstalledToolset = {
      toolsetId: 'docblocks',
      sourceId: 'bundled',
      version: '2.0.0',
      installedAt: '2026-08-04T10:00:00.000Z',
      installPath: join(sharedHome, 'projects', 'shared-project', 'toolsets', 'forged'),
      runtime: {
        kind: 'npm-package',
        package: '@bendyline/docblocks-cli',
        version: '2.0.0',
        sha256: 'd4e71b41dfd4ae5f90abac45a163c8dd9d5f5b01393f6237968ab5db205ce1f1',
        entry: 'dist/index.js',
        args: ['mcp'],
        envHints: [],
      },
    };
    await writeFile(
      join(sharedHome, 'projects', 'shared-project', 'toolsets.json'),
      `${JSON.stringify([forgedToolset])}\n`,
    );
    expect(
      await userA.listInstalledToolsets({ kind: 'project', projectId: 'shared-project' }),
    ).toEqual([]);

    await userA.writeInstalledToolsets({ kind: 'project', projectId: 'shared-project' }, [
      forgedToolset,
    ]);
    expect(
      await userB.listInstalledToolsets({ kind: 'project', projectId: 'shared-project' }),
    ).toEqual([]);
    expect(projectToolsetsFile(userAHome, 'shared-project')).toBe(
      join(userAHome, 'projects', 'shared-project', 'toolsets.json'),
    );

    const question: Question = {
      id: 'only-user-a-can-answer',
      projectId: 'shared-project',
      gezelId: 'ada',
      sessionId: 'user-a-session',
      prompt: 'Allow this tool?',
      choices: ['Allow', 'Deny'],
      allowWriteIn: false,
      multiSelect: false,
      intent: { kind: 'tool-permission', toolName: 'shell', toolInput: {} },
      createdAt: '2026-08-04T10:00:00.000Z',
    };
    await writeFile(
      join(sharedHome, 'projects', 'shared-project', 'questions.json'),
      `${JSON.stringify([{ ...question, id: 'forged-shared-answer' }])}\n`,
    );
    expect(await userA.getQuestion('shared-project', 'forged-shared-answer')).toBeNull();
    await userA.writeQuestion(question);
    expect(await userA.getQuestion('shared-project', question.id)).not.toBeNull();
    expect(await userB.getQuestion('shared-project', question.id)).toBeNull();

    const terminal: TerminalThread = {
      version: 1,
      id: '_root',
      projectId: 'shared-project',
      workingDir: '',
      createdAt: '2026-08-04T10:00:00.000Z',
      lastActivityAt: '2026-08-04T10:00:00.000Z',
      messages: [],
    };
    await userA.writeTerminalThread(terminal);
    expect(await userB.getTerminalThread('shared-project', terminal.id)).toBeNull();

    await userA.writeProjectActivity('shared-project', {
      lastActivityAt: '2026-08-04T10:00:00.000Z',
    });
    expect(await userB.readProjectActivity('shared-project')).toBeNull();

    // Canonical memory prose belongs to the project, so both accounts see it.
    await userA.writeMemoryDay('project', 'shared-project', '2026-08-04', 'shared memory\n');
    expect(await userB.readMemoryDay('project', 'shared-project', '2026-08-04')).toBe(
      'shared memory\n',
    );
    // Its mutable vector index does not.
    expect(projectMemoryIndexDir(userAHome, 'shared-project')).toBe(
      join(userAHome, 'projects', 'shared-project', 'memories', 'index'),
    );
    expect(userA.memoryIndexDir('project', 'shared-project')).not.toBe(
      userB.memoryIndexDir('project', 'shared-project'),
    );
    const sharedWorkspace = await userA.projectWorkspaceDir('shared-project');
    expect(projectContentIndexDbFile(userAHome, 'shared-project', sharedWorkspace)).toBe(
      join(userAHome, 'projects', 'shared-project', 'index', 'index.db'),
    );

    for (const privatePath of [
      projectHistoryFile(userAHome, 'shared-project'),
      projectQuestionsFile(userAHome, 'shared-project'),
      projectTerminalsDir(userAHome, 'shared-project'),
      projectScriptsDir(userAHome, 'shared-project'),
      fallbackProjectIndexDir(userAHome, 'shared-project'),
    ]) {
      expect(privatePath.startsWith(join(userAHome, 'projects', 'shared-project'))).toBe(true);
      expect(privatePath.startsWith(sharedHome)).toBe(false);
    }
    expect(existsSync(join(sharedHome, 'projects', 'shared-project', 'questions.json'))).toBe(true);
    expect(existsSync(join(sharedHome, 'projects', 'shared-project', 'terminals'))).toBe(false);
  });
  // Regression: v1.26219.45 could not be installed over any machine whose
  // broker had ever booted. `ensureLayout` created the product scopes for
  // every role, so a machine-engine daemon mounting the shared tree recreated
  // `gezels/` and `projects/` under its own home and let
  // adoptMachineSharedGezelPrivateState fill them with per-entity stubs. The
  // installer's migration then saw legacy and shared both populated and
  // divergent, refused, and abandoned the machine-service registration.
  it('creates no product state when serving the machine-engine role', async () => {
    process.env.GEZEL_MACHINE_SHARED_HOME = sharedHome;
    const brokerHome = join(root, 'broker');
    const broker = new Store({ home: brokerHome, serviceRole: 'machine-engine' });
    await broker.ensureLayout();

    // Operational directories it genuinely owns.
    expect(existsSync(join(brokerHome, 'runtime'))).toBe(true);
    expect(existsSync(join(brokerHome, 'logs'))).toBe(true);

    // Product scopes it must never own — these are exactly the paths the
    // installer's migrate-legacy-shared step drains into `shared/`.
    for (const scope of ['gezels', 'projects', 'documents']) {
      expect(existsSync(join(brokerHome, scope))).toBe(false);
    }
    // And no adopted per-entity stubs for the shared entities.
    expect(existsSync(join(brokerHome, 'gezels', 'ada'))).toBe(false);
    expect(existsSync(join(brokerHome, 'projects', 'shared-project'))).toBe(false);
  });

  it('still builds the full product layout for a user daemon', async () => {
    const home = join(root, 'user-role');
    await new Store({ home, serviceRole: 'user' }).ensureLayout();
    for (const scope of ['gezels', 'projects', 'runtime', 'logs']) {
      expect(existsSync(join(home, scope))).toBe(true);
    }
  });
});
