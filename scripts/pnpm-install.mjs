#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dependencyLeasePath, withDependencyMutationLease } from './dependency-lease.mjs';
import { spawnPnpm } from './pnpm-cli.mjs';
import { inspectWindowsDependencyLocks } from './windows-dependency-locks.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');
const SERIALIZED_INSTALL_ENV = 'GEZEL_SERIALIZED_PNPM_INSTALL';

export const pnpmInstallLockPath = dependencyLeasePath;

/** Backward-compatible name for the checkout's exclusive dependency mutation lease. */
export const withPnpmInstallLock = withDependencyMutationLease;

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('close', (code, signal) => resolveChild({ code, signal }));
  });
}

function workspacePackageDirs(repoRoot) {
  const packageDirs = [repoRoot];
  for (const container of ['packages', 'evals']) {
    const containerPath = join(repoRoot, container);
    if (!existsSync(containerPath)) continue;
    if (existsSync(join(containerPath, 'package.json'))) packageDirs.push(containerPath);
    if (container !== 'packages') continue;
    for (const entry of readdirSync(containerPath, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(containerPath, entry.name, 'package.json'))) {
        packageDirs.push(join(containerPath, entry.name));
      }
    }
  }
  return packageDirs;
}

function normalizedPath(path) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function workspaceStructureIssue(repoRoot) {
  const statePath = join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json');
  if (!existsSync(statePath)) return 'pnpm workspace-state metadata is missing';
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return 'pnpm workspace-state metadata is invalid';
  }

  const currentProjects = new Map(
    workspacePackageDirs(repoRoot).map((packageDir) => {
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
      return [
        normalizedPath(packageDir),
        { name: manifest.name, version: manifest.version ?? '0.0.0' },
      ];
    }),
  );
  const installedProjects = new Map(
    Object.entries(state.projects ?? {}).map(([packageDir, project]) => [
      normalizedPath(packageDir),
      { name: project.name, version: project.version ?? '0.0.0' },
    ]),
  );
  if (currentProjects.size !== installedProjects.size) {
    return `workspace project count changed (${installedProjects.size} installed, ${currentProjects.size} current)`;
  }
  for (const [packageDir, current] of currentProjects) {
    const installed = installedProjects.get(packageDir);
    if (!installed)
      return `workspace package was added or moved: ${relative(repoRoot, packageDir)}`;
    if (installed.name !== current.name || installed.version !== current.version) {
      return `workspace package identity changed: ${relative(repoRoot, packageDir)}`;
    }
  }
  return null;
}

export function lockfileValidationIssue(repoRoot) {
  const statePath = join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json');
  const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
  if (!existsSync(statePath) || !existsSync(lockfilePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const validatedAt = Number(state.lastValidatedTimestamp);
    if (Number.isFinite(validatedAt) && statSync(lockfilePath).mtimeMs > validatedAt) {
      return 'lockfile timestamp is newer than pnpm workspace-state metadata';
    }
  } catch {}
  return null;
}

export function installedLockfileIssue(repoRoot) {
  const wantedPath = join(repoRoot, 'pnpm-lock.yaml');
  const installedPath = join(repoRoot, 'node_modules', '.pnpm', 'lock.yaml');
  if (!existsSync(wantedPath)) return 'pnpm-lock.yaml is missing';
  if (!existsSync(installedPath)) return 'installed dependency lock is missing';
  try {
    if (!readFileSync(wantedPath).equals(readFileSync(installedPath))) {
      return 'installed dependency lock differs from pnpm-lock.yaml';
    }
  } catch {
    return 'installed dependency lock could not be compared with pnpm-lock.yaml';
  }
  return null;
}

function dependencyLinkPath(packageDir, dependency) {
  return join(packageDir, 'node_modules', ...dependency.split('/'));
}

/** Find direct dependency links that pnpm's optimistic repeat-install can overlook. */
export function missingWorkspaceDependencyLinks(repoRoot) {
  const missing = [];
  for (const packageDir of workspacePackageDirs(repoRoot)) {
    const manifestPath = join(packageDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies)) {
      if (!existsSync(dependencyLinkPath(packageDir, dependency))) {
        missing.push({
          packageDir,
          packageName: manifest.name ?? (relative(repoRoot, packageDir) || '.'),
          dependency,
        });
      }
    }
  }
  return missing;
}

const LOCKFILE_IMPORTER_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

function yamlKey(line) {
  const key = /^(.*):\s*(?:\{\}|\[\])?\s*$/.exec(line.trim())?.[1] ?? line.trim();
  return /^(['"]).*\1$/.test(key) ? key.slice(1, -1) : key;
}

/**
 * Direct dependency versions the committed lockfile expects, keyed by importer
 * directory (repo-relative, `.` for the root) then dependency name.
 *
 * Line-oriented rather than a real YAML parse: `scripts/` runs on bare node
 * before any install has happened, so it has no YAML dependency to reach for,
 * and the `importers:` block has had a fixed indentation shape since lockfile
 * v9. Anything it cannot read confidently is simply absent from the map, which
 * callers treat as "no opinion" rather than as drift.
 */
export function lockfileDirectDependencies(repoRoot) {
  const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');
  if (!existsSync(lockfilePath)) return null;
  const byImporter = new Map();
  let inImporters = false;
  let importer = null;
  let section = null;
  let dependency = null;
  for (const line of readFileSync(lockfilePath, 'utf8').split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inImporters = line.startsWith('importers:');
      importer = section = dependency = null;
      continue;
    }
    if (!inImporters) continue;
    if (indent === 2) {
      importer = yamlKey(line);
      section = dependency = null;
      if (!byImporter.has(importer)) byImporter.set(importer, new Map());
      continue;
    }
    if (indent === 4) {
      section = LOCKFILE_IMPORTER_SECTIONS.has(yamlKey(line)) ? yamlKey(line) : null;
      dependency = null;
      continue;
    }
    if (indent === 6) {
      dependency = section ? yamlKey(line) : null;
      continue;
    }
    if (indent === 8 && importer && dependency) {
      const version = /^version:\s*(.+?)\s*$/.exec(line.trim())?.[1];
      if (version) byImporter.get(importer).set(dependency, version);
    }
  }
  return byImporter;
}

/** The version pnpm actually materialized for a link, or null if unreadable. */
function installedLinkVersion(linkPath) {
  try {
    return JSON.parse(readFileSync(join(linkPath, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Direct dependency links that exist but resolve to a version the committed
 * lockfile does not ask for — what a pin bump pulled from another machine
 * leaves behind, since the symlink is replaced rather than removed and so
 * stays invisible to an existence check.
 *
 * Only links resolving into this checkout's virtual store are judged. A link
 * pointing anywhere else is a workspace package or a deliberate local override
 * (`pnpm link:gilde`, `link:squisq`), and the documented linked-checkout
 * workflow must not read as drift.
 */
export function staleWorkspaceDependencyLinks(repoRoot) {
  const expectedByImporter = lockfileDirectDependencies(repoRoot);
  if (!expectedByImporter) return [];
  // Both sides are realpath'd before comparison: the link resolves through the
  // store's real location, so a checkout reached by a symlinked path (macOS
  // /var, a mounted volume) would otherwise never match its own store.
  const virtualStoreRoot = join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(virtualStoreRoot)) return [];
  const virtualStore = `${normalizedPath(realpathSync(virtualStoreRoot))}${sep}`;
  const stale = [];
  for (const packageDir of workspacePackageDirs(repoRoot)) {
    const manifestPath = join(packageDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const importer = relative(repoRoot, packageDir).replaceAll('\\', '/') || '.';
    const expectedVersions = expectedByImporter.get(importer);
    if (!expectedVersions) continue;
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies)) {
      const locked = expectedVersions.get(dependency);
      if (!locked) continue;
      const linkPath = dependencyLinkPath(packageDir, dependency);
      if (!existsSync(linkPath)) continue;
      let resolved;
      try {
        resolved = normalizedPath(realpathSync(linkPath));
      } catch {
        continue;
      }
      if (!resolved.startsWith(virtualStore)) continue;
      // Peer-disambiguated versions carry a `(peer@x)` suffix the package's own
      // manifest never does.
      const expected = locked.split('(')[0].trim();
      const installed = installedLinkVersion(linkPath);
      if (installed === null || installed === expected) continue;
      stale.push({
        packageDir,
        packageName: manifest.name ?? importer,
        dependency,
        expected,
        installed,
      });
    }
  }
  return stale;
}

function workspaceDependencyMarkersReady(repoRoot) {
  const binSuffix = process.platform === 'win32' ? '.cmd' : '';
  return (
    existsSync(join(repoRoot, 'node_modules', '.pnpm')) &&
    existsSync(join(repoRoot, 'node_modules', '.modules.yaml')) &&
    existsSync(join(repoRoot, 'packages', 'ui', 'node_modules', '.bin', `vite${binSuffix}`)) &&
    existsSync(join(repoRoot, 'packages', 'app', 'node_modules', '.bin', `electron${binSuffix}`))
  );
}

export function workspaceDependenciesReady(repoRoot) {
  return (
    workspaceDependencyMarkersReady(repoRoot) &&
    missingWorkspaceDependencyLinks(repoRoot).length === 0
  );
}

export function dependencyStatus(repoRoot) {
  const markersReady = workspaceDependencyMarkersReady(repoRoot);
  const missingLinks = missingWorkspaceDependencyLinks(repoRoot);
  const staleLinks = staleWorkspaceDependencyLinks(repoRoot);
  const installedIssue = installedLockfileIssue(repoRoot);
  const workspaceIssue = workspaceStructureIssue(repoRoot);
  const usable = markersReady && missingLinks.length === 0;
  return {
    usable,
    synchronized: usable && staleLinks.length === 0 && !installedIssue && !workspaceIssue,
    markersReady,
    missingLinks,
    staleLinks,
    installedLockfileIssue: installedIssue,
    lockfileValidationIssue: lockfileValidationIssue(repoRoot),
    workspaceStructureIssue: workspaceIssue,
  };
}

export function reportDependencyStatus(repoRoot, options = {}) {
  const status = dependencyStatus(repoRoot);
  const write = options.write ?? console.log;
  write(`[deps:status] generated dependencies: ${status.usable ? 'usable' : 'incomplete'}`);
  if (!status.markersReady)
    write('[deps:status] required workspace markers or binaries are missing');
  for (const missing of status.missingLinks) {
    write(`[deps:status] missing ${missing.dependency} for ${missing.packageName}`);
  }
  for (const stale of status.staleLinks ?? []) {
    write(
      `[deps:status] stale ${stale.dependency} for ${stale.packageName}: installed ${stale.installed}, lockfile wants ${stale.expected}`,
    );
  }
  if (status.installedLockfileIssue) {
    write(`[deps:status] synchronization required: ${status.installedLockfileIssue}`);
  }
  if (status.workspaceStructureIssue) {
    write(`[deps:status] metadata warning: ${status.workspaceStructureIssue}`);
  }
  if (status.lockfileValidationIssue) {
    write(`[deps:status] metadata warning: ${status.lockfileValidationIssue}`);
  }
  if (status.usable && (status.workspaceStructureIssue || status.lockfileValidationIssue))
    write('[deps:status] existing tools remain usable; this warning does not authorize a repair');
  write(
    status.synchronized
      ? '[deps:status] no dependency mutation is required for ordinary build/test/lint commands'
      : status.usable
        ? '[deps:status] existing tools are usable; `pnpm deps:install` will safely synchronize them'
        : '[deps:status] run `pnpm deps:install` only when dependency installation is intended',
  );
  return status;
}

export async function dependencyInputsFingerprint(repoRoot) {
  const paths = [
    join(repoRoot, 'pnpm-lock.yaml'),
    join(repoRoot, 'pnpm-workspace.yaml'),
    ...workspacePackageDirs(repoRoot).map((packageDir) => join(packageDir, 'package.json')),
  ];
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    hash.update(relative(repoRoot, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path).catch(() => Buffer.from('<missing>')));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Direct dependency links that are absent or resolve to the wrong version. */
export function unsynchronizedWorkspaceDependencyLinks(repoRoot) {
  return [...missingWorkspaceDependencyLinks(repoRoot), ...staleWorkspaceDependencyLinks(repoRoot)];
}

function missingInstallArgs(repoRoot, args) {
  const repairedArgs = [...args];
  if (!repairedArgs.includes('--config.optimistic-repeat-install=false')) {
    repairedArgs.push('--config.optimistic-repeat-install=false');
  }

  // A missing root marker means the whole generated tree is incomplete. When
  // the markers are intact, constrain reconciliation to packages whose direct
  // links are absent or point at the wrong version, so one damaged symlink or
  // one bumped pin does not trigger a full workspace reinstall.
  if (!workspaceDependencyMarkersReady(repoRoot)) return repairedArgs;
  const filters = new Set(
    unsynchronizedWorkspaceDependencyLinks(repoRoot).map(({ packageDir }) => {
      const packagePath = relative(repoRoot, packageDir).replaceAll('\\', '/');
      return packagePath ? `./${packagePath}` : '.';
    }),
  );
  for (const filter of filters) repairedArgs.push('--filter', filter);
  return repairedArgs;
}

function reportDependencyLockOwners(owners) {
  if (owners.length === 0) return;
  console.error('[pnpm-install] Windows has a generated dependency file open:');
  for (const owner of owners) {
    console.error(
      `  ${owner.appName} (${owner.processName}, pid ${owner.processId}) holds ${owner.file}`,
    );
  }
  console.error('');
  console.error('Close the listed app or workspace, then rerun the intended dependency command.');
  console.error('The install was stopped before pnpm could rewrite node_modules.');
}

/** Run pnpm install after the caller has acquired the checkout mutation lock. */
export async function runPnpmInstallChild(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const args = options.args ?? [];
  const command = `pnpm install${args.length > 0 ? ` ${args.join(' ')}` : ''}`;

  console.log(`[pnpm-install] ${command}`);
  const child = (options.spawnPnpmFn ?? spawnPnpm)(['install', ...args], {
    cwd: repoRoot,
    env: {
      ...(options.env ?? process.env),
      [SERIALIZED_INSTALL_ENV]: '1',
    },
    stdio: 'inherit',
  });
  const completion = waitForChild(child);
  await options.setChildPid?.(child.pid);
  const forwardSigint = () => {
    if (!child.killed) child.kill('SIGINT');
  };
  const forwardSigterm = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);
  try {
    const { code, signal } = await completion;
    if (signal) {
      console.error(`[pnpm-install] pnpm exited on ${signal}`);
      return 1;
    }
    return code ?? 1;
  } finally {
    process.off('SIGINT', forwardSigint);
    process.off('SIGTERM', forwardSigterm);
  }
}

export async function runPnpmFetchChild(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const args = options.args ?? ['--frozen-lockfile'];
  const stagingRoot = await mkdtemp(join(options.stagingParent ?? tmpdir(), 'gezel-pnpm-fetch-'));
  const stagingModules = join(stagingRoot, 'node_modules');
  const stagingVirtualStore = join(stagingModules, '.pnpm');
  console.log(`[pnpm-install] pnpm fetch ${args.join(' ')} (isolated staging directory)`);
  try {
    // pnpm 11's fetch command intentionally writes a virtual-store-only
    // modules layout with empty hoist patterns. Pointing it at an existing
    // workspace makes pnpm treat that live node_modules as incompatible and
    // offer to purge it. Both paths are explicit here so fetch can populate
    // the shared content-addressable store without ever opening the live
    // modules manifest or virtual store.
    const child = (options.spawnPnpmFn ?? spawnPnpm)(
      [
        'fetch',
        ...args,
        '--modules-dir',
        stagingModules,
        '--virtual-store-dir',
        stagingVirtualStore,
      ],
      {
        cwd: repoRoot,
        env: options.env ?? process.env,
        stdio: 'inherit',
      },
    );
    const completion = waitForChild(child);
    await options.setChildPid?.(child.pid);
    const { code, signal } = await completion;
    if (signal) {
      console.error(`[pnpm-install] pnpm fetch exited on ${signal}`);
      return 1;
    }
    return code ?? 1;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function safeFrozenInstallArgs(args, allowPurge) {
  if (args.some((arg) => arg === '--frozen-lockfile=false' || arg === '--no-frozen-lockfile')) {
    throw new Error('Safe dependency installation requires the committed frozen lockfile');
  }
  if (args.includes('--lockfile-only')) {
    throw new Error('A node_modules install cannot also be lockfile-only');
  }
  const result = args.filter(
    (arg) =>
      arg !== '--offline' &&
      arg !== '--frozen-lockfile' &&
      !arg.startsWith('--config.confirm-modules-purge='),
  );
  result.push('--offline', '--frozen-lockfile');
  if (allowPurge) result.push('--config.confirm-modules-purge=false');
  return result;
}

/** Fetch every locked package in isolation before pnpm may touch the live node_modules. */
export async function runPreparedFrozenInstall(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const fingerprintBefore = await dependencyInputsFingerprint(repoRoot);
  const fetchCode = await (options.runFetchFn ?? runPnpmFetchChild)({
    repoRoot,
    args: ['--frozen-lockfile'],
    env: options.env,
    spawnPnpmFn: options.spawnPnpmFn,
    setChildPid: options.setChildPid,
  });
  if (fetchCode !== 0) {
    console.error('[pnpm-install] fetch failed; node_modules was left untouched');
    return fetchCode;
  }
  const fingerprintAfter = await dependencyInputsFingerprint(repoRoot);
  if (fingerprintAfter !== fingerprintBefore) {
    console.error(
      '[pnpm-install] dependency inputs changed during fetch; node_modules was left untouched',
    );
    return 1;
  }
  return (options.runInstallFn ?? runPnpmInstallChild)({
    repoRoot,
    args: safeFrozenInstallArgs(options.args ?? [], options.allowPurge ?? false),
    env: options.env,
    spawnPnpmFn: options.spawnPnpmFn,
    setChildPid: options.setChildPid,
  });
}

/** Refresh a lockfile without touching node_modules, then perform a prepared offline install. */
export async function runLockfileRefreshAndInstall(options = {}) {
  const args = options.args ?? [];
  const lockfileCode = await runPnpmInstallChild({
    ...options,
    args: [...args, '--lockfile-only'],
  });
  if (lockfileCode !== 0) {
    console.error('[pnpm-install] lockfile refresh failed; node_modules was left untouched');
    return lockfileCode;
  }
  return runPreparedFrozenInstall({ ...options, args, allowPurge: false });
}

export async function runSerializedPnpmInstall(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const args = options.args ?? [];
  const repair = options.repair ?? false;
  const command = repair ? 'pnpm deps:repair' : 'pnpm deps:install';

  return withPnpmInstallLock(
    repoRoot,
    async ({ setChildPid, leaseEnv }) => {
      if (!repair && dependencyStatus(repoRoot).synchronized) {
        console.log('[pnpm-install] dependencies already present');
        return 0;
      }

      const installArgs = repair ? args : missingInstallArgs(repoRoot, args);

      const lockOwners = (options.dependencyLockProbeFn ?? inspectWindowsDependencyLocks)(repoRoot);
      if (lockOwners.length > 0) {
        reportDependencyLockOwners(lockOwners);
        return 1;
      }

      const installCode = await runPreparedFrozenInstall({
        repoRoot,
        args: installArgs,
        allowPurge: repair,
        env: { ...(options.env ?? process.env), ...leaseEnv },
        runFetchFn: options.runFetchFn,
        runInstallFn: options.runInstallFn,
        spawnPnpmFn: options.spawnPnpmFn,
        setChildPid,
      });
      if (installCode !== 0) return installCode;

      // pnpm reports success per the importers it was asked to touch, so a
      // filtered reconciliation can exit 0 while another importer still holds
      // a link the lockfile has moved off. Callers treat a 0 here as "the tree
      // now matches the lockfile" and go straight on to build and test, so
      // that claim is verified rather than assumed.
      const unsynchronized = unsynchronizedWorkspaceDependencyLinks(repoRoot);
      if (unsynchronized.length > 0) {
        console.error(`[pnpm-install] ${command} finished but the tree still differs:`);
        for (const entry of unsynchronized) {
          console.error(
            entry.installed
              ? `  ${entry.dependency} for ${entry.packageName}: installed ${entry.installed}, lockfile wants ${entry.expected}`
              : `  ${entry.dependency} for ${entry.packageName}: link is missing`,
          );
        }
        console.error('[pnpm-install] run `pnpm deps:repair` to rebuild the affected packages');
        return 1;
      }
      return 0;
    },
    {
      command,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    },
  );
}

export function parsePnpmInstallArgs(argv) {
  const args = [...argv];
  const repairIndex = args.indexOf('--repair');
  const repair = repairIndex !== -1;
  if (repair) args.splice(repairIndex, 1);
  const confirmIndex = args.indexOf('--confirm-repair');
  const confirmRepair = confirmIndex !== -1;
  if (confirmRepair) args.splice(confirmIndex, 1);
  const statusIndex = args.indexOf('--status');
  const status = statusIndex !== -1;
  if (status) args.splice(statusIndex, 1);
  const ifMissingIndex = args.indexOf('--if-missing');
  if (ifMissingIndex !== -1) args.splice(ifMissingIndex, 1);
  if (args[0] === '--') args.shift();
  return { args, confirmRepair, repair, status };
}

async function confirmRepairInTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      'Dependency repair may rebuild node_modules after a successful fetch. Continue? [y/N] ',
    );
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const parsed = parsePnpmInstallArgs(process.argv.slice(2));
  const run = async () => {
    if (parsed.status) {
      reportDependencyStatus(defaultRepoRoot);
      return 0;
    }
    if (parsed.repair && !parsed.confirmRepair && !(await confirmRepairInTerminal())) {
      console.error('[pnpm-install] dependency repair was not authorized');
      console.error(
        '[pnpm-install] non-interactive callers need explicit user approval and --confirm-repair',
      );
      return 1;
    }
    return runSerializedPnpmInstall({ args: parsed.args, repair: parsed.repair });
  };
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[pnpm-install] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
