import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cliUserDaemonEnv,
  describeMachineEngineBroker,
  ensureCliProjectLead,
  ensureProjectForFolder,
  fileTokenStorage,
  findHealthySystemService,
  isSystemProductServiceRole,
  normalizeServiceUrl,
  resolveCliAppId,
  resolveRunProject,
  resolveStartPortEnv,
  resolveTuiProject,
  shouldTrySystemService,
  validateGlobals,
} from './connection.js';

const originalHome = process.env.GEZEL_HOME;
const homes: string[] = [];

function makeClient(overrides: Partial<GezelClient>): GezelClient {
  return overrides as GezelClient;
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.GEZEL_HOME;
  else process.env.GEZEL_HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('system-service selection', () => {
  it('tries the machine service by default', () => {
    expect(shouldTrySystemService({}, {})).toBe(true);
  });

  it.each([
    [{ connect: 'https://example.test' }, {}],
    [{ standalone: true }, {}],
    [{ home: 'D:\\alternate' }, {}],
    [{}, { GEZEL_HOME: 'D:\\alternate' }],
    [{}, { GEZEL_DEV: '1' }],
  ])('skips the machine service for an explicit override', (globals, env) => {
    expect(shouldTrySystemService(globals, env)).toBe(false);
  });

  it('rejects contradictory or incomplete connection flags', () => {
    expect(() => validateGlobals({ connect: 'https://example.test', standalone: true })).toThrow(
      /cannot be used together/,
    );
    expect(() => validateGlobals({ token: 'secret' })).toThrow(/requires --connect/);
    expect(() => validateGlobals({ connect: 'not a url' })).toThrow(/Invalid --connect URL/);
  });

  it('normalizes explicit service URLs without accepting embedded credentials', () => {
    expect(normalizeServiceUrl('https://example.test:443/')).toBe('https://example.test');
    expect(() => normalizeServiceUrl('https://user:secret@example.test')).toThrow(
      /must not contain credentials/,
    );
  });

  it('uses only legacy full-product roles as CLI product endpoints', () => {
    expect(isSystemProductServiceRole(undefined)).toBe(true);
    expect(isSystemProductServiceRole('legacy-full')).toBe(true);
    expect(isSystemProductServiceRole('machine-engine')).toBe(false);
    expect(isSystemProductServiceRole('user')).toBe(false);
  });

  it.each(['machine-engine', 'user'] as const)(
    'skips a healthy %s system service so the caller falls through to the user daemon',
    async (serviceRole) => {
      const endpoint = {
        port: 6228,
        baseUrl: 'http://127.0.0.1:6228',
        cert: null,
        home: '/machine/gezel',
      };
      await expect(
        findHealthySystemService(
          {},
          {
            readEndpoint: async () => endpoint,
            probeHealth: async () => ({
              ok: true,
              version: 'test',
              serviceRole,
              startedAt: new Date(0).toISOString(),
            }),
          },
        ),
      ).resolves.toBeNull();
    },
  );

  it.each([undefined, 'legacy-full'] as const)(
    'keeps %s system-role compatibility as a product endpoint',
    async (serviceRole) => {
      const endpoint = {
        port: 6228,
        baseUrl: 'http://127.0.0.1:6228',
        cert: null,
        home: '/machine/gezel',
      };
      await expect(
        findHealthySystemService(
          {},
          {
            readEndpoint: async () => endpoint,
            probeHealth: async () => ({
              ok: true,
              version: 'test',
              ...(serviceRole ? { serviceRole } : {}),
              startedAt: new Date(0).toISOString(),
            }),
          },
        ),
      ).resolves.toEqual({
        port: endpoint.port,
        baseUrl: endpoint.baseUrl,
        home: endpoint.home,
        fetch: globalThis.fetch,
      });
    },
  );
});

describe('machine-engine broker reporting', () => {
  const endpoint = {
    port: 6228,
    baseUrl: 'https://127.0.0.1:6228',
    cert: null,
    home: '/machine/gezel',
  };

  it('reports absence when no machine service is registered', async () => {
    await expect(describeMachineEngineBroker({ readEndpoint: async () => null })).resolves.toEqual({
      present: false,
    });
  });

  it('reports a healthy machine-engine broker instead of "unavailable"', async () => {
    await expect(
      describeMachineEngineBroker({
        readEndpoint: async () => endpoint,
        probeHealth: async () => ({
          ok: true,
          version: '9.9.9',
          serviceRole: 'machine-engine',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    ).resolves.toMatchObject({
      present: true,
      healthy: true,
      port: 6228,
      serviceRole: 'machine-engine',
      version: '9.9.9',
    });
  });

  it('reports present-but-unreachable when the probe fails', async () => {
    await expect(
      describeMachineEngineBroker({
        readEndpoint: async () => endpoint,
        probeHealth: async () => {
          throw new Error('connection refused');
        },
      }),
    ).resolves.toMatchObject({ present: true, healthy: false, port: 6228 });
  });
});

describe('start-port selection', () => {
  it('hard-binds an explicit --port regardless of the machine service', () => {
    expect(resolveStartPortEnv(7000, true)).toBe('7000');
    expect(resolveStartPortEnv(7000, false)).toBe('7000');
  });

  it('stays ephemeral while a machine service holds the canonical port', () => {
    expect(resolveStartPortEnv(undefined, false)).toBe('0');
  });

  it('omits GEZEL_PORT (canonical preference) when no machine service exists', () => {
    expect(resolveStartPortEnv(undefined, true)).toBeUndefined();
  });
});

describe('interactive daemon environment', () => {
  it('forces a user-role ephemeral daemon and removes inherited service-host state', () => {
    expect(
      cliUserDaemonEnv('D:\\scratch\\gezel', false, {
        PATH: 'test-path',
        GEZEL_PORT: '6228',
        GEZEL_SERVICE_ROLE: 'machine-engine',
        GEZEL_SYSTEM_SCOPE: '1',
      }),
    ).toEqual({
      PATH: 'test-path',
      GEZEL_HOME: 'D:\\scratch\\gezel',
      GEZEL_PORT: '0',
      GEZEL_SERVICE_ROLE: 'user',
    });
  });

  it('leaves the port unset when the caller has reserved the canonical preference', () => {
    const env = cliUserDaemonEnv(undefined, true, { GEZEL_PORT: '7000' });
    expect(env.GEZEL_PORT).toBeUndefined();
    expect(env.GEZEL_SERVICE_ROLE).toBe('user');
  });
});

describe('CLI grant token storage', () => {
  it('uses a stable per-installation app id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-cli-id-'));
    homes.push(home);
    process.env.GEZEL_HOME = home;

    const first = await resolveCliAppId();
    const second = await resolveCliAppId();

    expect(first).toBe(second);
    expect(first).toMatch(/^gezel-cli\.[0-9a-f-]{36}$/);
  });

  it('persists tokens per logical target and supports SDK revocation cleanup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-cli-token-'));
    homes.push(home);
    process.env.GEZEL_HOME = home;

    const first = fileTokenStorage('https://127.0.0.1:6228');
    const second = fileTokenStorage('https://remote.example');
    await first.save('gezel-cli', 'local-token');
    await second.save('gezel-cli', 'remote-token');

    await expect(first.load('gezel-cli')).resolves.toBe('local-token');
    await expect(second.load('gezel-cli')).resolves.toBe('remote-token');
    await first.delete('gezel-cli');
    await expect(first.load('gezel-cli')).resolves.toBeNull();
    await expect(second.load('gezel-cli')).resolves.toBe('remote-token');
  });
});

describe('project folder resolution', () => {
  it('reuses a project whose working directory exactly matches the resolved folder', async () => {
    const folder = join(tmpdir(), 'gezel-cli-existing-project');
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        { id: 'elsewhere', name: 'Elsewhere', workingDir: join(tmpdir(), 'elsewhere') },
        { id: 'matching', name: 'Matching', workingDir: folder },
      ],
    });
    const createProject = vi.fn();
    const setProjectWorkingDir = vi.fn();
    const client = makeClient({ listProjects, createProject, setProjectWorkingDir });

    await expect(ensureProjectForFolder(client, folder)).resolves.toBe('matching');
    expect(createProject).not.toHaveBeenCalled();
    expect(setProjectWorkingDir).not.toHaveBeenCalled();
  });

  it('adopts a same-name orphan and binds it to the resolved folder', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'gezel-cli-project-parent-'));
    homes.push(parent);
    const folder = join(parent, 'customer-portal');
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        { id: 'unrelated', name: 'Other', workingDir: undefined },
        { id: 'orphan', name: 'customer-portal', workingDir: undefined },
      ],
    });
    const createProject = vi.fn();
    const setProjectWorkingDir = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ listProjects, createProject, setProjectWorkingDir });

    await expect(ensureProjectForFolder(client, folder)).resolves.toBe('orphan');
    expect(createProject).not.toHaveBeenCalled();
    expect(setProjectWorkingDir).toHaveBeenCalledWith('orphan', folder);
  });

  it('creates and binds a fully described project when no project matches', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'gezel-cli-project-create-'));
    homes.push(parent);
    const folder = join(parent, 'new-workspace');
    const listProjects = vi.fn().mockResolvedValue({ projects: [] });
    const createProject = vi.fn().mockResolvedValue({ id: 'created' });
    const setProjectWorkingDir = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ listProjects, createProject, setProjectWorkingDir });

    await expect(ensureProjectForFolder(client, folder)).resolves.toBe('created');
    expect(createProject).toHaveBeenCalledWith({
      name: 'new-workspace',
      description: `CLI workspace at ${folder}`,
      about: `new-workspace — working directory ${folder}. Fill in who this project is for, what's in scope, and what's explicitly out of scope.`,
      missionObjectives: 'new-workspace — fill in concrete success criteria for this project.',
      workingDir: folder,
    });
    expect(setProjectWorkingDir).not.toHaveBeenCalled();
  });
});

describe('command project semantics', () => {
  it.each([undefined, false] as const)(
    'uses the current directory for run when --project is %s',
    async (project) => {
      const listProjects = vi.fn().mockResolvedValue({
        projects: [{ id: 'cwd-project', name: 'cwd', workingDir: process.cwd() }],
      });
      const client = makeClient({ listProjects });

      await expect(resolveRunProject(client, { project })).resolves.toBe('cwd-project');
      expect(listProjects).toHaveBeenCalledOnce();
    },
  );

  it('uses the current directory for a bare run --project flag', async () => {
    const listProjects = vi.fn().mockResolvedValue({
      projects: [{ id: 'cwd-project', name: 'cwd', workingDir: process.cwd() }],
    });
    const client = makeClient({ listProjects });

    await expect(resolveRunProject(client, { project: true })).resolves.toBe('cwd-project');
  });

  it.each([undefined, true, false] as const)(
    'uses the current directory for the TUI when --project is %s',
    async (project) => {
      const listProjects = vi.fn().mockResolvedValue({
        projects: [{ id: 'cwd-project', name: 'cwd', workingDir: process.cwd() }],
      });
      const client = makeClient({ listProjects });

      await expect(resolveTuiProject(client, { project })).resolves.toBe('cwd-project');
    },
  );

  it('honors an explicit TUI project folder', async () => {
    const folder = join(tmpdir(), 'gezel-cli-explicit-tui-project');
    const listProjects = vi.fn().mockResolvedValue({
      projects: [{ id: 'explicit-project', name: 'explicit', workingDir: folder }],
    });
    const client = makeClient({ listProjects });

    await expect(resolveTuiProject(client, { project: folder })).resolves.toBe('explicit-project');
  });
});

describe('CLI project lead', () => {
  it('uses the project voorman instead of the install-wide Meester', async () => {
    const client = makeClient({
      getProject: vi.fn().mockResolvedValue({
        id: 'cwd-project',
        name: 'cwd',
        voormanGezelId: 'foreman',
      }),
    });

    await expect(ensureCliProjectLead(client, 'cwd-project')).resolves.toBe('foreman');
  });

  it('repairs an older project by assigning an existing voorman', async () => {
    const updateProject = vi.fn().mockResolvedValue({
      id: 'cwd-project',
      name: 'cwd',
      voormanGezelId: 'foreman',
    });
    const createGezelFromTemplate = vi.fn();
    const client = makeClient({
      getProject: vi.fn().mockResolvedValue({ id: 'cwd-project', name: 'cwd' }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'meester', name: 'Mira', role: 'Meester' },
          { id: 'foreman', name: 'Oier', role: 'Voorman' },
        ],
      }),
      createGezelFromTemplate,
      updateProject,
    });

    await expect(ensureCliProjectLead(client, 'cwd-project')).resolves.toBe('foreman');
    expect(updateProject).toHaveBeenCalledWith('cwd-project', {
      voormanGezelId: 'foreman',
    });
    expect(createGezelFromTemplate).not.toHaveBeenCalled();
  });

  it('uses a solo project gezel without recruiting a second lead', async () => {
    const listGezels = vi.fn();
    const client = makeClient({
      getProject: vi.fn().mockResolvedValue({
        id: 'game',
        name: 'Game',
        mode: 'solo',
        gezelIds: ['player'],
      }),
      listGezels,
    });

    await expect(ensureCliProjectLead(client, 'game')).resolves.toBe('player');
    expect(listGezels).not.toHaveBeenCalled();
  });
});
