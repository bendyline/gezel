import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixNodePtyPermissions } from './node-pty-permissions.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fixNodePtyPermissions', () => {
  it('restores and preserves execute permission on the active macOS helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-node-pty-'));
    roots.push(root);
    const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    await mkdir(join(root, 'prebuilds', 'darwin-arm64'), { recursive: true });
    await writeFile(helper, '#!/bin/sh\n');
    await chmod(helper, 0o640);

    expect(fixNodePtyPermissions({ platform: 'darwin', arch: 'arm64', nodePtyRoot: root })).toBe(1);
    expect((await stat(helper)).mode & 0o111).toBe(0o111);
    expect(fixNodePtyPermissions({ platform: 'darwin', arch: 'arm64', nodePtyRoot: root })).toBe(0);
  });

  it('does nothing on non-macOS platforms', () => {
    expect(fixNodePtyPermissions({ platform: 'linux', arch: 'x64', nodePtyRoot: '/missing' })).toBe(
      0,
    );
  });
});
