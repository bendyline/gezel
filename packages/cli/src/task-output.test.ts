import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyTaskOutput } from './task-output.js';

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
