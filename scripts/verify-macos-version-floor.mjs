#!/usr/bin/env node
/**
 * Verify the final signed .app advertises the declared macOS floor and that
 * none of its Mach-O payloads require a newer OS.
 *
 * "Payload" includes the Mach-Os sealed inside service-bundle.tar.gz. A walk of
 * the .app cannot see into that archive, which is how v1.26270.76 shipped with
 * LSMinimumSystemVersion 13.5 while sqlite-vec and ONNX Runtime inside the
 * tarball required macOS 14.0: the app launched on 13.x and its memory and
 * embedding stack could not load.
 *
 * Usage:
 *   node scripts/verify-macos-version-floor.mjs <Gezel.app> [major.minor[.patch]]
 *
 * The floor defaults to `mac.minimumSystemVersion` in
 * packages/app/electron-builder.yml.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as tar from 'tar';

const execFileP = promisify(execFile);

export const BUILDER_CONFIG = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'app',
  'electron-builder.yml',
);

const SERVICE_TARBALL = [
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'dist',
  'service-bundle.tar.gz',
];

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM = 0xcefaedfe;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const OTHER_PLATFORM_VERSION_COMMANDS = new Set([0x25, 0x2f, 0x30]);
const PLATFORM_MACOS = 1;
// Java class files share 0xcafebabe; where a fat header keeps its slice count
// they keep a class-file version, which is 45 or more.
const MAX_FAT_SLICES = 30;

/** `mac.minimumSystemVersion` from electron-builder.yml. */
export function declaredMacFloor(builderYaml) {
  const mac = builderYaml.match(/^mac:$[\s\S]*?(?=^\S)/m)?.[0];
  const floor = mac?.match(/^ {2}minimumSystemVersion:\s*['"]?(\d+(?:\.\d+){1,2})['"]?\s*$/m)?.[1];
  if (!floor) throw new Error('electron-builder.yml declares no mac.minimumSystemVersion');
  return floor;
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** macOS minimums from `xcrun vtool -show-build` output. */
export function readMacMinimums(loadCommands) {
  const minima = [];
  for (const command of loadCommands.split(/\n(?=Load command \d+\n)/)) {
    const field = command.includes('cmd LC_BUILD_VERSION')
      ? 'minos'
      : command.includes('cmd LC_VERSION_MIN_MACOSX')
        ? 'version'
        : null;
    if (!field) continue;
    const match = command.match(new RegExp(`^\\s+${field}\\s+(\\d+(?:\\.\\d+){1,2})\\s*$`, 'm'));
    if (match) minima.push(match[1]);
  }
  return minima;
}

/** True when the leading bytes are a thin or fat Mach-O header. */
export function hasMachOMagic(bytes) {
  if (bytes.length < 8) return false;
  const magic = bytes.readUInt32BE(0);
  if ([MH_MAGIC, MH_MAGIC_64, MH_CIGAM, MH_CIGAM_64].includes(magic)) return true;
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return false;
  const slices = bytes.readUInt32BE(4);
  return slices > 0 && slices < MAX_FAT_SLICES;
}

function decodeVersion(packed) {
  const major = packed >>> 16;
  const minor = (packed >>> 8) & 0xff;
  const patch = packed & 0xff;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

function thinMinimums(bytes, offset, label) {
  if (offset + 28 > bytes.length) throw new Error(`${label}: truncated Mach-O header`);
  const magic = bytes.readUInt32BE(offset);
  const littleEndian = magic === MH_CIGAM || magic === MH_CIGAM_64;
  if (!littleEndian && magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
    throw new Error(`${label}: slice at ${offset} is not a Mach-O image`);
  }
  const is64 = magic === MH_MAGIC_64 || magic === MH_CIGAM_64;
  const u32 = (at) => (littleEndian ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const commandCount = u32(offset + 16);
  const minima = [];
  let versioned = false;
  let cursor = offset + (is64 ? 32 : 28);
  for (let i = 0; i < commandCount; i += 1) {
    if (cursor + 8 > bytes.length) throw new Error(`${label}: truncated load commands`);
    const command = u32(cursor);
    const size = u32(cursor + 4);
    if (size < 8) throw new Error(`${label}: malformed load command ${i}`);
    if (command === LC_VERSION_MIN_MACOSX) {
      versioned = true;
      minima.push(decodeVersion(u32(cursor + 8)));
    } else if (command === LC_BUILD_VERSION) {
      versioned = true;
      if (u32(cursor + 8) === PLATFORM_MACOS) minima.push(decodeVersion(u32(cursor + 12)));
    } else if (OTHER_PLATFORM_VERSION_COMMANDS.has(command)) {
      versioned = true;
    }
    cursor += size;
  }
  return { minima, versioned };
}

/**
 * The macOS minimums a Mach-O declares, across every slice of a fat binary.
 * `versioned` is false when some slice carries no minimum-version command at
 * all; a binary built only for another Apple platform is versioned with no
 * macOS minima. Returns null for anything that is not Mach-O.
 */
export function machOMacMinimums(bytes, label = 'Mach-O') {
  if (!hasMachOMagic(bytes)) return null;
  const magic = bytes.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return thinMinimums(bytes, 0, label);

  const is64 = magic === FAT_MAGIC_64;
  const entrySize = is64 ? 32 : 20;
  const slices = bytes.readUInt32BE(4);
  if (8 + slices * entrySize > bytes.length) throw new Error(`${label}: truncated fat header`);
  const minima = [];
  let versioned = true;
  for (let i = 0; i < slices; i += 1) {
    const entry = 8 + i * entrySize;
    const offset = is64 ? Number(bytes.readBigUInt64BE(entry + 8)) : bytes.readUInt32BE(entry + 8);
    const slice = thinMinimums(bytes, offset, `${label} slice ${i}`);
    minima.push(...slice.minima);
    versioned &&= slice.versioned;
  }
  return { minima, versioned };
}

/**
 * Every Mach-O regular file inside a (gzipped) tarball, with its macOS
 * minimums. Non-Mach-O entries are discarded after their first bytes, so the
 * archive streams through in bounded memory apart from the Mach-Os themselves.
 */
export async function scanTarballMachOs(tarballPath) {
  const found = [];
  const failures = [];
  await tar.t({
    file: tarballPath,
    onReadEntry: (entry) => {
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'ContiguousFile') {
        return;
      }
      const chunks = [];
      let length = 0;
      let machO = null;
      entry.on('data', (chunk) => {
        if (machO === false) return;
        chunks.push(chunk);
        length += chunk.length;
        if (machO === null && length >= 8) {
          machO = hasMachOMagic(Buffer.concat(chunks, length));
          if (!machO) chunks.length = 0;
        }
      });
      entry.on('end', () => {
        if (!machO) return;
        try {
          const result = machOMacMinimums(Buffer.concat(chunks, length), entry.path);
          found.push({ path: entry.path, ...result });
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      });
    },
  });
  if (failures.length > 0) {
    throw new Error(`unreadable Mach-O entries in ${tarballPath}:\n  ${failures.join('\n  ')}`);
  }
  return found;
}

/**
 * Throws for a binary that needs a newer macOS than `floor`, or that declares
 * no minimum at all. Binaries built only for another Apple platform are not
 * macOS code and are skipped. Returns the highest minimum seen.
 */
export function assertWithinFloor(binaries, floor) {
  let highest = '0.0';
  for (const { path, minima, versioned } of binaries) {
    if (!versioned) {
      throw new Error(`${path} is Mach-O but exposes no minimum-version load command`);
    }
    for (const minimum of minima) {
      if (compareVersions(minimum, highest) > 0) highest = minimum;
      if (compareVersions(minimum, floor) > 0) {
        throw new Error(`${path} requires macOS ${minimum}, newer than app floor ${floor}`);
      }
    }
  }
  return highest;
}

async function listFiles(root) {
  const results = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) results.push(path);
    }
  }
  await walk(root);
  return results;
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function appBundleMachOs(appPath) {
  const files = await listFiles(appPath);
  const kinds = await mapLimit(files, 16, async (path) => {
    const { stdout } = await execFileP('file', ['-b', path]);
    return stdout.includes('Mach-O') ? path : null;
  });
  const machOPaths = kinds.filter((path) => path !== null);
  return mapLimit(machOPaths, 16, async (path) => {
    // `otool` treats parentheses in framework helper filenames as archive-member
    // syntax even when execFile passes the path as one argument (e.g.
    // "Gezel Helper (GPU)"). vtool reports the same LC_BUILD_VERSION data
    // without that filename ambiguity.
    const { stdout: loadCommands } = await execFileP('xcrun', ['vtool', '-show-build', path], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const minima = readMacMinimums(loadCommands);
    return { path, minima, versioned: minima.length > 0 };
  });
}

export async function verifyMacosVersionFloor(appPath, expectedFloor) {
  if (process.platform !== 'darwin') {
    throw new Error('verify-macos-version-floor.mjs must run on macOS');
  }
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  const { stdout: declaredRaw } = await execFileP('plutil', [
    '-extract',
    'LSMinimumSystemVersion',
    'raw',
    plistPath,
  ]);
  const declared = declaredRaw.trim();
  if (declared !== expectedFloor) {
    throw new Error(
      `${plistPath} declares LSMinimumSystemVersion=${declared}; expected ${expectedFloor}`,
    );
  }

  const bundled = await appBundleMachOs(appPath);
  if (bundled.length === 0) throw new Error(`${appPath} contains no Mach-O files`);
  const bundledHighest = assertWithinFloor(bundled, declared);

  const tarballPath = join(appPath, ...SERVICE_TARBALL);
  const archived = (await scanTarballMachOs(tarballPath)).map((binary) => ({
    ...binary,
    path: `${tarballPath}!/${binary.path}`,
  }));
  if (archived.length === 0) throw new Error(`${tarballPath} contains no Mach-O files`);
  const archivedHighest = assertWithinFloor(archived, declared);

  console.log(
    `✓ ${appPath} declares macOS ${declared}; ${bundled.length} Mach-O files require at most ${bundledHighest}; ${archived.length} inside service-bundle.tar.gz require at most ${archivedHighest}`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2] ? resolve(process.argv[2]) : null;
  const expectedFloor = process.argv[3] ?? declaredMacFloor(await readFile(BUILDER_CONFIG, 'utf8'));
  if (!appPath || !/^\d+(?:\.\d+){1,2}$/.test(expectedFloor)) {
    console.error(
      'usage: node scripts/verify-macos-version-floor.mjs <Gezel.app> [major.minor[.patch]]',
    );
    process.exit(2);
  }
  try {
    await verifyMacosVersionFloor(appPath, expectedFloor);
  } catch (error) {
    console.error(`macOS version floor verification failed: ${error.message ?? error}`);
    process.exit(1);
  }
}
