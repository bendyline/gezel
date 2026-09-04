import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MAS_SIGNED_TREES, refreshBundleManifest } from './mas-resign-payload.mjs';

describe('MAS_SIGNED_TREES', () => {
  it('covers every tree the base config refuses to re-sign', async () => {
    // The MAS lane must sign exactly what electron-builder is told to skip.
    // A path in signIgnore but not here ships with a vendor signature the
    // sandbox will reject; a path here but not in signIgnore gets signed
    // twice, the second time with the app's entitlements instead of the
    // child inherit set.
    const config = await readFile(
      new URL('../packages/app/electron-builder.mas.yml', import.meta.url),
      'utf8',
    );
    const signIgnore = config.slice(config.indexOf('signIgnore:'));
    for (const tree of MAS_SIGNED_TREES) {
      const leaf = tree.split('/').pop();
      assert.ok(
        signIgnore.includes(leaf),
        `${tree} is re-signed but not signIgnore'd — electron-builder would sign it again`,
      );
    }
  });
});

describe('the ordering guard', () => {
  it('refuses to run before build:packaged has produced the service bundle', async () => {
    // The trap this exists for: tsup's onSuccess re-runs fetch-node and
    // fetch-duckdb, which re-stage those bundles from their vendor downloads.
    // Signing before that point is silently undone — the build stays green and
    // the package ships vendor-signed binaries whose children cannot launch on
    // a reviewer's machine, with nothing anywhere mentioning signatures.
    const source = await readFile(new URL('./mas-resign-payload.mjs', import.meta.url), 'utf8');
    assert.match(
      source,
      /dist\/service-bundle/,
      'the guard must check for the directory only build:bundle creates',
    );
    assert.match(source, /build:packaged/, 'the failure message must name what to run first');
  });

  it('refuses an identity kind that would produce an unlaunchable app', async () => {
    // Signing this payload as Developer ID yields a package that builds,
    // uploads, and then cannot start a single child under the sandbox.
    const source = await readFile(new URL('./mas-resign-payload.mjs', import.meta.url), 'utf8');
    assert.match(source, /GEZEL_MACOS_SIGN_IDENTITY_KIND !== 'apple-distribution'/);
  });
});

describe('refreshBundleManifest', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-manifest-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites sha256.txt over the current bytes', async () => {
    // Re-signing changes the very bytes the supervisor verifies before running
    // the bundled node. A stale manifest makes the app refuse its own runtime,
    // with a message about an unverified bundle that says nothing about
    // signing — which is exactly how long that would take to diagnose.
    await writeFile(join(dir, 'node'), 'RESIGNED');
    await writeFile(join(dir, 'version.txt'), '24.1.0\n');
    await writeFile(join(dir, 'sha256.txt'), 'stale  node\n');

    const count = await refreshBundleManifest(dir);
    assert.equal(count, 2);

    const manifest = await readFile(join(dir, 'sha256.txt'), 'utf8');
    assert.match(
      manifest,
      new RegExp(`${createHash('sha256').update('RESIGNED').digest('hex')}  node`),
    );
    assert.doesNotMatch(manifest, /stale/);
    // The manifest must not list itself, or verification would chase a hash
    // that changes every time it is written.
    assert.doesNotMatch(manifest, /sha256\.txt/);
  });

  it('returns null for a directory that does not exist', async () => {
    assert.equal(await refreshBundleManifest(join(dir, 'absent')), null);
  });
});
