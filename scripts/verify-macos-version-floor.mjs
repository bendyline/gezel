#!/usr/bin/env node
/**
 * Verify the final signed .app advertises the declared macOS floor and that
 * none of its Mach-O payloads require a newer OS.
 *
 * Usage:
 *   node scripts/verify-macos-version-floor.mjs <Gezel.app> 13.5
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const appPath = process.argv[2] ? resolve(process.argv[2]) : null;
const expectedFloor = process.argv[3];

if (!appPath || !expectedFloor || !/^\d+(?:\.\d+){1,2}$/.test(expectedFloor)) {
  throw new Error('usage: verify-macos-version-floor.mjs <Gezel.app> <major.minor[.patch]>');
}
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

const files = await listFiles(appPath);
const kinds = await mapLimit(files, 16, async (path) => {
  const { stdout } = await execFileP('file', ['-b', path]);
  return stdout.includes('Mach-O') ? path : null;
});
const machOPaths = kinds.filter((path) => path !== null);
let highest = '0.0';
for (const path of machOPaths) {
  // `otool` treats parentheses in framework helper filenames as archive-member
  // syntax even when execFile passes the path as one argument (e.g.
  // "Gezel Helper (GPU)"). vtool reports the same LC_BUILD_VERSION data
  // without that filename ambiguity.
  const { stdout: loadCommands } = await execFileP('xcrun', ['vtool', '-show-build', path], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const minima = readMacMinimums(loadCommands);
  if (minima.length === 0) {
    throw new Error(`${path} is Mach-O but exposes no macOS minimum-version load command`);
  }
  for (const minimum of minima) {
    if (compareVersions(minimum, highest) > 0) highest = minimum;
    if (compareVersions(minimum, declared) > 0) {
      throw new Error(`${path} requires macOS ${minimum}, newer than app floor ${declared}`);
    }
  }
}

if (machOPaths.length === 0) throw new Error(`${appPath} contains no Mach-O files`);
console.log(
  `✓ ${appPath} declares macOS ${declared}; ${machOPaths.length} Mach-O files require at most ${highest}`,
);

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

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function readMacMinimums(loadCommands) {
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
