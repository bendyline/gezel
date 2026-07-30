#!/usr/bin/env node
import { createHash } from 'node:crypto';
/**
 * Bump the pinned Node.js version + refresh sha256s for every
 * supported platform. Writes updated values into
 * `packages/app/src/node-version.ts`.
 *
 * Usage:
 *   node scripts/bump-node.mjs <version>
 *
 * Run this, review the diff, commit. The PR is the audit trail for
 * the new sha256s.
 *
 * Matches bump-pnpm.mjs in shape and ergonomics — the only
 * difference is URL construction: Node ships Windows as a standalone
 * `node.exe`, and unix as a `.tar.gz` tarball.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// See packages/app/scripts/fetch-node.mjs: Node's 250ms Happy Eyeballs
// timeout is too aggressive for Windows→Cloudflare TCP handshakes.
setDefaultAutoSelectFamilyAttemptTimeout(5000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pinFile = resolve(repoRoot, 'packages', 'app', 'src', 'node-version.ts');

const PLATFORMS = ['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64', 'win-x64'];

function assetUrl(key, version) {
  const base = `https://nodejs.org/dist/v${version}`;
  if (key === 'win-x64') return `${base}/win-x64/node.exe`;
  const dist = key.replace('macos', 'darwin');
  const stem = `node-v${version}-${dist}`;
  return `${base}/${stem}.tar.gz`;
}

async function sha256Url(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const hash = createHash('sha256');
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex');
}

async function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('usage: node scripts/bump-node.mjs <version>');
    process.exit(2);
  }

  const shas = {};
  for (const key of PLATFORMS) {
    const url = assetUrl(key, version);
    process.stdout.write(`computing sha256 for ${key}… `);
    shas[key] = await sha256Url(url);
    console.log(shas[key]);
  }
  const licenseSha = await sha256Url(
    `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`,
  );
  console.log(`license ${licenseSha}`);

  const src = await readFile(pinFile, 'utf8');
  let next = src.replace(/NODE_VERSION\s*=\s*['"][^'"]+['"]/, `NODE_VERSION = '${version}'`);
  next = next.replace(
    /NODE_LICENSE_SHA256\s*=\s*['"][0-9a-fA-F]{64}['"]/,
    `NODE_LICENSE_SHA256 = '${licenseSha}'`,
  );
  next = next.replace(/NODE_SHA256:\s*Record<string,\s*string>\s*=\s*\{[\s\S]*?\};/, () => {
    const lines = PLATFORMS.map((k) => `  '${k}': '${shas[k]}',`).join('\n');
    return `NODE_SHA256: Record<string, string> = {\n${lines}\n};`;
  });
  if (next === src) {
    throw new Error(
      `bump-node did not find NODE_VERSION/NODE_LICENSE_SHA256/NODE_SHA256 anchors in ${pinFile}`,
    );
  }
  await writeFile(pinFile, next, 'utf8');
  console.log(`\nUpdated ${pinFile} to node v${version}.`);
  console.log('Review the diff and commit.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
