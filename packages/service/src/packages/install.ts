import { mkdir, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { formatNpmRegistrySpec } from '@bendyline/gezel';
import { projectMetaFile, projectPrivateDir } from '@bendyline/gezel/paths';
import { realpathContained, safeJoin } from '../fs/safe-paths.js';
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
  let cwd: string;
  let spec: string;
  try {
    cwd = projectPrivateDir(opts.home, opts.projectId);
    spec = formatNpmRegistrySpec(opts.packageName, opts.version);
  } catch (error) {
    return {
      ok: false,
      log: '',
      error: error instanceof Error ? error.message : 'invalid package install request',
    };
  }

  // The package surface installs into the account-private project sidecar,
  // never an arbitrary cwd supplied by the request. Require a canonical
  // project definition first so a guessed id cannot manufacture a new tree.
  const projectFile = projectMetaFile(opts.home, opts.projectId);
  const projectExists = await stat(projectFile)
    .then((entry) => entry.isFile())
    .catch(() => false);
  if (!projectExists) return { ok: false, log: '', error: 'project not found' };

  const projectsRoot = join(opts.home, 'projects');
  const lexical = safeJoin(projectsRoot, opts.projectId);
  if (lexical === null || normalize(lexical) !== normalize(cwd)) {
    return { ok: false, log: '', error: 'unsafe project package destination' };
  }
  if (!(await realpathContained(projectsRoot, cwd))) {
    return { ok: false, log: '', error: 'project package destination escapes its root' };
  }
  await mkdir(cwd, { recursive: true });

  // `--` makes the package spec data even if a future validator regresses.
  const result = await runPnpm(['add', '--', spec], { cwd });
  if (result.ok) return { ok: true, log: result.log };
  return {
    ok: false,
    log: result.log,
    error: `pnpm add exited with code ${result.code ?? 'null'}`,
  };
}
