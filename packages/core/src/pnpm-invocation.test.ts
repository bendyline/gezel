import { describe, expect, it } from 'vitest';
import {
  PNPM_HOISTED_NODE_LINKER,
  PNPM_MANAGED_TREE_EXEC_CONFIG,
  PNPM_SKIP_DEPS_CHECK,
  resolvePnpmInvocation,
} from './pnpm-invocation.js';

describe('PNPM_MANAGED_TREE_EXEC_CONFIG', () => {
  it('keeps the hoisted linker and stops pnpm reinstalling the tree before exec', () => {
    // pnpm 11's pre-exec dependency check runs a nested install that drops
    // command-line config and aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
    expect(PNPM_SKIP_DEPS_CHECK).toBe('--config.verify-deps-before-run=false');
    expect(PNPM_MANAGED_TREE_EXEC_CONFIG).toEqual([PNPM_HOISTED_NODE_LINKER, PNPM_SKIP_DEPS_CHECK]);
  });
});

describe('resolvePnpmInvocation', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    it(`launches a bundled JavaScript entry with bundled Node on ${platform}`, () => {
      expect(
        resolvePnpmInvocation(['install'], {
          pnpmPath: '/bundle/bin/pnpm.mjs',
          nodePath: '/bundle/node',
          processExecPath: '/electron',
          platform,
        }),
      ).toEqual({
        command: '/bundle/node',
        args: ['/bundle/bin/pnpm.mjs', 'install'],
        shell: false,
        mode: 'node-script',
      });
    });
  }

  it('uses the current Node-compatible executable when no bundled Node path is configured', () => {
    expect(
      resolvePnpmInvocation(['--version'], {
        pnpmPath: '/bundle/bin/pnpm.mjs',
        processExecPath: '/usr/bin/node',
        platform: 'linux',
      }).command,
    ).toBe('/usr/bin/node');
  });

  it('uses the shell for the Windows PATH shim only', () => {
    expect(
      resolvePnpmInvocation([], {
        processExecPath: 'node.exe',
        platform: 'win32',
      }),
    ).toMatchObject({ command: 'pnpm', shell: true, mode: 'path-fallback' });
    expect(
      resolvePnpmInvocation([], {
        processExecPath: 'node',
        platform: 'linux',
      }),
    ).toMatchObject({ command: 'pnpm', shell: false, mode: 'path-fallback' });
  });

  it('distinguishes Windows command shims from native executables', () => {
    expect(
      resolvePnpmInvocation([], {
        pnpmPath: 'C:\\tools\\pnpm.cmd',
        processExecPath: 'node.exe',
        platform: 'win32',
      }).shell,
    ).toBe(true);
    expect(
      resolvePnpmInvocation([], {
        pnpmPath: 'C:\\tools\\pnpm.exe',
        processExecPath: 'node.exe',
        platform: 'win32',
      }).shell,
    ).toBe(false);
  });
});
