#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Bump the pinned ordinary pnpm package version and refresh the package
 * tarball + embedded-license sha256 values in
 * `packages/app/src/pnpm-version.ts`, and regenerate the complete vendored
 * dependency inventory consumed by the SBOM and legal-notice gates.
 *
 * Usage:
 *   node scripts/bump-pnpm.mjs 11.15.1
 *
 * Run this, review the diff, commit. The PR is the audit trail for the
 * new sha256s.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// See packages/app/scripts/fetch-node.mjs: Node's 250ms Happy Eyeballs
// timeout is too aggressive for Windows→Cloudflare TCP handshakes.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pinFile = resolve(repoRoot, 'packages', 'app', 'src', 'pnpm-version.ts');
const inventoryFile = resolve(repoRoot, 'packages', 'app', 'src', 'pnpm-runtime-inventory.json');

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function tarEntries(tgz) {
  const tar = gunzipSync(tgz);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size)) throw new Error(`invalid tar entry size for ${path}`);
    const start = offset + 512;
    entries.push({ path, content: tar.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function extractTarEntry(entries, wanted) {
  const entry = entries.find((candidate) => candidate.path === wanted);
  if (!entry) throw new Error(`tar entry ${wanted} was not found`);
  return entry.content;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function runtimeInventory(entries, pnpmVersion, packageSha256) {
  const byIdentity = new Map();
  for (const entry of entries) {
    if (
      !entry.path.startsWith('package/dist/node_modules/') ||
      !entry.path.endsWith('/package.json')
    ) {
      continue;
    }
    const metadata = JSON.parse(entry.content.toString('utf8'));
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') continue;
    if (typeof metadata.license !== 'string' || !metadata.license) {
      throw new Error(`${metadata.name}@${metadata.version} has no string license identity`);
    }
    const record = {
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      ...(Array.isArray(metadata.os) && metadata.os.length > 0
        ? { os: sortedUnique(metadata.os) }
        : {}),
      ...(Array.isArray(metadata.cpu) && metadata.cpu.length > 0
        ? { cpu: sortedUnique(metadata.cpu) }
        : {}),
      dependencies: sortedUnique([
        ...Object.keys(metadata.dependencies ?? {}),
        ...Object.keys(metadata.optionalDependencies ?? {}),
      ]),
    };
    const identity = `${record.name}@${record.version}`;
    const existing = byIdentity.get(identity);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`pnpm tarball contains conflicting metadata for ${identity}`);
    }
    byIdentity.set(identity, record);
  }
  const packages = [...byIdentity.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  if (packages.length === 0) throw new Error('pnpm tarball contains no vendored runtime packages');
  return { schemaVersion: 1, pnpmVersion, packageSha256, packages };
}

function sha256(bytes) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('usage: node scripts/bump-pnpm.mjs <version>');
    process.exit(2);
  }

  const packageUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;
  process.stdout.write(`computing sha256 for pnpm@${version}… `);
  const archive = await fetchBytes(packageUrl);
  const packageSha = sha256(archive);
  console.log(packageSha);
  const entries = tarEntries(archive);
  const licenseSha = sha256(extractTarEntry(entries, 'package/LICENSE'));
  console.log(`license ${licenseSha}`);

  const src = await readFile(pinFile, 'utf8');
  let next = src.replace(/PNPM_VERSION\s*=\s*['"][^'"]+['"]/, `PNPM_VERSION = '${version}'`);
  next = next.replace(
    /PNPM_PACKAGE_SHA256\s*=\s*\n?\s*['"][0-9a-fA-F]{64}['"]\s*;/,
    `PNPM_PACKAGE_SHA256 =\n  '${packageSha}';`,
  );
  next = next.replace(
    /PNPM_LICENSE_SHA256\s*=\s*\n?\s*['"][0-9a-fA-F]{64}['"]\s*;/,
    `PNPM_LICENSE_SHA256 =\n  '${licenseSha}';`,
  );
  if (next === src) {
    throw new Error(
      `bump-pnpm did not find PNPM_VERSION/PNPM_PACKAGE_SHA256/PNPM_LICENSE_SHA256 anchors in ${pinFile}`,
    );
  }
  await writeFile(pinFile, next, 'utf8');
  const inventory = runtimeInventory(entries, version, packageSha);
  await writeFile(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(
    `\nUpdated ${pinFile} and ${inventoryFile} to pnpm v${version} ` +
      `(${inventory.packages.length} vendored package identities).`,
  );
  console.log('Review the diff and commit.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
