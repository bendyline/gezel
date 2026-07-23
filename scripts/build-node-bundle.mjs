#!/usr/bin/env node
/**
 * Build the self-contained, Electron-free Node distribution of gezel.
 *
 * This is the "node-only form factor": a relocatable tree containing the
 * `gezel` CLI, the `gezeld` daemon, the browser web UI, and every runtime
 * dependency (including native binaries) — no Electron, no system installer.
 * Extract it anywhere and run:
 *
 *   node <dir>/dist/bin/gezel.js start --web --open
 *
 * It works because the CLI depends on `@bendyline/gezel-service` (which now
 * ships `dist/ui` — see packages/service/tsup.config.ts), so `pnpm deploy`
 * of the CLI pulls the daemon + UI + the whole dep graph into one hoisted
 * `node_modules`. At runtime `resolveDaemonEntry` finds
 * `node_modules/@bendyline/gezel-service/dist/bin/gezeld.js` and the daemon's
 * `findBundledUi()` finds `../ui` next to it — no runtime extraction or code
 * changes needed.
 *
 * Output layout:
 *   release/gezel-node/             intermediate deployed tree (kept for inspection)
 *   release/gezel-node.tar.gz       shippable archive
 *   release/gezel-node.meta.json    { version, sha256, sizeBytes, fileCount }
 *
 * Per-platform: `pnpm deploy --prod` only resolves optional deps for the
 * current OS/arch, so this produces a platform-specific bundle — CI needs a
 * build job per target platform (same caveat as the Electron service bundle).
 *
 * Environment controls:
 *   GEZEL_NODE_BUNDLE_TARGET=<path>   override the output tree path
 *   GEZEL_SKIP_BUNDLE_ARCHIVE=1       skip tar/meta emission (dev iteration)
 *
 * Prerequisite: the workspace must be built first (`pnpm build`) so the CLI,
 * service (with dist/ui), and deps have dist/ output for deploy to copy.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { readFile, readdir, readlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const defaultTarget = join(repoRoot, 'release', 'gezel-node');
const target = process.env.GEZEL_NODE_BUNDLE_TARGET
  ? resolve(process.env.GEZEL_NODE_BUNDLE_TARGET)
  : defaultTarget;
const archivePath = `${target}.tar.gz`;
const metaPath = `${target}.meta.json`;

async function main() {
  console.log(`[build-node-bundle] target: ${target}`);

  // pnpm deploy refuses to run into a non-empty directory.
  if (existsSync(target)) {
    console.log('[build-node-bundle] clearing existing bundle dir');
    rmSync(target, { recursive: true, force: true });
  }

  // Deploy the CLI. Its prod dep on @bendyline/gezel-service drags the
  // daemon + UI + all transitive deps into one hoisted tree. `--legacy` +
  // `--node-linker=hoisted` for the same Windows/symlink reasons as the
  // Electron service bundle (see scripts/build-service-bundle.mjs).
  const args = [
    '--filter',
    '@bendyline/gezel-cli',
    'deploy',
    '--prod',
    '--legacy',
    '--node-linker=hoisted',
    target,
  ];
  console.log(`[build-node-bundle] pnpm ${args.join(' ')}`);
  const { stdout, stderr } = await exec('pnpm', args, {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    // Windows: `pnpm` on PATH is `pnpm.cmd`; child_process needs a shell to
    // launch a .cmd. Args are 100% internal, so no injection concern.
    shell: process.platform === 'win32',
  });
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);

  // Verify the three things that make this bundle actually runnable.
  const cliBin = join(target, 'dist', 'bin', 'gezel.js');
  const gezeldBin = join(
    target,
    'node_modules',
    '@bendyline',
    'gezel-service',
    'dist',
    'bin',
    'gezeld.js',
  );
  const uiIndex = join(
    target,
    'node_modules',
    '@bendyline',
    'gezel-service',
    'dist',
    'ui',
    'index.html',
  );
  for (const [label, p] of [
    ['CLI entry', cliBin],
    ['daemon entry', gezeldBin],
    ['web UI bundle', uiIndex],
  ]) {
    if (!existsSync(p)) {
      throw new Error(
        `[build-node-bundle] missing ${label} at ${p}. Did you run \`pnpm build\` (which builds gezel-ui before gezel-service so dist/ui is populated) before this script?`,
      );
    }
  }

  // `pnpm deploy --legacy` can leave bookkeeping symlinks pointing back to
  // the workspace; prune any that escape the bundle so `tar` doesn't follow
  // them out of the tree.
  await pruneEscapingSymlinks(target);

  // Convenience launchers at the bundle root so an extracted bundle runs as
  // `./gezel start --web` (POSIX) / `gezel start --web` (Windows) instead of
  // the verbose `node dist/bin/gezel.js …`.
  await writeWrappers(target);

  // Resolve the whole service dep graph (incl. native modules) by importing
  // its index.js in a throwaway process — index exports startService without
  // calling it, so nothing binds a port. Catches packaging breakage cheaply.
  console.log('[build-node-bundle] verifying the bundled service imports cleanly');
  const indexUrl = pathToFileURL(
    join(target, 'node_modules', '@bendyline', 'gezel-service', 'dist', 'index.js'),
  ).href;
  await exec(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(indexUrl)});`],
    { cwd: target, maxBuffer: 16 * 1024 * 1024 },
  );

  if (process.env.GEZEL_SKIP_BUNDLE_ARCHIVE === '1') {
    console.log('[build-node-bundle] ✓ bundle ready (archive skipped)');
    console.log(
      `[build-node-bundle] run: node ${join(target, 'dist', 'bin', 'gezel.js')} start --web`,
    );
    return;
  }

  await emitArchive(target, archivePath);
  await emitMeta(target, archivePath, metaPath);
  console.log('[build-node-bundle] ✓ bundle ready');
  console.log(`[build-node-bundle] archive: ${archivePath}`);
}

/** Pack the tree at `src` into a gzipped tarball. Uses the system tar. */
async function emitArchive(src, archivePath) {
  if (existsSync(archivePath)) rmSync(archivePath, { force: true });
  console.log(`[build-node-bundle] archiving → ${basename(archivePath)}`);
  const t0 = Date.now();
  // Windows: prefer System32's bsdtar over git-bash GNU tar, which mistakes
  // `C:\...` for an rsync host spec. Same fix as build-service-bundle.mjs.
  const tarBin =
    process.platform === 'win32'
      ? join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  await exec(tarBin, ['-czf', archivePath, '-C', src, '.'], { maxBuffer: 64 * 1024 * 1024 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const sz = statSync(archivePath).size;
  console.log(`[build-node-bundle] archived ${(sz / 1024 / 1024).toFixed(1)} MB in ${dt}s`);
}

/** Write the { version, sha256, sizeBytes, fileCount } sidecar. */
async function emitMeta(src, archivePath, metaPath) {
  const pkg = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') {
    throw new Error('[build-node-bundle] CLI package.json missing version');
  }
  const sha256 = await hashFile(archivePath);
  const sizeBytes = statSync(archivePath).size;
  const fileCount = await countFiles(src);
  const meta = { version: pkg.version, sha256, sizeBytes, fileCount };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `[build-node-bundle] meta: v${meta.version} sha256=${sha256.slice(0, 12)}… files=${fileCount}`,
  );
}

/**
 * Write tiny `gezel` (POSIX sh) + `gezel.cmd` (Windows) launchers at the
 * bundle root that exec the bundled CLI with the bundle's own node_modules
 * on the resolver path. Both use the directory of the script itself, so the
 * bundle stays fully relocatable.
 */
async function writeWrappers(root) {
  const sh = ['#!/bin/sh', 'exec node "$(dirname "$0")/dist/bin/gezel.js" "$@"', ''].join('\n');
  const cmd = ['@echo off', 'node "%~dp0dist\\bin\\gezel.js" %*', ''].join('\r\n');
  await writeFile(join(root, 'gezel'), sh, { encoding: 'utf8', mode: 0o755 });
  await writeFile(join(root, 'gezel.cmd'), cmd, 'utf8');
}

function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', rejectHash);
  });
}

async function countFiles(root) {
  let n = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() || e.isSymbolicLink()) n += 1;
    }
  }
  await walk(root);
  return n;
}

async function pruneEscapingSymlinks(root) {
  let removed = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const targetRaw = await readlink(p);
        const resolved = resolve(dirname(p), targetRaw);
        const rel = relative(root, resolved);
        if (rel.startsWith('..') || rel === '') {
          await unlink(p);
          removed += 1;
        }
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  }
  await walk(root);
  if (removed > 0) console.log(`[build-node-bundle] pruned ${removed} escaping symlink(s)`);
}

main().catch((err) => {
  console.error('[build-node-bundle] failed:', err.message ?? err);
  process.exit(1);
});
