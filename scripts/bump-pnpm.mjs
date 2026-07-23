#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Bump the pinned pnpm version + refresh sha256s for every supported
 * platform. Writes updated values into
 * `packages/app/src/pnpm-version.ts`.
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

const PLATFORMS = ['macos-arm64', 'linux-x64', 'linux-arm64', 'win-x64'];

function platformPackageUrl(key, version) {
  const names = {
    'macos-arm64': 'macos-arm64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'win-x64': 'win-x64',
  };
  const name = names[key];
  if (!name) throw new Error(`unsupported pnpm platform key: ${key}`);
  return `https://registry.npmjs.org/@pnpm/${name}/-/${name}-${version}.tgz`;
}

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function extractTarEntry(tgz, wanted) {
  const tar = gunzipSync(tgz);
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
    if (path === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`tar entry ${wanted} was not found`);
}

function sha256(bytes) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function sha256Url(url) {
  return sha256(await fetchBytes(url));
}

function runtimePackageUrl(version) {
  return `https://registry.npmjs.org/@pnpm/exe/-/exe-${version}.tgz`;
}

async function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('usage: node scripts/bump-pnpm.mjs <version>');
    process.exit(2);
  }

  const shas = {};
  for (const key of PLATFORMS) {
    const url = platformPackageUrl(key, version);
    process.stdout.write(`computing sha256 for ${key}… `);
    const binary = extractTarEntry(
      await fetchBytes(url),
      key === 'win-x64' ? 'package/pnpm.exe' : 'package/pnpm',
    );
    shas[key] = sha256(binary);
    console.log(shas[key]);
  }
  const licenseSha = await sha256Url(
    `https://raw.githubusercontent.com/pnpm/pnpm/v${version}/LICENSE`,
  );
  console.log(`license ${licenseSha}`);
  const runtimeSha = await sha256Url(runtimePackageUrl(version));
  console.log(`runtime ${runtimeSha}`);

  const src = await readFile(pinFile, 'utf8');
  let next = src.replace(/PNPM_VERSION\s*=\s*['"][^'"]+['"]/, `PNPM_VERSION = '${version}'`);
  next = next.replace(
    /PNPM_LICENSE_SHA256\s*=\s*['"][0-9a-fA-F]{64}['"]/,
    `PNPM_LICENSE_SHA256 = '${licenseSha}'`,
  );
  next = next.replace(
    /PNPM_RUNTIME_SHA256\s*=\s*\n?\s*['"][0-9a-fA-F]{64}['"]\s*;/,
    `PNPM_RUNTIME_SHA256 =\n  '${runtimeSha}';`,
  );
  next = next.replace(/PNPM_SHA256:\s*Record<string,\s*string>\s*=\s*\{[\s\S]*?\};/, () => {
    const lines = PLATFORMS.map((k) => `  '${k}': '${shas[k]}',`).join('\n');
    return `PNPM_SHA256: Record<string, string> = {\n${lines}\n};`;
  });
  if (next === src) {
    throw new Error(
      `bump-pnpm did not find PNPM_VERSION/PNPM_LICENSE_SHA256/PNPM_RUNTIME_SHA256/PNPM_SHA256 anchors in ${pinFile}`,
    );
  }
  await writeFile(pinFile, next, 'utf8');
  console.log(`\nUpdated ${pinFile} to pnpm v${version}.`);
  console.log('Review the diff and commit.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
