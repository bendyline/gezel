import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const script = join(here, 'format-release-manifest.mjs');

const RELEASE_SERIALIZED_MANIFEST = `{
  "name": "@bendyline/example",
  "version": "1.2.3",
  "files": [
    "dist",
    "!dist/**/*.map"
  ]
}
`;

test('normalizes a semantic-release manifest with the repository Biome config', async () => {
  const packageDir = await mkdtemp(join(repoRoot, '.release-manifest-test-'));
  const manifestPath = join(packageDir, 'package.json');
  try {
    await writeFile(manifestPath, RELEASE_SERIALIZED_MANIFEST);

    await execFileP(process.execPath, [script], { cwd: packageDir });

    assert.match(
      await readFile(manifestPath, 'utf8'),
      /"files": \["dist", "!dist\/\*\*\/\*\.map"\]/,
    );
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test('formats a package’s server.json with its manifest', async () => {
  const packageDir = await mkdtemp(join(repoRoot, '.release-server-json-test-'));
  const serverPath = join(packageDir, 'server.json');
  try {
    await writeFile(join(packageDir, 'package.json'), RELEASE_SERIALIZED_MANIFEST);
    await writeFile(
      serverPath,
      `${JSON.stringify({ name: 'com.example/example', choices: ['a', 'b'] }, null, 2)}\n`,
    );

    await execFileP(process.execPath, [script], { cwd: packageDir });

    assert.match(await readFile(serverPath, 'utf8'), /"choices": \["a", "b"\]/);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test('dry run leaves the release manifest untouched', async () => {
  const packageDir = await mkdtemp(join(repoRoot, '.release-manifest-dry-run-test-'));
  const manifestPath = join(packageDir, 'package.json');
  try {
    await writeFile(manifestPath, RELEASE_SERIALIZED_MANIFEST);

    const { stdout } = await execFileP(process.execPath, [script], {
      cwd: packageDir,
      env: { ...process.env, GEZEL_RELEASE_DRY_RUN: '1' },
    });

    assert.match(stdout, /\[dry run\] would format/);
    assert.equal(await readFile(manifestPath, 'utf8'), RELEASE_SERIALIZED_MANIFEST);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});
