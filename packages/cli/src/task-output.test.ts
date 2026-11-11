import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyTaskOutput,
  describeTaskOutput,
  formatTaskOutput,
  hostFolder,
  withCopiedOutput,
} from './task-output.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function client(paths: string[]) {
  return {
    listProjectArtifacts: async () => ({
      files: [
        { name: '12', path: 'tasks/12', isDirectory: true },
        ...paths.map((path) => ({ name: path.split('/').pop() ?? path, path, isDirectory: false })),
      ],
    }),
    fetchProjectArtifactBlob: async (_project: string, path: string) =>
      new Blob([`contents of ${path}`]),
  };
}

describe('copyTaskOutput', () => {
  it("copies the task's files, keeping their folders, and leaves its inputs behind", async () => {
    const out = await mkdtemp(join(tmpdir(), 'gezel-out-'));
    dirs.push(out);
    const copied = await copyTaskOutput(
      client(['tasks/12/report.md', 'tasks/12/charts/q3.png', 'tasks/12/inputs/source/notes.txt']),
      'p1',
      'tasks/12',
      out,
    );
    expect(copied.sort()).toEqual(['charts/q3.png', 'report.md']);
    expect(await readFile(join(out, 'report.md'), 'utf8')).toBe('contents of tasks/12/report.md');
    expect(await readdir(out)).not.toContain('inputs');
  });

  it('never writes outside the folder it was given', async () => {
    const out = await mkdtemp(join(tmpdir(), 'gezel-out-'));
    dirs.push(out);
    const copied = await copyTaskOutput(
      client(['tasks/12/../../escape.txt', 'tasks/13/other.md']),
      'p1',
      'tasks/12',
      out,
    );
    expect(copied).toEqual([]);
  });
});

/** The README example's task: summarize-long gates scope, summary and verdict. */
function summarizeTask(): Task {
  return {
    projectId: 'work2',
    num: 1,
    ref: 'work2/1',
    artifactDir: 'tasks/1',
    craftbook: {
      steps: [
        { id: 'scope', advanceWhen: { file: 'tasks/1/scope.md', artifact: true } },
        { id: 'summarize', advanceWhen: { file: 'tasks/1/summary.md', artifact: true } },
        { id: 'evaluate', advanceWhen: { file: 'tasks/1/verdict.md', artifact: true } },
        { id: 'finish', terminal: true },
      ],
    },
  } as unknown as Task;
}

const HOME_FOLDER = 'C:\\Users\\you\\.gezel\\projects\\work2\\artifacts\\tasks\\1';

/** A service that lists the task folder and knows where each file lives on its host. */
function serviceWith(drawerFiles: string[], locations: Record<string, string>) {
  return {
    listProjectArtifacts: async () => ({
      files: drawerFiles.map((path) => ({
        name: path.split('/').pop() ?? path,
        path,
        isDirectory: false,
      })),
    }),
    resolveReferenceFileLocation: async (
      _project: string,
      file: { kind: 'artifact' | 'workspace' | 'document'; path: string },
    ) => {
      const path = locations[`${file.kind}:${file.path}`];
      if (!path) throw new Error('not found');
      return { path };
    },
  };
}

const readmeService = () =>
  serviceWith(
    ['tasks/1/scope.md', 'tasks/1/summary.md', 'tasks/1/verdict.md', 'tasks/1/inputs/notes.txt'],
    {
      'artifact:tasks/1/scope.md': `${HOME_FOLDER}\\scope.md`,
      'artifact:tasks/1/summary.md': `${HOME_FOLDER}\\summary.md`,
      'artifact:tasks/1/verdict.md': `${HOME_FOLDER}\\verdict.md`,
    },
  );

describe('describeTaskOutput', () => {
  it("names the book's promised result first, with the service's absolute paths", async () => {
    const output = await describeTaskOutput(readmeService(), summarizeTask(), async () => true);
    expect(output.folder).toBe(HOME_FOLDER);
    expect(output.files).toEqual([
      {
        kind: 'artifact',
        relativePath: 'tasks/1/summary.md',
        path: `${HOME_FOLDER}\\summary.md`,
        readable: true,
        deliverable: true,
      },
      {
        kind: 'artifact',
        relativePath: 'tasks/1/scope.md',
        path: `${HOME_FOLDER}\\scope.md`,
        readable: true,
        deliverable: false,
      },
      {
        kind: 'artifact',
        relativePath: 'tasks/1/verdict.md',
        path: `${HOME_FOLDER}\\verdict.md`,
        readable: true,
        deliverable: false,
      },
    ]);

    const shown = formatTaskOutput(output, 'work2/1');
    expect(shown.lines).toEqual([
      `Result: ${HOME_FOLDER}\\summary.md`,
      'Also made: scope.md, verdict.md',
      `Folder: ${HOME_FOLDER}`,
    ]);
    expect(shown.hint).toBe('Copy them next to you with `gezel task wait work2/1 --out <folder>`.');
  });

  it('does not offer paths this computer cannot open, and says how to copy them', async () => {
    const output = await describeTaskOutput(readmeService(), summarizeTask(), async () => false);
    expect(output.files[0]).toMatchObject({ path: `${HOME_FOLDER}\\summary.md`, readable: false });
    const shown = formatTaskOutput(output, 'work2/1');
    expect(shown.lines).toEqual([
      'Result: tasks/1/summary.md, kept by the Gezel service',
      'Also made: scope.md, verdict.md',
    ]);
    expect(shown.hint).toBe(
      'They are kept by the Gezel service; copy them here with `gezel task wait work2/1 --out <folder>`.',
    );
  });

  it('finds a result saved into the project folder, and skips a promise the run never kept', async () => {
    const task = summarizeTask();
    task.craftbook.steps = [
      { id: 'draft', advanceWhen: { file: 'tasks/1/never-made.pdf', artifact: true } },
      { id: 'deliver', advanceWhen: { file: 'decks/board.pptx' } },
    ] as unknown as Task['craftbook']['steps'];
    const service = serviceWith(['tasks/1/outline.md'], {
      'workspace:decks/board.pptx': 'D:\\work\\decks\\board.pptx',
      'artifact:tasks/1/outline.md': `${HOME_FOLDER}\\outline.md`,
    });
    const output = await describeTaskOutput(service, task, async () => true);
    expect(output.files.map((file) => [file.kind, file.relativePath, file.deliverable])).toEqual([
      ['workspace', 'decks/board.pptx', true],
      ['artifact', 'tasks/1/outline.md', false],
    ]);
    expect(formatTaskOutput(output, 'work2/1').lines).toEqual([
      'Result: D:\\work\\decks\\board.pptx',
      'Also made: outline.md',
      `Folder: ${HOME_FOLDER}`,
    ]);
  });

  it('after --out, points at the copies and drops the copy hint', async () => {
    const output = await describeTaskOutput(readmeService(), summarizeTask(), async () => false);
    const out = resolve('board-summary');
    const shown = formatTaskOutput(withCopiedOutput(output, 'board-summary'), 'work2/1', {
      copied: true,
    });
    expect(shown.lines).toEqual([
      `Result: ${join(out, 'summary.md')}`,
      'Also made: scope.md, verdict.md',
      `Folder: ${out}`,
    ]);
    expect(shown.hint).toBeNull();
  });

  it('a task that made nothing says nothing extra', async () => {
    const task = { ...summarizeTask(), craftbook: { steps: [] } } as unknown as Task;
    const output = await describeTaskOutput(serviceWith([], {}), task, async () => true);
    expect(formatTaskOutput(output, 'work2/1')).toEqual({ lines: [], hint: null });
  });
});

describe('hostFolder', () => {
  it("reads the folder from either separator, however deep the file's name is", () => {
    expect(hostFolder('C:\\h\\tasks\\1\\charts\\q3.png', 'charts/q3.png')).toBe('C:\\h\\tasks\\1');
    expect(hostFolder('/data/projects/p/artifacts/tasks/1/report.md', 'report.md')).toBe(
      '/data/projects/p/artifacts/tasks/1',
    );
    expect(hostFolder(null, 'report.md')).toBeNull();
  });
});
