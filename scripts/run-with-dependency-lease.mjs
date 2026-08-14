#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withDependencyReadLease } from './dependency-lease.mjs';
import { spawnPnpm } from './pnpm-cli.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('close', (code, signal) => resolveChild({ code, signal }));
  });
}

export async function runWithDependencyReadLease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const script = options.script;
  if (!script) throw new Error('Expected an internal pnpm script name');
  const args = options.args ?? [];
  const inheritedEnv = options.env ?? process.env;

  return withDependencyReadLease(
    repoRoot,
    async ({ leaseEnv, setChildPid }) => {
      const childArgs = ['run', script, ...(args.length > 0 ? ['--', ...args] : [])];
      const child = (options.spawnPnpmFn ?? spawnPnpm)(childArgs, {
        cwd: repoRoot,
        env: { ...inheritedEnv, ...leaseEnv },
        stdio: 'inherit',
      });
      const completion = waitForChild(child);
      await setChildPid(child.pid);
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
          console.error(`[dependency-lease] ${script} exited on ${signal}`);
          return 1;
        }
        return code ?? 1;
      } finally {
        process.off('SIGINT', forwardSigint);
        process.off('SIGTERM', forwardSigterm);
      }
    },
    { command: `pnpm ${script}`, env: inheritedEnv },
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [script, ...args] = process.argv.slice(2);
  runWithDependencyReadLease({ script, args }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[dependency-lease] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
