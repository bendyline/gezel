import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyNativeFileTree } from './native-file-manifest-lib.mjs';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const generator = join(here, 'generate-native-file-manifests.mjs');
const buildNativeWorkflow = join(here, '..', '.github', 'workflows', 'build-native.yml');
const releaseElectronWorkflow = join(here, '..', '.github', 'workflows', 'release-electron.yml');
const electronBuilderConfig = join(here, '..', 'packages', 'app', 'electron-builder.yml');

test(
  'generator records an internal SONAME chain separately from concrete files',
  { skip: process.platform === 'win32' },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
    try {
      const root = join(temp, 'native');
      const dir = join(root, 'darwin-arm64');
      const output = join(temp, 'NATIVE_FILE_MANIFESTS.json');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'libgezel.1.2.3.dylib'), 'shared library fixture');
      await symlink('libgezel.1.2.3.dylib', join(dir, 'libgezel.1.dylib'));
      await symlink('libgezel.1.dylib', join(dir, 'libgezel.dylib'));
      await writeFile(join(dir, 'gezel-fixture-server'), 'executable fixture');
      await chmod(join(dir, 'gezel-fixture-server'), 0o755);

      await execFileP(process.execPath, [
        generator,
        '--root',
        root,
        '--version',
        'native-v9.9.9',
        '--out',
        output,
      ]);

      const manifest = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.release, '9.9.9');
      assert.deepEqual(Object.keys(manifest.platforms['darwin-arm64'].files), [
        'gezel-fixture-server',
        'libgezel.1.2.3.dylib',
      ]);
      assert.deepEqual(manifest.platforms['darwin-arm64'].symlinks, {
        'libgezel.1.dylib': 'libgezel.1.2.3.dylib',
        'libgezel.dylib': 'libgezel.1.dylib',
      });

      const verified = await verifyNativeFileTree({
        root,
        manifest,
        expectedRelease: '9.9.9',
      });
      assert.deepEqual(verified, {
        platformCount: 1,
        fileCount: 2,
        symlinkCount: 2,
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  'generator rejects a symlink that escapes its platform directory',
  { skip: process.platform === 'win32' },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
    try {
      const root = join(temp, 'native');
      const dir = join(root, 'linux-x64');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'libgezel.so.1'), 'shared library fixture');
      await symlink('../outside.so', join(dir, 'libgezel.so'));

      await assert.rejects(
        execFileP(process.execPath, [
          generator,
          '--root',
          root,
          '--version',
          '9.9.9',
          '--out',
          join(temp, 'manifest.json'),
        ]),
        /unsafe native symlink target/,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  'generator rejects a dangling internal symlink',
  { skip: process.platform === 'win32' },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
    try {
      const root = join(temp, 'native');
      const dir = join(root, 'linux-x64');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'libgezel-real.so'), 'shared library fixture');
      await symlink('libgezel-missing.so', join(dir, 'libgezel.so'));

      await assert.rejects(
        execFileP(process.execPath, [
          generator,
          '--root',
          root,
          '--version',
          '9.9.9',
          '--out',
          join(temp, 'manifest.json'),
        ]),
        /does not terminate at a pinned regular file/,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test('generator rejects an empty native root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
  try {
    await assert.rejects(
      execFileP(process.execPath, [
        generator,
        '--root',
        temp,
        '--version',
        '9.9.9',
        '--out',
        join(temp, 'manifest.json'),
      ]),
      /contains no platform entries/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('native release generates the link-aware manifest before packing archives', async () => {
  const workflow = await readFile(buildNativeWorkflow, 'utf8');
  const generate = workflow.indexOf('      - name: Generate per-file native integrity manifest');
  const pack = workflow.indexOf('      - name: Pack tarballs');
  assert.notEqual(generate, -1, 'native workflow has no manifest-generation step');
  assert.notEqual(pack, -1, 'native workflow has no archive-packing step');
  assert.ok(generate < pack, 'native links must be validated before expensive archive packing');

  const archiveGate = workflow.slice(
    workflow.indexOf('      - name: Validate release archive set'),
    workflow.indexOf('      - name: Generate SHA256SUMS'),
  );
  assert.match(archiveGate, /-name '\*\.tar\.gz' -o -name '\*\.zip'/);
  assert.doesNotMatch(
    archiveGate,
    /find release -maxdepth 1 -type f -printf/,
    'the archive gate must not mistake NATIVE_FILE_MANIFESTS.json for an archive',
  );
});

test('Electron packaging preserves and verifies source-pinned native bytes', async () => {
  const [config, workflow] = await Promise.all([
    readFile(electronBuilderConfig, 'utf8'),
    readFile(releaseElectronWorkflow, 'utf8'),
  ]);

  assert.match(
    config,
    /signIgnore:\s*\n\s+- \/Contents\/Resources\/app\\\.asar\\\.unpacked\/native-bin\//,
  );
  assert.match(workflow, /expected\+=\('SHA256SUMS' 'NATIVE_FILE_MANIFESTS\.json'\)/);
  assert.equal(
    workflow.match(
      /node scripts\/verify-native-file-manifest\.mjs \\\s+--root packages\/app\/native-bin/g,
    )?.length,
    3,
    'every platform must verify its staged native tree',
  );
  assert.equal(
    workflow.match(/--native-source packages\/app\/native-bin/g)?.length,
    3,
    'every finished installer type must verify its packaged native tree',
  );
});
