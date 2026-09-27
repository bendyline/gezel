#!/usr/bin/env node
/**
 * Verify the Electron fuse wire of a packaged Gezel binary.
 *
 * electron-builder flips the fuses declared under `electronFuses` in
 * packages/app/electron-builder.yml after afterPack and before code signing.
 * That config is only intent: a dropped key, a renamed option, or a packaging
 * path that skips `doAddElectronFuses` still produces an installer that signs,
 * notarizes and launches. The binary is the only witness, so the release job
 * reads the wire back out of it.
 *
 * Deliberately dependency-free. `@electron/fuses` is only reachable from
 * app-builder-lib's private node_modules, and reading the wire is a byte scan:
 * a fixed sentinel, one version byte, one length byte, then one ASCII state per
 * fuse ('0' disabled, '1' enabled, 'r' removed).
 *
 * Usage:
 *   node scripts/verify-electron-fuses.mjs <Gezel.app | gezel.exe | gezel>
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');
const FUSE_WIRE_VERSION = 1;
const STATE = { 48: 'disabled', 49: 'enabled', 114: 'removed' };

/** Fuse positions on the V1 wire, named as electron-builder's `electronFuses` keys. */
export const FUSE_ORDER = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
  'wasmTrapHandlers',
];

/**
 * The fuses the packaged app must carry, and why. Everything not listed keeps
 * Electron's default. electron-builder.yml's `electronFuses` block must declare
 * exactly this set (scripts/verify-electron-fuses.test.mjs pins that).
 */
export const EXPECTED_FUSES = new Map([
  [
    'runAsNode',
    {
      enabled: true,
      why: 'gezeld, the installers, and the service hosts run the Electron binary as Node via ELECTRON_RUN_AS_NODE',
    },
  ],
  [
    'enableNodeOptionsEnvironmentVariable',
    {
      enabled: false,
      why: 'NODE_OPTIONS would let whoever sets the environment load code into the signed app and its Electron-as-Node daemon',
    },
  ],
  [
    'enableNodeCliInspectArguments',
    {
      enabled: false,
      why: '--inspect and SIGUSR1 would open a debugger in the main process that holds the daemon token and the macOS privacy grants',
    },
  ],
]);

/** The file that carries the wire: the framework binary on macOS, the executable elsewhere. */
export function fuseCarrierPath(target) {
  const bundle = /^(.*?\.app)(?:[/\\].*)?$/.exec(target)?.[1];
  if (!bundle) return target;
  return join(
    bundle,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  );
}

/**
 * Every fuse wire in the binary (a universal macOS build carries one per
 * slice), each as `{ name: 'enabled' | 'disabled' | 'removed' }`.
 */
export function readFuseWires(bytes) {
  const wires = [];
  let from = 0;
  for (;;) {
    const at = bytes.indexOf(SENTINEL, from);
    if (at === -1) break;
    const versionAt = at + SENTINEL.length;
    const version = bytes[versionAt];
    if (version !== FUSE_WIRE_VERSION) {
      throw new Error(`unsupported fuse wire version ${version} (expected ${FUSE_WIRE_VERSION})`);
    }
    const length = bytes[versionAt + 1];
    const wire = {};
    for (let i = 0; i < length; i += 1) {
      const raw = bytes[versionAt + 2 + i];
      const state = STATE[raw];
      if (!state) throw new Error(`fuse ${i} has unknown state byte ${raw}`);
      wire[FUSE_ORDER[i] ?? `fuse${i}`] = state;
    }
    wires.push(wire);
    from = versionAt + 2 + length;
  }
  if (wires.length === 0) {
    throw new Error('no Electron fuse wire sentinel found; is this an Electron 12+ binary?');
  }
  return wires;
}

/** Throws naming each fuse whose packaged state differs from EXPECTED_FUSES. */
export function assertExpectedFuses(wires, label) {
  const problems = [];
  wires.forEach((wire, index) => {
    const slice = wires.length > 1 ? ` (wire ${index + 1} of ${wires.length})` : '';
    for (const [name, { enabled, why }] of EXPECTED_FUSES) {
      const want = enabled ? 'enabled' : 'disabled';
      if (wire[name] !== want) {
        problems.push(`${name} is ${wire[name] ?? 'absent'}${slice}, expected ${want}: ${why}`);
      }
    }
  });
  if (problems.length > 0) {
    throw new Error(`${label} carries the wrong Electron fuses:\n  ${problems.join('\n  ')}`);
  }
}

export function formatWire(wire) {
  return Object.entries(wire)
    .map(([name, state]) => `${name}=${state}`)
    .join(' ');
}

export async function verifyElectronFuses(target) {
  const resolved = resolve(target);
  const carrier = fuseCarrierPath(resolved);
  if (!(await stat(carrier)).isFile()) throw new Error(`${carrier} is not a file`);
  const wires = readFuseWires(await readFile(carrier));
  assertExpectedFuses(wires, carrier);
  return { carrier, wires };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node scripts/verify-electron-fuses.mjs <Gezel.app | gezel.exe | gezel>');
    process.exit(2);
  }
  verifyElectronFuses(target).then(
    ({ carrier, wires }) => {
      for (const wire of wires) console.log(`${carrier}: ${formatWire(wire)}`);
      console.log(`✓ verified Electron fuses on ${carrier}`);
    },
    (error) => {
      console.error(`Electron fuse verification failed: ${error.message ?? error}`);
      process.exit(1);
    },
  );
}
