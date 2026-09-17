#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withDependencyReadLease } from './dependency-lease.mjs';
import { spawnPnpm } from './pnpm-cli.mjs';
import { runPreparedFrozenInstall, withPnpmInstallLock } from './pnpm-install.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('close', (code, signal) => resolveChild({ code, signal }));
  });
}

async function runValidationChild(options) {
  return runPnpmScriptChild(options, 'validate:unlocked');
}

async function runCoverageChild(options) {
  return runPnpmScriptChild(options, 'test:coverage:unleased');
}

async function runPnpmScriptChild(options, script) {
  const child = (options.spawnPnpmFn ?? spawnPnpm)(['run', script], {
    cwd: options.repoRoot,
    env: options.env,
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
      console.error(`[validate] ${script} exited on ${signal}`);
      return 1;
    }
    return code ?? 1;
  } finally {
    process.off('SIGINT', forwardSigint);
    process.off('SIGTERM', forwardSigterm);
  }
}

/** Keep dependency mutations out of the checkout for the entire quality gate. */
export async function runWorkspaceValidation(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const install = options.install ?? false;
  const coverage = options.coverage ?? false;
  const inheritedEnv = options.env ?? process.env;
  const runInstallFn = options.runInstallFn ?? runPreparedFrozenInstall;
  const runValidationFn = options.runValidationFn ?? runValidationChild;
  const runCoverageFn = options.runCoverageFn ?? runCoverageChild;

  const withLease = install ? withPnpmInstallLock : withDependencyReadLease;
  return withLease(
    repoRoot,
    async ({ setChildPid, leaseEnv }) => {
      const env = { ...inheritedEnv, ...leaseEnv };
      if (install) {
        const installCode = await runInstallFn({
          repoRoot,
          args: [],
          allowPurge: false,
          env,
          setChildPid,
        });
        if (installCode !== 0) return installCode;
      }
      const childOptions = {
        repoRoot,
        env,
        setChildPid,
        ...(options.spawnPnpmFn ? { spawnPnpmFn: options.spawnPnpmFn } : {}),
      };
      const validationCode = await runValidationFn(childOptions);
      if (validationCode !== 0 || !coverage) return validationCode;
      return runCoverageFn(childOptions);
    },
    {
      command: coverage ? 'pnpm all' : install ? 'pnpm deps:validate' : 'pnpm validate',
      env: inheritedEnv,
    },
  );
}

export function parseWorkspaceValidationArgs(argv) {
  return { install: argv.includes('--install'), coverage: argv.includes('--coverage') };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { install, coverage } = parseWorkspaceValidationArgs(process.argv.slice(2));
  runWorkspaceValidation({ install, coverage }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[validate] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
