import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withDependencyReadLease } from './dependency-lease.mjs';
import { execPnpm } from './pnpm-cli.mjs';

export function localReleaseLinks(workspaceSource) {
  return workspaceSource.split(/\r?\n/).flatMap((line) => {
    const match = /^\s{2}["']?(@bendyline\/(?:gilde|squisq(?:[^"':]*)))["']?:\s*["']?link:/.exec(
      line,
    );
    return match ? [match[1]] : [];
  });
}

export function pnpmDeployArgs({ filter, target }) {
  return [
    '--filter',
    filter,
    'deploy',
    '--prod',
    '--config.inject-workspace-packages=true',
    '--node-linker=hoisted',
    '--config.allow-unused-patches=true',
    target,
  ];
}

/**
 * Deploy through pnpm's dedicated-lockfile implementation. Unlike legacy
 * deploy, the nested install is rooted at the target and does not rewrite the
 * checkout's workspace state. It derives resolution from the shared lockfile,
 * so local sibling overrides do not need an in-place workspace-file edit.
 */
export async function runIsolatedPnpmDeploy(options) {
  const execPnpmFn = options.execPnpmFn ?? execPnpm;
  const workspaceSource = await readFile(
    join(options.repoRoot, 'pnpm-workspace.yaml'),
    'utf8',
  ).catch(() => '');
  const localLinks = localReleaseLinks(workspaceSource);
  if (localLinks.length > 0) {
    console.log(
      `[${options.label}] local link override(s) in use: ${localLinks.join(', ')} — dedicated deploy uses the registry resolutions in pnpm-lock.yaml`,
    );
  }
  const args = pnpmDeployArgs({
    filter: options.filter,
    target: options.target,
  });
  console.log(`[${options.label}] pnpm ${args.join(' ')}`);

  return withDependencyReadLease(
    options.repoRoot,
    async () => {
      const result = await execPnpmFn(args, {
        cwd: options.repoRoot,
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.stdout.trim()) process.stdout.write(result.stdout);
      if (result.stderr.trim()) process.stderr.write(result.stderr);
      return result;
    },
    { command: `pnpm deploy ${options.filter}` },
  );
}
