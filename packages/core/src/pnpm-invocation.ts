/**
 * Config override for every pnpm command that installs or operates inside
 * a relocatable install tree (system toolsets, catalog npm toolsets).
 *
 * Those trees are `pnpm install`ed in a staging directory and renamed into
 * place. pnpm's default isolated linker uses NTFS junctions on Windows,
 * whose targets are stored as absolute paths — after the rename every link
 * dangles and the first cross-package require fails. A hoisted tree
 * contains no links and survives relocation on every platform.
 *
 * Later invocations against the same tree (`pnpm exec playwright …`) must
 * repeat the flag: when the current config disagrees with the linker
 * recorded in `node_modules/.modules.yaml`, pnpm silently rebuilds the
 * tree with the default isolated linker before running the command. Use
 * {@link PNPM_MANAGED_TREE_INSTALL_CONFIG} for installs and
 * {@link PNPM_MANAGED_TREE_EXEC_CONFIG} for every `exec` and `run`, never
 * this flag alone.
 */
export const PNPM_HOISTED_NODE_LINKER = '--config.node-linker=hoisted';

/**
 * Turns off pnpm's dependency check before `exec` and `run`.
 *
 * pnpm 11 checks a tree's install state before running a command in it and,
 * when it decides the tree is stale, first runs a nested `pnpm install`. That
 * nested install does not inherit command-line config, so it never sees
 * {@link PNPM_HOISTED_NODE_LINKER}: it wants to rebuild the hoisted tree with
 * the isolated linker, has no TTY to confirm purging `node_modules`, and
 * aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. Every `exec` against
 * a managed toolset tree failed that way, including the boot-time Chromium
 * download, `run_playwright_script` and page checks.
 *
 * The daemon installs these trees itself and checks their health
 * (`checkInstallTree`), so a command run inside one must never reinstall it.
 */
export const PNPM_SKIP_DEPS_CHECK = '--config.verify-deps-before-run=false';

/**
 * Keeps pnpm from adopting a parent folder's `pnpm-workspace.yaml`.
 *
 * pnpm searches upward for a workspace root. With the Gezel home inside a
 * pnpm workspace (a `--home` in a monorepo, a test home under a checkout),
 * the toolset install reported "Scope: all N workspace projects" and set out
 * to relink that workspace's `node_modules` with the hoisted linker and
 * production dependencies only. Without a TTY it aborted, so the browser
 * tools never installed; with `CI=true` it went ahead and stripped the
 * workspace's dev dependencies (2026-11-21). A managed tree is never part of
 * anyone's workspace.
 */
export const PNPM_IGNORE_WORKSPACE = '--ignore-workspace';

/**
 * The config every `pnpm install` of a managed toolset tree carries: the
 * relocatable linker, and no parent workspace.
 */
export const PNPM_MANAGED_TREE_INSTALL_CONFIG: readonly string[] = [
  PNPM_HOISTED_NODE_LINKER,
  PNPM_IGNORE_WORKSPACE,
];

/**
 * The config every `pnpm exec` or `pnpm run` against a managed toolset tree
 * carries: the tree's own linker, no reinstall before the command runs, and
 * no parent workspace.
 */
export const PNPM_MANAGED_TREE_EXEC_CONFIG: readonly string[] = [
  PNPM_HOISTED_NODE_LINKER,
  PNPM_SKIP_DEPS_CHECK,
  PNPM_IGNORE_WORKSPACE,
];

export interface PnpmInvocationOptions {
  pnpmPath?: string;
  nodePath?: string;
  processExecPath: string;
  platform: NodeJS.Platform;
}

export interface PnpmInvocation {
  command: string;
  args: string[];
  shell: boolean;
  mode: 'node-script' | 'executable' | 'path-fallback';
}

/**
 * Resolve a pnpm launch without assuming that `GEZEL_PNPM_PATH` is an
 * executable. Packaged Gezel points it at pnpm's JavaScript entrypoint
 * and launches that script with the separately bundled Node runtime.
 * Development installs can still point at an executable or fall back to
 * the `pnpm` shim on PATH.
 */
export function resolvePnpmInvocation(
  args: string[],
  options: PnpmInvocationOptions,
): PnpmInvocation {
  const configured = options.pnpmPath?.trim();
  if (configured && /\.(?:cjs|js|mjs)$/i.test(configured)) {
    return {
      command: options.nodePath?.trim() || options.processExecPath,
      args: [configured, ...args],
      shell: false,
      mode: 'node-script',
    };
  }

  if (configured) {
    const extension = configured.match(/(\.[^./\\]+)$/)?.[1]?.toLowerCase() ?? '';
    return {
      command: configured,
      args: [...args],
      shell: options.platform === 'win32' && (extension === '.cmd' || extension === '.bat'),
      mode: 'executable',
    };
  }

  return {
    command: 'pnpm',
    args: [...args],
    shell: options.platform === 'win32',
    mode: 'path-fallback',
  };
}
