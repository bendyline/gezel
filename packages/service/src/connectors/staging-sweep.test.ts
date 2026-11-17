import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepConnectorStaging } from './staging-sweep.js';

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('sweepConnectorStaging', () => {
  it('removes old connector staging folders and leaves fresh and foreign ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-sweep-test-'));
    const old = Date.now() / 1000 - 7 * 3600;
    for (const name of ['gezel-drive-files-abc', 'gezel-github-releases-def']) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'big.bin'), 'x');
      await utimes(join(dir, name), old, old);
    }
    await mkdir(join(dir, 'gezel-graph-files-live'));
    await mkdir(join(dir, 'someone-elses-folder'));
    await utimes(join(dir, 'someone-elses-folder'), old, old);
    await writeFile(join(dir, 'gezel-drive-files-not-a-dir'), 'x');

    expect(await sweepConnectorStaging({ dir })).toBe(2);
    expect((await readdir(dir)).sort()).toEqual([
      'gezel-drive-files-not-a-dir',
      'gezel-graph-files-live',
      'someone-elses-folder',
    ]);
  });

  it('a missing temp directory is not an error', async () => {
    expect(await sweepConnectorStaging({ dir: '/nonexistent/gezel-sweep' })).toBe(0);
  });
});
