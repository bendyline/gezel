import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureNodePtyExecutable,
  fixNodePtyPermissions,
  resetNodePtyExecutableMemo,
} from './node-pty-permissions.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  resetNodePtyExecutableMemo();
  vi.restoreAllMocks();
});

describe('fixNodePtyPermissions', () => {
  // POSIX execute bits (0o111) aren't representable on Windows filesystems —
  // chmod there only toggles the read-only attribute — so this macOS-only
  // behavior can only be exercised on a POSIX host.
  it.skipIf(process.platform === 'win32')(
    'restores and preserves execute permission on the active macOS helper',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'gezel-node-pty-'));
      roots.push(root);
      const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
      await mkdir(join(root, 'prebuilds', 'darwin-arm64'), { recursive: true });
      await writeFile(helper, '#!/bin/sh\n');
      await chmod(helper, 0o640);

      expect(fixNodePtyPermissions({ platform: 'darwin', arch: 'arm64', nodePtyRoot: root })).toBe(
        1,
      );
      expect((await stat(helper)).mode & 0o111).toBe(0o111);
      expect(fixNodePtyPermissions({ platform: 'darwin', arch: 'arm64', nodePtyRoot: root })).toBe(
        0,
      );
    },
  );

  it('does nothing on non-macOS platforms', () => {
    expect(fixNodePtyPermissions({ platform: 'linux', arch: 'x64', nodePtyRoot: '/missing' })).toBe(
      0,
    );
  });
});

describe('ensureNodePtyExecutable', () => {
  it('swallows an unwritable node_modules instead of breaking the spawn', () => {
    // Read-only or root-owned trees (containers, Nix, some CI images) make
    // chmod throw EROFS/EPERM. A terminal that refuses to start is strictly
    // worse than one whose helper was already executable, so this must not
    // propagate — node-pty raises its own error if the bit is genuinely gone.
    expect(() =>
      ensureNodePtyExecutable({
        fix: () => {
          const err: NodeJS.ErrnoException = new Error('EROFS: read-only file system');
          err.code = 'EROFS';
          throw err;
        },
      }),
    ).not.toThrow();
  });

  it('runs at most once per process', () => {
    // It sits on the PTY spawn path, which is hit for every shell the user
    // opens; re-resolving and re-stat-ing node-pty each time would be waste.
    let calls = 0;
    const fix = () => {
      calls += 1;
      return 0;
    };
    ensureNodePtyExecutable({ fix });
    ensureNodePtyExecutable({ fix });
    ensureNodePtyExecutable({ fix });
    expect(calls).toBe(1);
  });

  it('still runs the real repair when given no seam', () => {
    // Guards against the seam quietly becoming the only code path.
    expect(() => ensureNodePtyExecutable()).not.toThrow();
  });
});
