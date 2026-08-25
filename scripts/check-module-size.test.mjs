import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkModuleSizes, countLines } from './check-module-size.mjs';

async function makeFixture(files) {
  const rootDir = await mkdtemp(join(tmpdir(), 'gezel-module-size-'));
  for (const [path, lines] of Object.entries(files)) {
    const absolute = join(rootDir, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, 'const x = 1;\n'.repeat(lines));
  }
  return rootDir;
}

test('counts lines the way the guard reports them', () => {
  assert.equal(countLines('a\nb\nc\n'), 3);
  assert.equal(countLines('a\nb\nc'), 3);
  assert.equal(countLines(''), 0);
});

test('fails on a synthetic oversized file and passes a small one', async () => {
  const rootDir = await makeFixture({
    'packages/demo/src/huge.ts': 60,
    'packages/demo/src/small.ts': 10,
  });
  try {
    const failures = await checkModuleSizes({
      rootDir,
      threshold: 50,
      grandfathered: new Map(),
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /huge\.ts: 60 lines exceeds the 50-line threshold/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('enforces the grandfathered ceiling instead of the flat threshold', async () => {
  const rootDir = await makeFixture({
    'packages/demo/src/legacy.ts': 100,
    'packages/demo/src/runaway.ts': 121,
  });
  try {
    const failures = await checkModuleSizes({
      rootDir,
      threshold: 50,
      headroom: 1.1,
      grandfathered: new Map([
        ['packages/demo/src/legacy.ts', 100],
        ['packages/demo/src/runaway.ts', 100],
      ]),
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /runaway\.ts: 121 lines exceeds its grandfathered ceiling 110/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('ratchets down: a shrunken grandfathered file must lower its baseline', async () => {
  const rootDir = await makeFixture({ 'packages/demo/src/improved.ts': 70 });
  try {
    const failures = await checkModuleSizes({
      rootDir,
      threshold: 50,
      headroom: 1.1,
      grandfathered: new Map([['packages/demo/src/improved.ts', 100]]),
    });
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /improved\.ts: 70 lines is well under its baseline 100; lower the baseline to 70/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a grandfathered file that drops under the threshold must lose its entry', async () => {
  const rootDir = await makeFixture({ 'packages/demo/src/graduated.ts': 40 });
  try {
    const failures = await checkModuleSizes({
      rootDir,
      threshold: 50,
      grandfathered: new Map([['packages/demo/src/graduated.ts', 100]]),
    });
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /graduated\.ts: 40 lines is under the 50-line threshold; remove its grandfather entry/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('a stale grandfather entry for a deleted file fails', async () => {
  const rootDir = await makeFixture({ 'packages/demo/src/present.ts': 10 });
  try {
    const failures = await checkModuleSizes({
      rootDir,
      threshold: 50,
      grandfathered: new Map([['packages/demo/src/deleted.ts', 100]]),
    });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /deleted\.ts: grandfathered but no longer exists/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
