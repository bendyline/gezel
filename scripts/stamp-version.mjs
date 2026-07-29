#!/usr/bin/env node
/**
 * Stamp every release-version surface with a date-based version.
 *
 * Format: 1.YYDDD.RUN
 *   YY  — two-digit year
 *   DDD — zero-padded day-of-year (001-366)
 *   RUN — caller-supplied increment (typically GitHub Actions run number)
 *
 * Example: on 2026-04-19 with run #42, version becomes 1.26109.42.
 *
 * Versions are sortable as plain SemVer (no prerelease suffix), which keeps
 * electron-updater happy — it would treat `1.0.0-42` as a prerelease and
 * skip auto-updating from it to a stable.
 *
 * Usage:
 *   node scripts/stamp-version.mjs --inc <N>
 *   node scripts/stamp-version.mjs --inc $GITHUB_RUN_NUMBER
 *   node scripts/stamp-version.mjs --version <X.Y.Z>
 *   node scripts/stamp-version.mjs --inc <N> --print  # do not write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const packagePaths = [
  resolve(repoRoot, 'package.json'),
  resolve(repoRoot, 'packages/app/package.json'),
  resolve(repoRoot, 'packages/core/package.json'),
  resolve(repoRoot, 'packages/service/package.json'),
];
const coreVersionPath = resolve(repoRoot, 'packages/core/src/index.ts');

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const inc = arg('--inc');
const explicitVersion = arg('--version');
if ((inc === undefined) === (explicitVersion === undefined)) {
  console.error('usage: stamp-version.mjs (--inc <run-number> | --version <X.Y.Z>) [--print]');
  process.exit(1);
}
let version;
if (explicitVersion !== undefined) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(explicitVersion)) {
    console.error(
      `--version must be a numeric X.Y.Z version (got ${JSON.stringify(explicitVersion)})`,
    );
    process.exit(1);
  }
  version = explicitVersion;
} else {
  const incNum = Number.parseInt(inc, 10);
  if (!Number.isFinite(incNum) || incNum < 0 || String(incNum) !== inc) {
    console.error(`--inc must be a non-negative integer (got ${JSON.stringify(inc)})`);
    process.exit(1);
  }

  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start) / 86400000);
  const ddd = String(dayOfYear).padStart(3, '0');
  version = `1.${yy}${ddd}.${incNum}`;
}

if (process.argv.includes('--print')) {
  console.log(version);
  process.exit(0);
}

// Read and validate every target before the first write. A missing/corrupt
// surface must never leave a checkout stamped only halfway.
const packages = packagePaths.map((pkgPath) => ({
  pkgPath,
  pkg: JSON.parse(readFileSync(pkgPath, 'utf8')),
}));
const coreSource = readFileSync(coreVersionPath, 'utf8');
const versionPattern = /export const GEZEL_VERSION = '[^']*';/;
if (!versionPattern.test(coreSource)) {
  console.error(`could not find GEZEL_VERSION declaration in ${coreVersionPath}`);
  process.exit(1);
}

for (const { pkgPath, pkg } of packages) {
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`stamped ${pkgPath} → ${version}`);
}

writeFileSync(
  coreVersionPath,
  coreSource.replace(versionPattern, `export const GEZEL_VERSION = '${version}';`),
);
console.log(`stamped ${coreVersionPath} → ${version}`);
