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
