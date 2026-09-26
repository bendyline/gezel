import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GezelApiError } from './api-error.js';
import { ensureProjectForFolder } from './ensure-project-for-folder.js';

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-epf-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    inferProjectForPath: vi.fn(),
    listProjects: vi.fn(async () => ({
      projects: [] as Array<{ id: string; name: string; workingDir?: string }>,
    })),
    setProjectWorkingDir: vi.fn(async () => ({})),
    createProject: vi.fn(async () => ({ id: 'created-1' })),
    ...overrides,
  };
}

describe('ensureProjectForFolder', () => {
  it('asks the daemon with kind folder and returns its project', async () => {
    const client = fakeClient({
      inferProjectForPath: vi.fn(async () => ({ project: { id: 'p1' }, created: true })),
    });
    const res = await ensureProjectForFolder(client as never, dir, {
      mode: 'crew',
      source: 'vscode',
      about: 'about text',
    });
    expect(res).toEqual({ projectId: 'p1', created: true });
    expect(client.inferProjectForPath).toHaveBeenCalledWith({
      path: dir,
      kind: 'folder',
      mode: 'crew',
      source: 'vscode',
      about: 'about text',
    });
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it('rethrows a forbidden-root refusal instead of creating anyway', async () => {
    const client = fakeClient({
      inferProjectForPath: vi.fn(async () => {
        throw new GezelApiError('no', 403, { code: 'forbidden_root', reason: 'user-home' });
      }),
    });
    await expect(
      ensureProjectForFolder(client as never, dir, { mode: 'solo', source: 'cli' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it('falls back to the legacy algorithm against a daemon without the route', async () => {
    const client = fakeClient({
      inferProjectForPath: vi.fn(async () => {
        throw new GezelApiError('Not Found', 404, '404 Not Found');
      }),
      listProjects: vi.fn(async () => ({
        projects: [{ id: 'orphan', name: dir.split('/').pop()! }],
      })),
    });
    const res = await ensureProjectForFolder(client as never, dir, { mode: 'solo', source: 'cli' });
    expect(res).toEqual({ projectId: 'orphan', created: false });
    expect(client.setProjectWorkingDir).toHaveBeenCalledWith('orphan', dir);
  });

  it('does not fall back when the daemon says the folder is missing', async () => {
    const client = fakeClient({
      inferProjectForPath: vi.fn(async () => {
        throw new GezelApiError('folder not found', 404, { code: 'path_not_found' });
      }),
    });
    await expect(
      ensureProjectForFolder(client as never, join(dir, 'missing'), {
        mode: 'solo',
        source: 'cli',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(client.listProjects).not.toHaveBeenCalled();
  });

  it('uses the legacy algorithm for a client without inferProjectForPath', async () => {
    const client = fakeClient({
      inferProjectForPath: undefined,
      listProjects: vi.fn(async () => ({
        projects: [{ id: 'match', name: 'x', workingDir: dir }],
      })),
    });
    const res = await ensureProjectForFolder(client as never, dir, { mode: 'solo', source: 'cli' });
    expect(res).toEqual({ projectId: 'match', created: false });
  });
});
