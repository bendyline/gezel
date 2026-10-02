import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFileAtomic } from './atomic.js';

const fault = vi.hoisted(() => ({ stage: '' as '' | 'write' | 'publish' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const publishError = () => {
    if (fault.stage === 'publish')
      throw Object.assign(new Error('disk I/O failure'), { code: 'EIO' });
  };
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (fault.stage === 'write' && String(args[0]).includes('.tmp-')) {
        await fs.writeFile(args[0], 'partial staging bytes');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return fs.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      publishError();
      return fs.rename(...args);
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      publishError();
      return fs.link(...args);
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-atomic-failures-'));
});
afterEach(async () => {
  fault.stage = '';
  await rm(dir, { recursive: true, force: true });
});

it.each([
  { stage: 'write', noReplace: false, code: 'ENOSPC' },
  { stage: 'publish', noReplace: false, code: 'EIO' },
  { stage: 'write', noReplace: true, code: 'ENOSPC' },
  { stage: 'publish', noReplace: true, code: 'EIO' },
] as const)(
  'recovers from $stage failure (create only: $noReplace)',
  async ({ stage, noReplace, code }) => {
    const target = join(dir, 'state.json');
    if (!noReplace) await writeFile(target, '{"version":1}');
    fault.stage = stage;
    await expect(writeFileAtomic(target, '{"version":2}', { noReplace })).rejects.toMatchObject({
      code,
    });
    if (noReplace) await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ version: 1 });
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);

    fault.stage = '';
    await writeFileAtomic(target, '{"version":3}', { noReplace });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ version: 3 });
  },
);

it('ignores staging debris from an interrupted writer on the next write', async () => {
  const target = join(dir, 'state.json');
  const abandoned = `${target}.tmp-123-interrupted`;
  await writeFile(target, '{"version":1}');
  await writeFile(abandoned, '{"version":');
  await writeFileAtomic(target, '{"version":2}', { durable: true });
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ version: 2 });
  // Another writer's staging path is not ours to publish or remove.
  expect(await readFile(abandoned, 'utf8')).toBe('{"version":');
});
