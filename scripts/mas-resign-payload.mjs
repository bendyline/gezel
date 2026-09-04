#!/usr/bin/env node

/**
 * Re-sign the bundled payload with our Apple Distribution identity, for the
 * Mac App Store lane.
 *
 * This is the step with no counterpart in the Developer ID build, and the one
 * that makes the MAS config's `signIgnore` mean the opposite of the base
 * config's.
 *
 * The direct-download build PRESERVES each vendor's own Developer ID signature
 * on node, DuckDB and the native engines: replacing them would substitute our
 * attestation for theirs and break the source-pinned reuse standalone clients
 * depend on. Under the App Sandbox that is not an option — every Mach-O in the
 * payload must carry OUR team identifier and the child inherit entitlements,
 * or the sandbox refuses to launch it, in a way that looks like anything but a
 * signing problem.
 *
 * TIMING IS THE WHOLE TRICK, and it is narrower than it looks. This must run:
 *
 *   AFTER `pnpm build:packaged`, because that rebuilds two of these trees.
 *     tsup's onSuccess hook re-runs fetch-node.mjs, fetch-pnpm.mjs and
 *     fetch-duckdb.mjs, which re-stage `dist/node-bundle` and
 *     `dist/duckdb-bundle` from their pinned vendor downloads and rewrite
 *     `sha256.txt` over those bytes. Signing before that point is silently
 *     undone: the build succeeds, the package ships vendor-signed binaries,
 *     and the failure surfaces on a reviewer's machine as child processes
 *     that will not launch under the sandbox — with nothing anywhere saying
 *     "signature".
 *
 *   BEFORE electron-builder packs, because packing seals the tree. These paths
 *     are `signIgnore`d in the MAS config so electron-builder will not sign
 *     them itself — deliberate, since it would apply the APP's entitlements
 *     rather than the child inherit set — and an afterSign hook would have to
 *     break the seal to reach them.
 *
 * The service tree is a separate concern signed during `build:packaged` itself,
 * through GEZEL_MACOS_SIGN_BUNDLE on that step.
 *
 *   node scripts/mas-resign-payload.mjs
 *
 * Requires GEZEL_MACOS_SIGN_BUNDLE=1 and an "Apple Distribution" identity in
 * the keychain; see scripts/sign-macho-tree.mjs.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signMachOTree } from './sign-macho-tree.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tree whose Mach-Os the sandbox will load and therefore must own. */
export const MAS_SIGNED_TREES = Object.freeze([
  'packages/app/native-bin',
  'packages/app/dist/node-bundle',
  'packages/app/dist/duckdb-bundle',
]);

/**
 * Rewrite a bundle's `sha256.txt` over its current bytes.
 *
 * The supervisor verifies the bundled node against this manifest before
 * running it, and re-signing just changed the very bytes it attests to. Left
 * stale, the app refuses its own runtime at launch — with a message about an
 * unverified bundle that says nothing about signing.
 */
export async function refreshBundleManifest(bundleDir) {
  if (!existsSync(bundleDir)) return null;
  const entries = (await readdir(bundleDir)).filter((name) => name !== 'sha256.txt').sort();
  const lines = [];
  for (const name of entries) {
    const buf = await readFile(join(bundleDir, name)).catch(() => null);
    // Directories and unreadable entries are not manifest material; the
    // manifest covers the files the supervisor actually hashes.
    if (!buf) continue;
    lines.push(`${createHash('sha256').update(buf).digest('hex')}  ${name}`);
  }
  if (lines.length === 0) return null;
  await writeFile(join(bundleDir, 'sha256.txt'), `${lines.join('\n')}\n`, 'utf8');
  return lines.length;
}

async function main() {
  if (process.env.GEZEL_MACOS_SIGN_BUNDLE !== '1') {
    console.error('[mas-resign] refusing to run without GEZEL_MACOS_SIGN_BUNDLE=1');
    process.exit(1);
  }
  if (process.env.GEZEL_MACOS_SIGN_IDENTITY_KIND !== 'apple-distribution') {
    // Signing this payload as Developer ID would produce an app that packages,
    // uploads, and then fails to launch a single child process on a reviewer's
    // machine. Refuse rather than guess.
    console.error(
      '[mas-resign] GEZEL_MACOS_SIGN_IDENTITY_KIND must be apple-distribution for the MAS lane',
    );
    process.exit(1);
  }
  if (!process.env.GEZEL_MACOS_SIGN_ENTITLEMENTS) {
    console.error(
      '[mas-resign] GEZEL_MACOS_SIGN_ENTITLEMENTS must point at entitlements.mas.inherit.plist',
    );
    process.exit(1);
  }
  // Refuse to run before `pnpm build:packaged`, which would silently undo this
  // work — see the timing note in the header. `dist/service-bundle` is the
  // cheapest proof that step has already happened: it is the one directory
  // only `build:bundle` creates, and it is created after the fetch hooks that
  // would clobber the trees below. Without this guard the mistake produces a
  // package that builds cleanly and fails on a reviewer's machine.
  if (!existsSync(join(root, 'packages/app/dist/service-bundle'))) {
    console.error(
      '[mas-resign] packages/app/dist/service-bundle is missing, so `pnpm build:packaged` has ' +
        'not run yet. Re-signing now would be undone by its fetch-node / fetch-duckdb hooks. ' +
        'Run this AFTER build:packaged and BEFORE electron-builder.',
    );
    process.exit(1);
  }

  for (const relative of MAS_SIGNED_TREES) {
    const tree = join(root, relative);
    if (!existsSync(tree)) {
      console.log(`[mas-resign] absent, skipping: ${relative}`);
      continue;
    }
    const signed = await signMachOTree(tree);
    console.log(`[mas-resign] ${relative}: signed ${signed} Mach-O binaries`);
  }

  const refreshed = await refreshBundleManifest(join(root, 'packages/app/dist/node-bundle'));
  if (refreshed) {
    console.log(`[mas-resign] regenerated node-bundle/sha256.txt over ${refreshed} files`);
  }
  const duckdb = await refreshBundleManifest(join(root, 'packages/app/dist/duckdb-bundle'));
  if (duckdb) {
    console.log(`[mas-resign] regenerated duckdb-bundle/sha256.txt over ${duckdb} files`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mas-resign] ${error.message ?? error}`);
    process.exit(1);
  });
}
