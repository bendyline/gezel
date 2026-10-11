import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { identityChanges } from '../api-campaign/identity.ts';
import { serviceBuildIdentity, treeIdentity } from './metadata.ts';
import { isEvalInputPath } from './source-identity.ts';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('measurement identity', () => {
  it('does not turn unit tests and temporary files into live evaluator fixtures', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-fixtures-'));
    const options = {
      includeManifest: true,
      includePath: (path: string) => isEvalInputPath(`evals/src/${path}`),
    };
    await writeFile(join(dir, 'prompt.md'), 'brief');
    const before = await treeIdentity(dir, options);
    await writeFile(join(dir, 'unit.test.ts'), 'test');
    await writeFile(join(dir, 'runner.ts.tmp'), 'temporary');
    await mkdir(join(dir, 'tmp'));
    await writeFile(join(dir, 'tmp/scratch.ts'), 'scratch');
    expect(await treeIdentity(dir, options)).toEqual(before);
    await rm(join(dir, 'unit.test.ts'));
    expect(await treeIdentity(dir, options)).toEqual(before);
    await writeFile(join(dir, 'prompt.md'), 'changed brief');
    expect((await treeIdentity(dir, options)).sha256).not.toBe(before.sha256);
  });
  it('hashes filenames and contents deterministically, rather than mtimes or file counts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-identity-'));
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'b'), 'same size');
    await writeFile(join(dir, 'nested', 'a'), 'fixture');
    const first = await treeIdentity(dir);
    expect(first.files).toBe(2);
    await writeFile(join(dir, 'b'), 'same size');
    expect(await treeIdentity(dir)).toEqual(first);
    await writeFile(join(dir, 'b'), 'new bytes');
    expect((await treeIdentity(dir)).sha256).not.toBe(first.sha256);
  });

  it('keeps a service build stable as imports create, rewrite and remove source-backed bytecode', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-bytecode-'));
    await writeFile(join(dir, 'worker.py'), 'answer = 42');
    const baseline = await serviceBuildIdentity(dir);
    const raw = await treeIdentity(dir);
    const cache = join(dir, '__pycache__');
    await mkdir(cache);
    const pyc = join(cache, 'worker.cpython-311.pyc');
    await writeFile(pyc, 'first compiled bytes');
    expect(await serviceBuildIdentity(dir)).toEqual(baseline);
    expect(await treeIdentity(dir)).not.toEqual(raw);
    await writeFile(pyc, 'regenerated compiled bytes');
    await writeFile(join(cache, 'worker.cpython-311.opt-2.pyc'), 'optimized');
    await writeFile(join(dir, 'worker.pyc'), 'legacy adjacent cache');
    expect(await serviceBuildIdentity(dir)).toEqual(baseline);
    await rm(cache, { recursive: true });
    await rm(join(dir, 'worker.pyc'));
    expect(await serviceBuildIdentity(dir)).toEqual(baseline);
  });

  it('retains real Python, JavaScript and asset changes with diagnostic paths', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-service-'));
    for (const name of ['worker.py', 'entry.js', 'image.bin'])
      await writeFile(join(dir, name), 'old');
    const baseline = await serviceBuildIdentity(dir);
    await writeFile(join(dir, 'worker.py'), 'new');
    await writeFile(join(dir, 'entry.js'), 'new');
    await rm(join(dir, 'image.bin'));
    await writeFile(join(dir, 'added.bin'), 'new');
    const next = await serviceBuildIdentity(dir);
    expect(next.sha256).not.toBe(baseline.sha256);
    expect(identityChanges({ service: baseline }, { service: next })).toEqual([
      { component: 'service', paths: ['added.bin', 'entry.js', 'image.bin', 'worker.py'] },
    ]);
  });

  it('does not ignore sourceless bytecode or arbitrary cache-directory contents', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-sourceless-'));
    const cache = join(dir, '__pycache__');
    await mkdir(cache);
    await writeFile(join(cache, 'orphan.cpython-311.pyc'), 'executable bytes');
    await writeFile(join(cache, 'payload.js'), 'executable script');
    await writeFile(join(dir, 'orphan.pyc'), 'legacy executable');
    const baseline = await serviceBuildIdentity(dir);
    expect(baseline.files).toBe(3);
    await writeFile(join(cache, 'orphan.cpython-311.pyc'), 'different executable bytes');
    expect((await serviceBuildIdentity(dir)).sha256).not.toBe(baseline.sha256);
  });

  it('detects removal of the source behind an ignored cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qualification-removed-source-'));
    await mkdir(join(dir, '__pycache__'));
    await writeFile(join(dir, 'worker.py'), 'answer = 42');
    await writeFile(join(dir, '__pycache__', 'worker.cpython-311.pyc'), 'cache');
    const before = await serviceBuildIdentity(dir);
    await rm(join(dir, 'worker.py'));
    const after = await serviceBuildIdentity(dir);
    expect(after.sha256).not.toBe(before.sha256);
    expect(Object.keys(after.manifest!)).toEqual([join('__pycache__', 'worker.cpython-311.pyc')]);
  });
});
