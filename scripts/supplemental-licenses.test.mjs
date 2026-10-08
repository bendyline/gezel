/**
 * The v1.26270.76 Windows installer carried Microsoft's proprietary
 * DirectML.dll inside onnxruntime-node with no licence text at all, and ONNX
 * Runtime itself under a generated MIT text naming its npm publisher. Nothing
 * failed, because the legal bundle only knew what package.json files declare.
 * These tests pin the three layers that now stop that: the reviewed manifest,
 * the staging scan, and the packaged-bundle verifier.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { stageDependencyLicenses } from './stage-third-party-licenses.mjs';
import {
  LICENSED_BINARY_RULES,
  SUPPLEMENTAL_LICENSES_ROOT,
  findLicensedBinaries,
  loadSupplementalLicenses,
  packageLicenseCoverage,
} from './supplemental-licenses.mjs';
import { verifySupplementalAssignments } from './verify-packaged-licenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Resolved through node_modules links rather than require.resolve: several of
// these packages do not export ./package.json. pnpm-workspace.yaml publicly
// hoists *onnxruntime*, so those live at the root rather than under ml-runtime.
function installedPackageDir(name) {
  for (const modules of [
    join(root, 'packages', 'ml-runtime', 'node_modules'),
    join(root, 'node_modules'),
  ]) {
    const path = join(modules, ...name.split('/'));
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error(`${name} is not installed`);
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakePackage(dir, name, version, files = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

test('the manifest texts are the recorded bytes and DirectML is marked proprietary', async () => {
  const supplemental = await loadSupplementalLicenses();
  for (const text of supplemental.texts.values()) {
    assert.equal(sha256(await readFile(text.path)), text.sha256, text.file);
  }
  const ort = supplemental.npmPackages.get('onnxruntime-node');
  assert.ok(ort, 'onnxruntime-node must stay covered while it ships');
  const directml = ort.components.find((component) => component.id === 'directml');
  assert.equal(directml?.proprietary, true);
  assert.deepEqual(directml.texts, [
    'LICENSE-directml.txt',
    'NOTICE-directml-ThirdPartyNotices.txt',
  ]);
  const licence = await readFile(join(SUPPLEMENTAL_LICENSES_ROOT, 'LICENSE-directml.txt'), 'utf8');
  assert.match(licence, /^MICROSOFT SOFTWARE LICENSE TERMS\nMICROSOFT DIRECTX MACHINE LEARNING/);
  assert.equal(
    licence.includes('\r'),
    false,
    'stored texts are LF so git cannot change their digest',
  );
});

test('every rule-matched binary in the installed ONNX Runtime packages is covered', async () => {
  const supplemental = await loadSupplementalLicenses();
  const packages = ['onnxruntime-node', 'onnxruntime-web'].map((name) => [
    name,
    installedPackageDir(name),
  ]);
  for (const [name, packagePath] of packages) {
    const { version } = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'));
    const coverage = await packageLicenseCoverage({ name, version, packagePath }, supplemental);
    assert.deepEqual(coverage.problems, [], `${name}@${version}`);
    assert.ok(coverage.texts.length > 0, `${name}@${version} gets supplemental texts`);
  }
  // Transformers.js 4.x loads the WebAssembly builds from onnxruntime-web and
  // copies none into its own dist, so it must carry no licensed binary.
  assert.deepEqual(
    await findLicensedBinaries(installedPackageDir('@huggingface/transformers')),
    [],
  );
  const node = await findLicensedBinaries(packages[0][1]);
  assert.ok(
    node.some((binary) => binary.path.endsWith('win32/x64/DirectML.dll')),
    'the scan must see the DirectML.dll the Windows installer ships',
  );
});

test('the binary rules match every shipped spelling and nothing unrelated', () => {
  const component = (name) =>
    LICENSED_BINARY_RULES.find((rule) => rule.pattern.test(name))?.component ?? null;
  assert.equal(component('DirectML.dll'), 'directml');
  assert.equal(component('directml.debug.dll'), 'directml');
  assert.equal(component('dxil.dll'), 'directx-shader-compiler');
  assert.equal(component('dxcompiler.dll'), 'directx-shader-compiler');
  assert.equal(component('onnxruntime.dll'), 'onnxruntime');
  assert.equal(component('libonnxruntime.so.1'), 'onnxruntime');
  assert.equal(component('libonnxruntime.1.24.3.dylib'), 'onnxruntime');
  assert.equal(component('ort-wasm-simd-threaded.jsep.wasm'), 'onnxruntime');
  assert.equal(component('libonnxruntime_providers_cuda.so'), 'onnxruntime-gpu-providers');
  assert.equal(component('onnxruntime_providers_dml.dll'), 'onnxruntime-gpu-providers');
  assert.equal(component('onnxruntime_binding.node'), null);
  assert.equal(component('d3dcompiler_47.dll'), null);
});

test('coverage fails for an unreviewed carrier, a moved version, or a missing binary', async (t) => {
  const supplemental = await loadSupplementalLicenses();
  const dir = await tempDir(t, 'gezel-supplemental-');

  const stowaway = await fakePackage(join(dir, 'stowaway'), 'stowaway', '1.0.0', {
    'prebuilds/win32-x64/DirectML.dll': 'binary',
  });
  const unreviewed = await packageLicenseCoverage(
    { name: 'stowaway', version: '1.0.0', packagePath: stowaway },
    supplemental,
  );
  assert.match(
    unreviewed.problems.join('\n'),
    /prebuilds\/win32-x64\/DirectML\.dll \(Microsoft DirectML\)/,
  );

  const reviewedVersion = supplemental.npmPackages.get('onnxruntime-node').version;
  const ort = await fakePackage(join(dir, 'ort'), 'onnxruntime-node', '9.9.9');
  const moved = await packageLicenseCoverage(
    { name: 'onnxruntime-node', version: '9.9.9', packagePath: ort },
    supplemental,
  );
  assert.ok(moved.problems.join('\n').includes(`reviewed for ${reviewedVersion}`));

  const hollow = await fakePackage(join(dir, 'hollow'), 'onnxruntime-node', reviewedVersion);
  const missing = await packageLicenseCoverage(
    { name: 'onnxruntime-node', version: reviewedVersion, packagePath: hollow },
    supplemental,
  );
  assert.match(
    missing.problems.join('\n'),
    /declares bin\/napi-v6\/win32\/x64\/DirectML\.dll, which is absent/,
  );
  assert.doesNotMatch(
    missing.problems.join('\n'),
    /providers_cuda/,
    'a binary only linux-x64 install scripts fetch may be absent elsewhere',
  );

  const fetched = await fakePackage(join(dir, 'fetched'), 'stowaway', '1.0.0', {
    'bin/linux/x64/libonnxruntime_providers_cuda.so': 'binary',
  });
  const provider = await packageLicenseCoverage(
    { name: 'stowaway', version: '1.0.0', packagePath: fetched },
    supplemental,
  );
  assert.match(provider.problems.join('\n'), /ONNX Runtime execution provider/);
});

test('the manifest rejects an edited text and an unlisted file', async (t) => {
  const dir = await tempDir(t, 'gezel-supplemental-root-');
  const copy = join(dir, 'licenses');
  await cp(SUPPLEMENTAL_LICENSES_ROOT, copy, { recursive: true });
  await writeFile(join(copy, 'LICENSE-directml.txt'), 'edited\n');
  await assert.rejects(() => loadSupplementalLicenses(copy), /does not match its recorded sha256/);

  await cp(SUPPLEMENTAL_LICENSES_ROOT, copy, { recursive: true, force: true });
  await writeFile(join(copy, 'LICENSE-unreviewed.txt'), 'text\n');
  await assert.rejects(() => loadSupplementalLicenses(copy), /missing from manifest\.json/);
});

function inventoryFor(name, version, path) {
  return { MIT: [{ name, versions: [version], paths: [path] }] };
}

test('staging refuses a DirectML carrier and attaches the reviewed texts to a covered one', async (t) => {
  const dir = await tempDir(t, 'gezel-stage-supplemental-');
  const supplemental = await loadSupplementalLicenses();

  const stowaway = await fakePackage(join(dir, 'pkg', 'stowaway'), 'stowaway', '1.0.0', {
    LICENSE: 'MIT License\n',
    'bin/DirectML.dll': 'binary',
  });
  await assert.rejects(
    () =>
      stageDependencyLicenses(join(dir, 'out-a'), inventoryFor('stowaway', '1.0.0', stowaway), {
        supplemental,
      }),
    /stowaway@1\.0\.0: ships bin\/DirectML\.dll \(Microsoft DirectML\)/,
  );

  const ortPath = installedPackageDir('onnxruntime-node');
  const { version } = JSON.parse(await readFile(join(ortPath, 'package.json'), 'utf8'));
  const out = join(dir, 'out-b');
  await stageDependencyLicenses(out, inventoryFor('onnxruntime-node', version, ortPath), {
    supplemental,
  });
  const manifest = JSON.parse(await readFile(join(out, 'npm', 'manifest.json'), 'utf8'));
  const record = manifest.packages.find((pkg) => pkg.name === 'onnxruntime-node');
  assert.equal(record.generatedFallback, false, 'the reviewed MIT text replaces the generated one');
  const staged = new Set(record.texts.map((text) => text.sha256));
  for (const file of ['LICENSE-onnxruntime-MIT.txt', 'LICENSE-directml.txt']) {
    assert.ok(staged.has(supplemental.texts.get(file).sha256), `${file} was not staged`);
  }
  assert.ok(
    record.texts.some((text) => text.supplemental === 'legal/licenses/LICENSE-directml.txt'),
  );
});

test('the bundle verifier rejects an onnxruntime-node entry without the DirectML terms', async (t) => {
  const dir = await tempDir(t, 'gezel-verify-supplemental-');
  await cp(SUPPLEMENTAL_LICENSES_ROOT, join(dir, 'standards'), { recursive: true });
  const supplemental = await loadSupplementalLicenses();
  const entry = supplemental.npmPackages.get('onnxruntime-node');
  const texts = entry.components
    .flatMap((component) => component.texts)
    .map((file) => ({ sha256: supplemental.texts.get(file).sha256 }));
  const record = { name: 'onnxruntime-node', version: entry.version, texts };

  await verifySupplementalAssignments(dir, { packages: [record] });
  const directml = supplemental.texts.get('LICENSE-directml.txt').sha256;
  await assert.rejects(
    () =>
      verifySupplementalAssignments(dir, {
        packages: [{ ...record, texts: texts.filter((text) => text.sha256 !== directml) }],
      }),
    /ships DirectML without LICENSE-directml\.txt/,
  );
  await assert.rejects(
    () => verifySupplementalAssignments(dir, { packages: [{ ...record, version: '0.0.1' }] }),
    /reviewed for/,
  );
});

test('the NOTICE inventory records the reviewed DirectML version', async () => {
  const supplemental = await loadSupplementalLicenses();
  const { version } = supplemental.npmPackages
    .get('onnxruntime-node')
    .components.find((component) => component.id === 'directml');
  const notice = await readFile(join(root, 'NOTICE.md'), 'utf8');
  assert.ok(
    notice.includes(
      `| **DirectML** (\`DirectML.dll\`, Windows only) | \`onnxruntime-node\` | \`${version}\` |`,
    ),
    'the carried-binaries table must name the reviewed DirectML version',
  );
});
