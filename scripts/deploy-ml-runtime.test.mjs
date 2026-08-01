/**
 * The ML-runtime merge folds a second pnpm deploy into an already-deployed
 * bundle. Both trees come out of one content-addressable store, so on a
 * filesystem pnpm hardlinks into (Linux ext4 — but not APFS, which clones)
 * shared dependencies arrive as one inode under two names, and `fs.cp` fails
 * those with EINVAL. That shape is invisible on a macOS workstation and broke
 * only the packaged-bundle CI job.
 */
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeNodeModules } from './deploy-ml-runtime.mjs';

test('merges a staged graph over hardlinked twins of already-deployed files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-ml-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = join(root, 'staging', 'node_modules');
  const target = join(root, 'bundle', 'node_modules');
  await mkdir(join(source, '@types', 'node'), { recursive: true });
  await mkdir(join(source, 'kokoro-js'), { recursive: true });
  await mkdir(join(target, '@types', 'node'), { recursive: true });

  // The shared dep: one store entry, hardlinked into both trees.
  await writeFile(join(source, '@types', 'node', 'path.d.ts'), 'declare module "path";\n');
  await link(
    join(source, '@types', 'node', 'path.d.ts'),
    join(target, '@types', 'node', 'path.d.ts'),
  );
  // A sibling inside the same scope directory that only the staged graph has.
  await writeFile(join(source, '@types', 'node', 'fs.d.ts'), 'declare module "fs";\n');
  // A package the bundle does not carry at all.
  await writeFile(join(source, 'kokoro-js', 'package.json'), '{"name":"kokoro-js"}\n');
  // Bundle-only content in a shared scope must survive the merge.
  await mkdir(join(target, '@types', 'react'), { recursive: true });
  await writeFile(join(target, '@types', 'react', 'index.d.ts'), 'declare module "react";\n');

  await mergeNodeModules(source, target);

  assert.equal(
    await readFile(join(target, '@types', 'node', 'fs.d.ts'), 'utf8'),
    'declare module "fs";\n',
  );
  assert.equal(
    await readFile(join(target, 'kokoro-js', 'package.json'), 'utf8'),
    '{"name":"kokoro-js"}\n',
  );
  assert.equal(
    await readFile(join(target, '@types', 'node', 'path.d.ts'), 'utf8'),
    'declare module "path";\n',
  );
  assert.equal(
    await readFile(join(target, '@types', 'react', 'index.d.ts'), 'utf8'),
    'declare module "react";\n',
  );
});

test('overwrites a deployed file whose staged twin is a different inode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-ml-merge-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = join(root, 'staging', 'node_modules', 'kokoro-js');
  const target = join(root, 'bundle', 'node_modules', 'kokoro-js');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(source, 'package.json'), '{"version":"2"}\n');
  await writeFile(join(target, 'package.json'), '{"version":"1"}\n');

  await mergeNodeModules(
    join(root, 'staging', 'node_modules'),
    join(root, 'bundle', 'node_modules'),
  );

  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"version":"2"}\n');
});
