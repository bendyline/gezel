/**
 * Pin the packaged Electron fuse configuration from both ends: the
 * `electronFuses` block electron-builder applies, and the release job that
 * reads the wire back out of every packaged binary.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_FUSES,
  FUSE_ORDER,
  assertExpectedFuses,
  fuseCarrierPath,
  readFuseWires,
} from './verify-electron-fuses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const builderPath = join(root, 'packages', 'app', 'electron-builder.yml');
const workflowPath = join(root, '.github', 'workflows', 'release-electron.yml');

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
/** Electron 43's stock wire: RunAsNode, NODE_OPTIONS and --inspect all on. */
const STOCK_WIRE = '101100011';
const PACKAGED_WIRE = '100000011';

function binaryWith(...wires) {
  const parts = [Buffer.from('\x7fELF-ish prefix bytes')];
  for (const wire of wires) {
    parts.push(Buffer.from(SENTINEL, 'ascii'), Buffer.from([1, wire.length]));
    parts.push(Buffer.from(wire, 'ascii'), Buffer.from('trailing code'));
  }
  return Buffer.concat(parts);
}

/** The `electronFuses:` block as `key -> boolean`. */
function builderFuses(builder) {
  const block = builder.match(/^electronFuses:\n((?: {2}.*\n)+)/m);
  assert.ok(block, 'electron-builder.yml has no top-level electronFuses block');
  const fuses = new Map();
  for (const line of block[1].split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const match = /^ {2}([A-Za-z]+):\s*(true|false)\s*$/.exec(line);
    assert.ok(match, `unexpected electronFuses line: ${line}`);
    fuses.set(match[1], match[2] === 'true');
  }
  return fuses;
}

test('reads every fuse by name from the wire', () => {
  const [wire] = readFuseWires(binaryWith(STOCK_WIRE));
  assert.equal(Object.keys(wire).length, STOCK_WIRE.length);
  assert.equal(wire.runAsNode, 'enabled');
  assert.equal(wire.enableCookieEncryption, 'disabled');
  assert.equal(wire.enableNodeOptionsEnvironmentVariable, 'enabled');
  assert.equal(wire.enableNodeCliInspectArguments, 'enabled');
  assert.equal(wire.grantFileProtocolExtraPrivileges, 'enabled');
  assert.equal(FUSE_ORDER[2], 'enableNodeOptionsEnvironmentVariable');
});

test('a stock Electron wire fails and names each fuse left open', () => {
  assert.throws(
    () => assertExpectedFuses(readFuseWires(binaryWith(STOCK_WIRE)), 'stock'),
    (error) =>
      /enableNodeOptionsEnvironmentVariable is enabled/.test(error.message) &&
      /enableNodeCliInspectArguments is enabled/.test(error.message) &&
      !/runAsNode/.test(error.message),
  );
});

test('the packaged wire passes, and so must every slice of a universal binary', () => {
  assertExpectedFuses(readFuseWires(binaryWith(PACKAGED_WIRE)), 'packaged');
  assertExpectedFuses(readFuseWires(binaryWith(PACKAGED_WIRE, PACKAGED_WIRE)), 'universal');
  assert.throws(
    () => assertExpectedFuses(readFuseWires(binaryWith(PACKAGED_WIRE, STOCK_WIRE)), 'mixed'),
    /wire 2 of 2/,
  );
});

test('turning runAsNode off fails: the daemon and installers run Electron as Node', () => {
  assert.throws(
    () => assertExpectedFuses(readFuseWires(binaryWith('000000011')), 'no-run-as-node'),
    /runAsNode is disabled, expected enabled/,
  );
});

test('rejects binaries without a readable wire', () => {
  assert.throws(() => readFuseWires(Buffer.from('no sentinel here')), /no Electron fuse wire/);
  const wrongVersion = Buffer.concat([
    Buffer.from(SENTINEL, 'ascii'),
    Buffer.from([2, 1]),
    Buffer.from('1'),
  ]);
  assert.throws(() => readFuseWires(wrongVersion), /unsupported fuse wire version 2/);
  const badState = Buffer.concat([Buffer.from(SENTINEL, 'ascii'), Buffer.from([1, 1, 0x7a])]);
  assert.throws(() => readFuseWires(badState), /unknown state byte/);
});

test('macOS keeps the wire in the Electron Framework binary', () => {
  const framework = join(
    'Gezel.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  );
  assert.equal(fuseCarrierPath('Gezel.app'), framework);
  assert.equal(fuseCarrierPath('Gezel.app/Contents/MacOS/Gezel'), framework);
  assert.equal(fuseCarrierPath('win-unpacked/gezel.exe'), 'win-unpacked/gezel.exe');
});

test('electron-builder.yml declares exactly the verified fuse set', async () => {
  const declared = builderFuses(await readFile(builderPath, 'utf8'));
  assert.deepEqual(
    Object.fromEntries(declared),
    Object.fromEntries([...EXPECTED_FUSES].map(([name, { enabled }]) => [name, enabled])),
  );
});

test('release CI reads the fuse wire from every packaged platform binary', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(
    workflow,
    /node scripts\/verify-electron-fuses\.mjs packages\/app\/dist\/installers\/win-unpacked\/gezel\.exe/,
  );
  assert.match(workflow, /node scripts\/verify-electron-fuses\.mjs "\$app"/);
  assert.match(workflow, /-path '\*-unpacked\/gezel'[\s\S]{0,120}verify-electron-fuses\.mjs/);
});

test('the reader understands the Electron binary this checkout builds against', async (t) => {
  let binary;
  try {
    binary = createRequire(join(root, 'packages', 'app', 'package.json'))('electron');
  } catch {
    binary = null;
  }
  if (typeof binary !== 'string' || !existsSync(fuseCarrierPath(binary))) {
    t.skip('Electron is not installed in this checkout');
    return;
  }
  const wires = readFuseWires(await readFile(fuseCarrierPath(binary)));
  assert.ok(wires.length >= 1);
  for (const wire of wires) {
    // An unflipped development binary: stock Electron keeps all three on.
    assert.equal(wire.runAsNode, 'enabled');
    assert.equal(wire.enableNodeOptionsEnvironmentVariable, 'enabled');
    assert.equal(wire.enableNodeCliInspectArguments, 'enabled');
  }
});
