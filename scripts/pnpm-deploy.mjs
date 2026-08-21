import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

/** Read the flat scalar map used by pnpm's workspace-level overrides. */
export function workspaceOverrides(workspaceSource) {
  const overrides = {};
  const lines = workspaceSource.split(/\r?\n/);
  const start = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (start === -1) return overrides;

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match =
      /^\s{2}(?:"([^"]+)"|'([^']+)'|([^#'"\s][^:]*?)):\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(
        line,
      );
    if (!match) continue;
    overrides[match[1] ?? match[2] ?? match[3]] = match[4] ?? match[5] ?? match[6];
  }
  return overrides;
}

export function pnpmDeployArgs({ filter, target, releaseOverrides = {} }) {
  const args = [
    '--filter',
    filter,
    'deploy',
    '--prod',
    '--config.inject-workspace-packages=true',
    '--node-linker=hoisted',
    '--config.allow-unused-patches=true',
  ];
  if (Object.keys(releaseOverrides).length > 0) {
    args.push('--legacy', `--config.overrides=${JSON.stringify(releaseOverrides)}`);
  }
  args.push(target);
  return args;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** Find the exact registry specs hidden by active workspace-level link overrides. */
export async function registryOverridesForLinks(repoRoot, localLinks) {
  const wanted = new Set(localLinks);
  const manifests = [join(repoRoot, 'package.json')];
  for (const directory of ['packages', 'evals']) {
    const root = join(repoRoot, directory);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    if (directory === 'evals') manifests.push(join(root, 'package.json'));
    for (const entry of entries) {
      if (entry.isDirectory()) manifests.push(join(root, entry.name, 'package.json'));
    }
  }

  const specs = new Map([...wanted].map((name) => [name, new Set()]));
  for (const manifest of manifests) {
    const pkg = JSON.parse(await readFile(manifest, 'utf8').catch(() => '{}'));
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (!wanted.has(name) || typeof spec !== 'string') continue;
        if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) specs.get(name).add(spec);
      }
    }
  }

  return Object.fromEntries(
    [...specs].map(([name, versions]) => {
      if (versions.size !== 1) {
        throw new Error(
          `${name}: expected one exact registry version behind the local link, found ${
            versions.size === 0 ? 'none' : [...versions].join(', ')
          }`,
        );
      }
      return [name, [...versions][0]];
    }),
  );
}

/**
 * Deploy through pnpm's dedicated-lockfile implementation. When a developer
 * has an active sibling link, pnpm cannot derive a deployable package from the
 * shared lockfile, so use legacy deploy with the exact registry version as an
 * override. Callers whose dependency graph cannot contain those links can opt
 * back into dedicated deploy. Every path keeps the workspace file unchanged,
 * and the legacy path restores pnpm's generated checkout metadata afterward.
 */
export async function runIsolatedPnpmDeploy(options) {
  const execPnpmFn = options.execPnpmFn ?? execPnpm;
  const workspaceSource = await readFile(
    join(options.repoRoot, 'pnpm-workspace.yaml'),
    'utf8',
  ).catch(() => '');
  const localLinks = options.ignoreLocalReleaseLinks ? [] : localReleaseLinks(workspaceSource);
  const registryOverrides = await registryOverridesForLinks(options.repoRoot, localLinks);
  const releaseOverrides =
    localLinks.length > 0
      ? { ...workspaceOverrides(workspaceSource), ...registryOverrides }
      : registryOverrides;
  if (localLinks.length > 0) {
    console.log(
      `[${options.label}] local link override(s) in use: ${localLinks.join(', ')} — local validation deploy uses exact registry override(s): ${Object.entries(
        registryOverrides,
      )
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')}`,
    );
  }
  const args = pnpmDeployArgs({
    filter: options.filter,
    target: options.target,
    releaseOverrides,
  });
  console.log(`[${options.label}] pnpm ${args.join(' ')}`);

  return withDependencyReadLease(
    options.repoRoot,
    async () => {
      const workspaceStatePath = join(
        options.repoRoot,
        'node_modules',
        '.pnpm-workspace-state-v1.json',
      );
      const workspaceStateBefore =
        localLinks.length > 0
          ? await readFile(workspaceStatePath).catch((error) => {
              if (error?.code === 'ENOENT') return null;
              throw error;
            })
          : undefined;
      try {
        const result = await execPnpmFn(args, {
          cwd: options.repoRoot,
          env: {
            ...(options.env ?? process.env),
            ...(localLinks.length > 0 ? { GEZEL_SERIALIZED_PNPM_INSTALL: '1' } : {}),
          },
          maxBuffer: 64 * 1024 * 1024,
        });
        if (result.stdout.trim()) process.stdout.write(result.stdout);
        if (result.stderr.trim()) process.stderr.write(result.stderr);
        return result;
      } finally {
        if (workspaceStateBefore === null) await rm(workspaceStatePath, { force: true });
        else if (workspaceStateBefore !== undefined) {
          await writeFile(workspaceStatePath, workspaceStateBefore);
        }
      }
    },
    { command: `pnpm deploy ${options.filter}` },
  );
}
