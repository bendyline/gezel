import { describe, expect, it, vi } from 'vitest';
import { createEntityResolvers } from './entity-resolvers.js';

type Api = Parameters<typeof createEntityResolvers>[0]['api'];

const PROJECTS = [
  { id: 'pet-store', name: 'Pet Store Prototype' },
  { id: 'ship-eval', name: 'Ship Eval' },
];
const GEZELS = [
  { id: 'ada', name: 'Ada', roleBasedName: 'developer' },
  { id: 'kanon', name: 'Kanon' },
];

function fakeApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    getProject: vi.fn(async (id: string) => {
      const project = PROJECTS.find((p) => p.id === id);
      if (!project) throw new Error(`GET /api/projects/${id} failed: 404`);
      return project;
    }),
    listProjects: vi.fn(async () => ({ projects: PROJECTS })),
    getGezel: vi.fn(async (id: string) => {
      throw new Error(`GET /api/gezels/${id} failed: 404`);
    }),
    listGezels: vi.fn(async () => ({ gezels: GEZELS })),
    ...overrides,
  };
  return api;
}

function resolvers(api: ReturnType<typeof fakeApi>, sessionTaskRef = '') {
  return createEntityResolvers({
    api: api as unknown as Api,
    projectId: 'ship-eval',
    sessionTaskRef,
  });
}

describe('resolveProjectId', () => {
  it('returns an id the service knows without listing projects', async () => {
    const api = fakeApi();
    await expect(resolvers(api).resolveProjectId('pet-store')).resolves.toBe('pet-store');
    expect(api.listProjects).not.toHaveBeenCalled();
  });

  it('accepts the display name a model saw in chat, in any case', async () => {
    const api = fakeApi();
    await expect(resolvers(api).resolveProjectId('pet store prototype')).resolves.toBe('pet-store');
  });

  it("resolves to the session's own project when its token may not list projects", async () => {
    const api = fakeApi({
      listProjects: vi.fn(async () => {
        throw new Error('GET /api/projects failed: 403 Forbidden');
      }),
    });
    await expect(resolvers(api).resolveProjectId('Ship Eval')).resolves.toBe('ship-eval');
  });

  it('passes on any other listing failure', async () => {
    const api = fakeApi({
      listProjects: vi.fn(async () => {
        throw new Error('GET /api/projects failed: 500');
      }),
    });
    await expect(resolvers(api).resolveProjectId('Ship Eval')).rejects.toThrow('500');
  });

  it('names the real ids on a miss, and start_work only when the session has it', async () => {
    const r = resolvers(fakeApi());
    const plain = await r.resolveProjectId('Garden Planner').catch((err: Error) => err.message);
    expect(plain).toContain('"pet-store" (Pet Store Prototype)');
    expect(plain).not.toContain('start_work');
    const withLauncher = await r
      .resolveProjectId('Garden Planner', ['start_work'])
      .catch((err: Error) => err.message);
    expect(withLauncher).toContain('start_work');
  });
});

describe('resolveGezelId', () => {
  it('answers from the roster before getGezel can echo the casing back', async () => {
    const api = fakeApi({ getGezel: vi.fn(async (id: string) => ({ id })) });
    await expect(resolvers(api).resolveGezelId('ADA')).resolves.toBe('ada');
    await expect(resolvers(api).resolveGezelId('developer')).resolves.toBe('ada');
    expect(api.getGezel).not.toHaveBeenCalled();
  });

  it('falls back to getGezel for a gezel the roster does not list', async () => {
    const api = fakeApi({ getGezel: vi.fn(async (id: string) => ({ id })) });
    await expect(resolvers(api).resolveGezelId('pet-store--scout')).resolves.toBe(
      'pet-store--scout',
    );
  });

  it('names the roster when no one matches', async () => {
    await expect(resolvers(fakeApi()).resolveGezelId('Grace')).rejects.toThrow(
      /gezel "Grace" not found\. Available: "ada" \(Ada, role: developer\), "kanon" \(Kanon\)/,
    );
  });
});

describe('availableGezelsHint', () => {
  it('lists the roster', async () => {
    await expect(resolvers(fakeApi()).availableGezelsHint()).resolves.toContain('"kanon" (Kanon)');
  });

  it('points at list_gezels when the roster cannot be read', async () => {
    const api = fakeApi({
      listGezels: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(resolvers(api).availableGezelsHint()).resolves.toBe(
      'Call `list_gezels` for the roster.',
    );
  });
});

describe('parseRef', () => {
  it('keeps a canonical ref without a lookup', async () => {
    const api = fakeApi();
    await expect(resolvers(api).parseRef('pet-store/3')).resolves.toEqual({
      projectId: 'pet-store',
      num: 3,
    });
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it('resolves a project half written as the display name', async () => {
    await expect(resolvers(fakeApi()).parseRef('Pet Store Prototype/3')).resolves.toEqual({
      projectId: 'pet-store',
      num: 3,
    });
  });

  it("reads a bare number as a task in the session's project", async () => {
    await expect(resolvers(fakeApi(), 'pet-store/1').parseRef('#2')).resolves.toEqual({
      projectId: 'pet-store',
      num: 2,
    });
  });
});
