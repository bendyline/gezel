/**
 * The macOS floor has to cover the whole payload, including the Mach-Os
 * sealed inside service-bundle.tar.gz that a walk of the .app cannot see.
 * v1.26270.76 declared 13.5 while ONNX Runtime and sqlite-vec in that tarball
 * required 14.0.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

import {
  BUILDER_CONFIG,
  assertWithinFloor,
  compareVersions,
  declaredMacFloor,
  hasMachOMagic,
  machOMacMinimums,
  readMacMinimums,
  scanTarballMachOs,
} from './verify-macos-version-floor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const LC_UUID = 0x1b;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

function pack(version) {
  const [major, minor = 0, patch = 0] = version.split('.').map(Number);
  return (major << 16) | (minor << 8) | patch;
}

function command(cmd, words) {
  const bytes = Buffer.alloc(8 + words.length * 4);
  bytes.writeUInt32LE(cmd, 0);
  bytes.writeUInt32LE(bytes.length, 4);
  words.forEach((word, i) => bytes.writeUInt32LE(word, 8 + i * 4));
  return bytes;
}

/** A little-endian thin Mach-O image with the given load commands. */
function thinMachO(commands, { bits = 64 } = {}) {
  const all = [command(LC_UUID, [1, 2, 3, 4]), ...commands];
  const body = Buffer.concat(all);
  const header = Buffer.alloc(bits === 64 ? 32 : 28);
  header.writeUInt32LE(bits === 64 ? 0xfeedfacf : 0xfeedface, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(6, 12);
  header.writeUInt32LE(all.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, Buffer.alloc(32)]);
}

const buildVersion = (minos, platform = 1) =>
  command(LC_BUILD_VERSION, [platform, pack(minos), pack('15.0'), 0]);
const versionMin = (version) => command(LC_VERSION_MIN_MACOSX, [pack(version), pack(version)]);

/** A big-endian fat header with one slice per image, each 4 KiB aligned. */
function fatMachO(images) {
  const align = 4096;
  const header = Buffer.alloc(align);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(images.length, 4);
  const parts = [header];
  let offset = align;
  images.forEach((image, i) => {
    const entry = 8 + i * 20;
    header.writeUInt32BE(i === 0 ? 0x0100000c : 0x01000007, entry);
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(image.length, entry + 12);
    header.writeUInt32BE(12, entry + 16);
    const padded = Buffer.alloc(Math.ceil(image.length / align) * align);
    image.copy(padded);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
}

test('reads LC_BUILD_VERSION and LC_VERSION_MIN_MACOSX minimums', () => {
  assert.deepEqual(machOMacMinimums(thinMachO([buildVersion('14.0')])), {
    minima: ['14.0'],
    versioned: true,
  });
  assert.deepEqual(machOMacMinimums(thinMachO([versionMin('10.13.2')], { bits: 32 })), {
    minima: ['10.13.2'],
    versioned: true,
  });
});

test('reads every slice of a fat binary', () => {
  const universal = fatMachO([
    thinMachO([buildVersion('13.0')]),
    thinMachO([buildVersion('14.2')]),
  ]);
  assert.deepEqual(machOMacMinimums(universal), { minima: ['13.0', '14.2'], versioned: true });
  assert.throws(
    () => assertWithinFloor([{ path: 'universal.node', ...machOMacMinimums(universal) }], '14.0'),
    /universal\.node requires macOS 14\.2, newer than app floor 14\.0/,
  );
});

test('ignores what is not Mach-O, including Java class files', () => {
  assert.equal(machOMacMinimums(Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n')), null);
  assert.equal(machOMacMinimums(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])), null);
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);
  assert.equal(hasMachOMagic(javaClass), false);
  assert.equal(machOMacMinimums(javaClass), null);
});

test('a Mach-O without any minimum fails; one built for another platform is skipped', () => {
  const unversioned = machOMacMinimums(thinMachO([]));
  assert.deepEqual(unversioned, { minima: [], versioned: false });
  assert.throws(
    () => assertWithinFloor([{ path: 'bare.dylib', ...unversioned }], '14.0'),
    /bare\.dylib is Mach-O but exposes no minimum-version load command/,
  );
  const iosOnly = machOMacMinimums(thinMachO([buildVersion('17.0', 2)]));
  assert.deepEqual(iosOnly, { minima: [], versioned: true });
  assert.equal(assertWithinFloor([{ path: 'ios.dylib', ...iosOnly }], '14.0'), '0.0');
});

test('rejects truncated load commands instead of passing them', () => {
  const image = thinMachO([buildVersion('14.0')]);
  image.writeUInt32LE(40, 16);
  assert.throws(
    () => machOMacMinimums(image, 'broken.dylib'),
    /broken\.dylib: (truncated load commands|malformed load command)/,
  );
  assert.throws(
    () => machOMacMinimums(image.subarray(0, 40), 'cut.dylib'),
    /cut\.dylib: truncated load commands/,
  );
});

test('finds the Mach-Os inside a gzipped service tarball and enforces the floor', async () => {
  const work = await mkdtemp(join(tmpdir(), 'gezel-floor-'));
  try {
    const tree = join(work, 'tree');
    const vecDir = join(tree, 'node_modules', 'sqlite-vec-darwin-arm64');
    const ortDir = join(tree, 'node_modules', 'onnxruntime-node', 'bin');
    await mkdir(vecDir, { recursive: true });
    await mkdir(ortDir, { recursive: true });
    await writeFile(join(vecDir, 'vec0.dylib'), thinMachO([buildVersion('14.0')]));
    await writeFile(
      join(ortDir, 'onnxruntime_binding.node'),
      fatMachO([thinMachO([buildVersion('11.0')]), thinMachO([buildVersion('12.0')])]),
    );
    await writeFile(join(vecDir, 'package.json'), '{"name":"sqlite-vec-darwin-arm64"}');
    await writeFile(join(tree, 'tiny'), 'abc');
    const tarball = join(work, 'service-bundle.tar.gz');
    await tar.c({ gzip: true, file: tarball, cwd: tree, portable: true }, ['.']);

    const found = await scanTarballMachOs(tarball);
    assert.deepEqual(found.map(({ path, minima }) => [path.replace(/^\.\//, ''), minima]).sort(), [
      ['node_modules/onnxruntime-node/bin/onnxruntime_binding.node', ['11.0', '12.0']],
      ['node_modules/sqlite-vec-darwin-arm64/vec0.dylib', ['14.0']],
    ]);
    assert.throws(
      () => assertWithinFloor(found, '13.5'),
      /vec0\.dylib requires macOS 14\.0, newer than app floor 13\.5/,
    );
    assert.equal(assertWithinFloor(found, '14.0'), '14.0');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the declared product floor is macOS 14.0', async () => {
  assert.equal(declaredMacFloor(await readFile(BUILDER_CONFIG, 'utf8')), '14.0');
  assert.equal(declaredMacFloor("mac:\n  minimumSystemVersion: '15.1'\nlinux:\n"), '15.1');
  assert.throws(() => declaredMacFloor('mac:\n  icon: x\n'), /no mac\.minimumSystemVersion/);
});

test('the release job checks the signed app against the declared floor', async () => {
  const [workflow, builder] = await Promise.all([
    readFile(join(root, '.github', 'workflows', 'release-electron.yml'), 'utf8'),
    readFile(BUILDER_CONFIG, 'utf8'),
  ]);
  const passed = workflow.match(/node scripts\/verify-macos-version-floor\.mjs "\$app" (\S+)/)?.[1];
  assert.equal(passed, declaredMacFloor(builder));
});

test('the floor covers the ONNX Runtime prebuild the service tree ships for macOS', async (t) => {
  let binDir;
  try {
    const service = createRequire(join(root, 'packages', 'service', 'package.json'));
    const manifest = service.resolve('onnxruntime-node/package.json');
    binDir = join(dirname(manifest), 'bin', 'napi-v6', 'darwin', 'arm64');
  } catch {
    binDir = null;
  }
  if (!binDir || !existsSync(binDir)) {
    t.skip('onnxruntime-node darwin prebuilds are not installed in this checkout');
    return;
  }
  const floor = declaredMacFloor(await readFile(BUILDER_CONFIG, 'utf8'));
  const binaries = [];
  for (const name of await readdir(binDir)) {
    const result = machOMacMinimums(await readFile(join(binDir, name)), name);
    if (result) binaries.push({ path: name, ...result });
  }
  assert.ok(binaries.length > 0, `no Mach-O files under ${binDir}`);
  assert.equal(compareVersions(assertWithinFloor(binaries, floor), floor) <= 0, true);
});

test('parses vtool build-version output for the .app walk', () => {
  const output = [
    'Load command 9',
    '      cmd LC_BUILD_VERSION',
    '  cmdsize 32',
    ' platform MACOS',
    '    minos 13.5',
    '      sdk 15.0',
    'Load command 10',
    '      cmd LC_VERSION_MIN_MACOSX',
    '  cmdsize 16',
    '  version 12.0',
    '      sdk 12.3',
  ].join('\n');
  assert.deepEqual(readMacMinimums(output), ['13.5', '12.0']);
  assert.ok(compareVersions('14.0', '13.5') > 0);
  assert.equal(compareVersions('14', '14.0.0'), 0);
});
