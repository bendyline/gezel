import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixDeployedNodePtyPermissions } from './fix-deployed-node-pty-perms.mjs';

test('repairs a copied node-pty macOS helper idempotently', async (t) => {
  if (process.platform !== 'darwin') return;
  const root = await mkdtemp(join(tmpdir(), 'gezel-deployed-pty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64');
  const helper = join(dir, 'spawn-helper');
  await mkdir(dir, { recursive: true });
  await writeFile(helper, '#!/bin/sh\n');
  await chmod(helper, 0o644);

  assert.equal(await fixDeployedNodePtyPermissions(root), 1);
  assert.equal((await stat(helper)).mode & 0o111, 0o111);
  assert.equal(await fixDeployedNodePtyPermissions(root), 0);
});
