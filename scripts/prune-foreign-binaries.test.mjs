import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { pruneForeignBinaries, pruneReason } from './prune-foreign-binaries.mjs';

const target = { platform: 'darwin', arch: 'arm64' };

describe('pruneReason', () => {
  it('keeps the target platform and arch', () => {
    assert.equal(pruneReason('darwin', 'napi-v6', target), null);
    assert.equal(pruneReason('arm64', 'darwin', target), null);
    assert.equal(pruneReason('darwin-arm64', 'prebuilds', target), null);
  });

  it('prunes foreign platforms and arches in both directory shapes', () => {
    assert.match(pruneReason('win32', 'napi-v6', target), /foreign platform/);
    assert.match(pruneReason('linux', 'napi-v6', target), /foreign platform/);
    assert.match(pruneReason('x64', 'darwin', target), /foreign arch/);
    assert.match(pruneReason('darwin-x64', 'prebuilds', target), /foreign arch/);
    assert.match(pruneReason('win32-x64', 'prebuilds', target), /foreign platform/);
  });

  it('leaves a bare arch directory alone unless its parent is a platform', () => {
    // `x64` under something unrelated must not be touched — only
    // <platform>/<arch> nesting is meaningful.
    assert.equal(pruneReason('x64', 'lib', target), null);
    assert.equal(pruneReason('arm64', 'vendor', target), null);
  });

  it('ignores names that merely look similar', () => {
    assert.equal(pruneReason('darwinia', 'x', target), null);
    assert.equal(pruneReason('linux-extras', 'x', target), null);
    assert.equal(pruneReason('node_modules', 'x', target), null);
  });
});

describe('pruneForeignBinaries', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-prune-'));
    // Mirrors the real bundle: onnxruntime's platform/arch nesting and
    // node-pty's hyphenated prebuilds, plus a decoy `x64` under `lib`.
    const dirs = [
      'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64',
      'node_modules/onnxruntime-node/bin/napi-v6/darwin/x64',
      'node_modules/onnxruntime-node/bin/napi-v6/win32/x64',
      'node_modules/onnxruntime-node/bin/napi-v6/linux/arm64',
      'node_modules/node-pty/prebuilds/darwin-arm64',
      'node_modules/node-pty/prebuilds/win32-x64',
      'node_modules/node-pty/prebuilds/linux-arm64',
      'node_modules/somepkg/lib/x64',
    ];
    for (const d of dirs) {
      await mkdir(join(dir, d), { recursive: true });
      await writeFile(join(dir, d, 'binary.node'), Buffer.alloc(1024));
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps only the target platform+arch, and spares the decoy', async () => {
    const { removed } = await pruneForeignBinaries(dir, target);

    const kept = (p) => existsSync(join(dir, p, 'binary.node'));
    assert.equal(kept('node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64'), true);
    assert.equal(kept('node_modules/node-pty/prebuilds/darwin-arm64'), true);
    // A path that is not platform-shaped must survive.
    assert.equal(kept('node_modules/somepkg/lib/x64'), true);

    assert.equal(kept('node_modules/onnxruntime-node/bin/napi-v6/darwin/x64'), false);
    assert.equal(kept('node_modules/onnxruntime-node/bin/napi-v6/win32/x64'), false);
    assert.equal(kept('node_modules/onnxruntime-node/bin/napi-v6/linux/arm64'), false);
    assert.equal(kept('node_modules/node-pty/prebuilds/win32-x64'), false);
    assert.equal(kept('node_modules/node-pty/prebuilds/linux-arm64'), false);

    assert.equal(removed.length, 5);
  });

  it('dryRun reports without deleting', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'gezel-prune-dry-'));
    await mkdir(join(scratch, 'prebuilds/win32-x64'), { recursive: true });
    await writeFile(join(scratch, 'prebuilds/win32-x64/x.node'), Buffer.alloc(2048));

    const { removed, bytes } = await pruneForeignBinaries(scratch, { ...target, dryRun: true });
    assert.equal(removed.length, 1);
    assert.equal(bytes, 2048);
    assert.equal(existsSync(join(scratch, 'prebuilds/win32-x64/x.node')), true);
    await rm(scratch, { recursive: true, force: true });
  });
});
