#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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

async function runLeasedChild(options) {
  const { repoRoot, command, inheritedEnv, spawnChild } = options;
  return withDependencyReadLease(
    repoRoot,
    async ({ leaseEnv, setChildPid }) => {
      const child = spawnChild({ ...inheritedEnv, ...leaseEnv });
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
          console.error(`[dependency-lease] ${command} exited on ${signal}`);
          return 1;
        }
        return code ?? 1;
      } finally {
        process.off('SIGINT', forwardSigint);
        process.off('SIGTERM', forwardSigterm);
      }
    },
    { command, env: inheritedEnv },
  );
}

export async function runWithDependencyReadLease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const script = options.script;
  if (!script) throw new Error('Expected an internal pnpm script name');
  const args = options.args ?? [];
  // pnpm includes the conventional script separator in process.argv when the
  // caller writes `pnpm <script> -- <args>`. Its `run` command does not need a
  // separator when we invoke the internal script, though: adding one here is
  // forwarded literally to strict child CLIs (`tsx ... -- --list`). Accept
  // both public invocation styles and pass only the actual script arguments.
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
  const inheritedEnv = options.env ?? process.env;

  return runLeasedChild({
    repoRoot,
    command: `pnpm ${script}`,
    inheritedEnv,
    spawnChild: (env) => {
      const childArgs = ['run', script, ...forwardedArgs];
      return (options.spawnPnpmFn ?? spawnPnpm)(childArgs, {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
      });
    },
  });
}

/**
 * Run a TypeScript entry directly under Node while retaining the checkout
 * dependency lease. Eval CLIs use this path so an interrupt reaches the
 * process that owns trial cleanup; a nested pnpm process can exit on SIGINT
 * before that process has written result.json and removed status.json.
 */
export async function runNodeWithDependencyReadLease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const entry = options.entry;
  if (!entry) throw new Error('Expected a TypeScript entry path');
  const args = options.args ?? [];
  const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
  const inheritedEnv = options.env ?? process.env;
  const absoluteEntry = resolve(repoRoot, entry);
  const tsxImport =
    options.tsxImport ??
    createRequire(pathToFileURL(resolve(repoRoot, 'evals', 'package.json'))).resolve('tsx');
  return runLeasedChild({
    repoRoot,
    command: `node --import tsx ${entry}`,
    inheritedEnv,
    spawnChild: (env) =>
      (options.spawnNodeFn ?? spawn)(
        process.execPath,
        ['--import', tsxImport, absoluteEntry, ...forwardedArgs],
        {
          cwd: repoRoot,
          env,
          stdio: 'inherit',
        },
      ),
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [script, ...args] = process.argv.slice(2);
  const run =
    script === '--direct-node'
      ? runNodeWithDependencyReadLease({ entry: args[0], args: args.slice(1) })
      : runWithDependencyReadLease({ script, args });
  run.then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[dependency-lease] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
