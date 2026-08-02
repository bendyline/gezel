import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const DECLARATION = "export const GEZEL_VERSION = '0.0.0';\n";

/** A throwaway repo root holding a copy of the script and a core source file. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gezel-prepare-package-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true });
  await mkdir(join(root, 'packages', 'cli'), { recursive: true });
  await copyFile(join(here, 'prepare-package.mjs'), join(root, 'scripts', 'prepare-package.mjs'));
  await writeFile(join(root, 'packages', 'core', 'src', 'index.ts'), DECLARATION);
  return root;
}

const script = (root) => join(root, 'scripts', 'prepare-package.mjs');
const dryRun = { GEZEL_RELEASE_DRY_RUN: '1' };

async function run(root, cwd, args, env = {}) {
  return execFileP('node', [script(root), ...args], {
    cwd: join(root, cwd),
    env: { ...process.env, ...env },
  });
}

test('does nothing for a package that is not core', async () => {
  const root = await fixture();
  try {
    const { stdout } = await run(root, 'packages/cli', ['1.2.3']);
    assert.equal(stdout.trim(), '');
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a missing or malformed version argument', async () => {
  const root = await fixture();
  try {
    for (const args of [[], ['not-a-version'], ['1.2']]) {
      await assert.rejects(
        () => run(root, 'packages/core', args, dryRun),
        (err) => err.code === 1 && /expected a version argument/.test(err.stderr),
        `expected rejection for ${JSON.stringify(args)}`,
      );
    }
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails loudly when the GEZEL_VERSION declaration has drifted', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'packages', 'core', 'src', 'index.ts'),
      'export const GEZEL_VERSION = "0.0.0";\n',
    );
    await assert.rejects(
      () => run(root, 'packages/core', ['1.2.3'], dryRun),
      (err) => err.code === 1 && /could not find GEZEL_VERSION declaration/.test(err.stderr),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry run reports the stamp without writing or rebuilding', async () => {
  const root = await fixture();
  try {
    const { stdout } = await run(root, 'packages/core', ['1.2.3'], dryRun);
    assert.match(stdout, /would stamp GEZEL_VERSION = '1\.2\.3'/);
    assert.equal(await readFile(join(root, 'packages/core/src/index.ts'), 'utf8'), DECLARATION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the release config still wires prepareCmd at this script', async () => {
  // A dropped hook is the exact failure this script exists to prevent: the
  // release succeeds and every published package reports 0.0.0 forever.
  const config = JSON.parse(await readFile(join(here, '..', '.releaserc.json'), 'utf8'));
  const exec = config.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/exec',
  );
  assert.ok(exec, '@semantic-release/exec is not configured');
  assert.match(
    exec[1].prepareCmd ?? '',
    /scripts\/prepare-package\.mjs \$\{nextRelease\.version\}/,
  );
  assert.match(exec[1].publishCmd ?? '', /scripts\/publish-package\.mjs/);
});

test('the real core source carries the declaration the script rewrites', async () => {
  const source = await readFile(join(here, '..', 'packages', 'core', 'src', 'index.ts'), 'utf8');
  assert.match(source, /export const GEZEL_VERSION = '[^']*';/);
});
