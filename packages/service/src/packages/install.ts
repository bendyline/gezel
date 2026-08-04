import { projectPrivateDir } from '@bendyline/gezel/paths';
import { runPnpm } from './pnpm.js';

export interface InstallPackageOptions {
  home: string;
  projectId: string;
  packageName: string;
  version?: string;
}

export interface InstallResult {
  ok: boolean;
  log: string;
  error?: string;
}

/**
 * Runs `pnpm add --ignore-scripts <pkg>` inside a project directory.
 * Each project has its own package.json + node_modules as its toolbox.
 * `--ignore-scripts` is forced by `runPnpm` — post-install hooks are a
 * supply-chain vector we don't accept. pnpm resolves from the bundled
 * script + Node runtime, falling back to `pnpm` on PATH.
 */
export async function installPackage(opts: InstallPackageOptions): Promise<InstallResult> {
  const cwd = projectPrivateDir(opts.home, opts.projectId);
  const spec = opts.version ? `${opts.packageName}@${opts.version}` : opts.packageName;
  const result = await runPnpm(['add', spec], { cwd });
  if (result.ok) return { ok: true, log: result.log };
  return {
    ok: false,
    log: result.log,
    error: `pnpm add exited with code ${result.code ?? 'null'}`,
  };
}
