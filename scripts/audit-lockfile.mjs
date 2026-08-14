#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPnpmInstallChild, withPnpmInstallLock } from './pnpm-install.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const code = await withPnpmInstallLock(
  repoRoot,
  ({ leaseEnv, setChildPid }) =>
    runPnpmInstallChild({
      repoRoot,
      args: [
        '--lockfile-only',
        '--frozen-lockfile',
        '--config.trust-lockfile=false',
        '--config.optimistic-repeat-install=false',
      ],
      env: { ...process.env, ...leaseEnv },
      setChildPid,
    }),
  { command: 'pnpm audit:lockfile' },
);
process.exitCode = code;
