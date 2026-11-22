import { describe, expect, it } from 'vitest';
import {
  PNPM_HOISTED_NODE_LINKER,
  PNPM_IGNORE_WORKSPACE,
  PNPM_MANAGED_TREE_EXEC_CONFIG,
  PNPM_MANAGED_TREE_INSTALL_CONFIG,
  PNPM_SKIP_DEPS_CHECK,
  resolvePnpmInvocation,
} from './pnpm-invocation.js';

describe('PNPM_MANAGED_TREE_EXEC_CONFIG', () => {
  it('keeps the hoisted linker and stops pnpm reinstalling the tree before exec', () => {
    // pnpm 11's pre-exec dependency check runs a nested install that drops
    // command-line config and aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
    expect(PNPM_SKIP_DEPS_CHECK).toBe('--config.verify-deps-before-run=false');
    expect(PNPM_MANAGED_TREE_EXEC_CONFIG).toEqual([
      PNPM_HOISTED_NODE_LINKER,
      PNPM_SKIP_DEPS_CHECK,
      PNPM_IGNORE_WORKSPACE,
    ]);
  });
});

describe('managed trees and a parent pnpm workspace', () => {
  // A Gezel home inside a pnpm workspace made the toolset install act on that
  // workspace; with CI=true it stripped the workspace's dev dependencies.
  it('installs and execs with the parent workspace ignored', () => {
    expect(PNPM_IGNORE_WORKSPACE).toBe('--ignore-workspace');
    expect(PNPM_MANAGED_TREE_INSTALL_CONFIG).toEqual([
      PNPM_HOISTED_NODE_LINKER,
      PNPM_IGNORE_WORKSPACE,
    ]);
    expect(PNPM_MANAGED_TREE_EXEC_CONFIG).toContain(PNPM_IGNORE_WORKSPACE);
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
