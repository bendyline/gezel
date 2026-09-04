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
const windowsSignHook = join(here, '..', 'packages', 'app', 'scripts', 'sign.cjs');
const fetchNativeBinaries = join(here, 'fetch-native-binaries.mjs');

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

test(
  'an executable-bit data sidecar stays out of the pinned set',
  { skip: process.platform === 'win32' },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
    try {
      const root = join(temp, 'native');
      const dir = join(root, 'darwin-arm64-metal');
      const output = join(temp, 'NATIVE_FILE_MANIFESTS.json');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'gezel-llama-server'), 'executable fixture');
      await chmod(join(dir, 'gezel-llama-server'), 0o755);
      // 0644, exactly as the engine build writes its metadata sidecar.
      await writeFile(join(dir, 'gezel-llama-build.json'), '{"schemaVersion":1}\n');

      await execFileP(process.execPath, [
        generator,
        '--root',
        root,
        '--version',
        '9.9.9',
        '--out',
        output,
      ]);

      const manifest = JSON.parse(await readFile(output, 'utf8'));
      assert.deepEqual(Object.keys(manifest.platforms['darwin-arm64-metal'].files), [
        'gezel-llama-server',
      ]);

      // Staging restores the exec bits that zip re-packing drops. A sidecar
      // caught by that pass must not read back as an unpinned binary.
      await chmod(join(dir, 'gezel-llama-build.json'), 0o755);
      const verified = await verifyNativeFileTree({ root, manifest, expectedRelease: '9.9.9' });
      assert.deepEqual(verified, { platformCount: 1, fileCount: 1, symlinkCount: 0 });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test('staging does not mark native sidecar data executable', async () => {
  const source = await readFile(fetchNativeBinaries, 'utf8');
  assert.match(
    source,
    /if \(!f\.endsWith\('\.exe'\) && !isNativeDataFile\(f\)\) \{/,
    'the staging chmod must classify sidecars through the manifest predicate',
  );
});

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

test('native manifest grants vendor-hash-only only at the reviewed native path', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gezel-native-manifest-'));
  try {
    const root = join(temp, 'native');
    const dir = join(root, 'win32-x64');
    const output = join(temp, 'manifest.json');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'uv.exe'), 'vendor uv fixture');
    await writeFile(join(dir, 'nested', 'uv.exe'), 'same basename, wrong path');

    await execFileP(process.execPath, [
      generator,
      '--root',
      root,
      '--version',
      '9.9.9',
      '--out',
      output,
    ]);

    const files = JSON.parse(await readFile(output, 'utf8')).platforms['win32-x64'].files;
    assert.equal(files['uv.exe'].signature, 'vendor-hash-only');
    assert.equal(files['nested/uv.exe'].signature, 'bendyline');
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
  const [config, workflow, signHook] = await Promise.all([
    readFile(electronBuilderConfig, 'utf8'),
    readFile(releaseElectronWorkflow, 'utf8'),
    readFile(windowsSignHook, 'utf8'),
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

  const preserveValidSignature = signHook.indexOf('if (isValidlySigned(configuration.path))');
  const signTarget = signHook.lastIndexOf('signFile(configuration.path);');
  assert.notEqual(
    preserveValidSignature,
    -1,
    'the Windows sign hook must detect already-valid native signatures',
  );
  assert.ok(
    preserveValidSignature < signTarget,
    'the Windows sign hook must preserve a valid signature before its fallback signing pass',
  );
  assert.match(
    signHook.slice(preserveValidSignature, signTarget),
    /return;/,
    'the valid-signature guard must return without changing source-pinned native bytes',
  );
});
