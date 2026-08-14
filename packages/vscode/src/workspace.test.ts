import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import { ensureProjectForWorkspace, pathsEqual } from './workspace.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  show: () => {},
  dispose: () => {},
};

function makeFolder(fsPath: string) {
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    name: fsPath.split(/[\\/]/).pop() ?? '',
    index: 0,
  } as unknown as import('vscode').WorkspaceFolder;
}

function makeClient(overrides: Partial<GezelClient>): GezelClient {
  return overrides as GezelClient;
}

describe('pathsEqual', () => {
  it('treats trailing slashes as equivalent', () => {
    expect(pathsEqual('/a/b', '/a/b/')).toBe(true);
  });

  it('normalizes slashes', () => {
    expect(pathsEqual('/a/b', '\\a\\b')).toBe(true);
  });

  it('is case-insensitive on win32', () => {
    if (process.platform === 'win32') {
      expect(pathsEqual('C:/Users/Alice', 'c:/users/alice')).toBe(true);
    }
  });
});

describe('ensureProjectForWorkspace', () => {
  it('reuses an existing project that already points at this folder', async () => {
    const folder = makeFolder(process.cwd());
    const cwdNorm = process.cwd();
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        { id: 'p1', name: 'other', workingDir: '/elsewhere' },
        { id: 'p2', name: 'cwd', workingDir: cwdNorm },
      ],
    });
    const createProject = vi.fn();
    const setProjectWorkingDir = vi.fn();
    const client = makeClient({
      listProjects,
      createProject,
      setProjectWorkingDir,
    } as unknown as Partial<GezelClient>);

    const id = await ensureProjectForWorkspace(folder, client, noopLogger);

    expect(id).toBe('p2');
    expect(createProject).not.toHaveBeenCalled();
    expect(setProjectWorkingDir).not.toHaveBeenCalled();
  });

  it('adopts an orphan project with the matching name and patches its workingDir', async () => {
    const folder = makeFolder(process.cwd());
    const folderName = folder.name;
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        { id: 'p1', name: folderName, workingDir: undefined },
        { id: 'p2', name: 'unrelated', workingDir: '/x/y' },
      ],
    });
    const setProjectWorkingDir = vi.fn().mockResolvedValue({ id: 'p1' });
    const createProject = vi.fn();
    const client = makeClient({
      listProjects,
      createProject,
      setProjectWorkingDir,
    } as unknown as Partial<GezelClient>);

    const id = await ensureProjectForWorkspace(folder, client, noopLogger);

    expect(id).toBe('p1');
    expect(createProject).not.toHaveBeenCalled();
    expect(setProjectWorkingDir).toHaveBeenCalledWith('p1', expect.any(String));
  });

  it('creates a new folder-backed project when no match is found', async () => {
    const folder = makeFolder(process.cwd());
    const listProjects = vi.fn().mockResolvedValue({ projects: [] });
    const createProject = vi
      .fn()
      .mockResolvedValue({ id: 'p-new', name: folder.name, workingDir: undefined });
    const setProjectWorkingDir = vi.fn().mockResolvedValue({ id: 'p-new' });
    const client = makeClient({
      listProjects,
      createProject,
      setProjectWorkingDir,
    } as unknown as Partial<GezelClient>);

    const id = await ensureProjectForWorkspace(folder, client, noopLogger);

    expect(id).toBe('p-new');
    expect(createProject).toHaveBeenCalledTimes(1);
    const arg = createProject.mock.calls[0]![0] as {
      name: string;
      about: string;
      missionObjectives: string;
      mode: string;
      workingDir: string;
    };
    expect(arg.name).toBe(folder.name);
    expect(arg.mode).toBe('crew');
    expect(arg.workingDir).toBe(process.cwd());
    // Schema requires about ≥ 60 chars, missionObjectives ≥ 40 chars.
    expect(arg.about.length).toBeGreaterThanOrEqual(60);
    expect(arg.missionObjectives.length).toBeGreaterThanOrEqual(40);
    expect(setProjectWorkingDir).not.toHaveBeenCalled();
  });
});
