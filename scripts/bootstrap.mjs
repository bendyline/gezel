#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dependencyStatus, reportDependencyStatus } from './pnpm-install.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

export function runBootstrap(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const warn = options.warn ?? console.warn;
  const error = options.error ?? console.error;
  const status = (options.statusFn ?? dependencyStatus)(root);
  if (status.usable) {
    const staleLinks = status.staleLinks ?? [];
    const metadataIssues = [
      staleLinks.length > 0
        ? `${staleLinks.length} dependency link(s) resolve to a version the lockfile has moved off, including ${staleLinks[0].dependency} for ${staleLinks[0].packageName} (installed ${staleLinks[0].installed}, lockfile wants ${staleLinks[0].expected}); run \`pnpm deps:install\``
        : null,
      status.installedLockfileIssue,
      status.workspaceStructureIssue,
      status.lockfileValidationIssue,
    ].filter(Boolean);
    for (const issue of metadataIssues) warn(`[bootstrap] dependency metadata warning: ${issue}`);
    if (metadataIssues.length > 0) {
      warn('[bootstrap] continuing with existing tools; no install or repair was started');
    }
    return 0;
  }

  (options.reportFn ?? reportDependencyStatus)(root, { write: error });
  error('[bootstrap] dependencies are incomplete; no install was started');
  error('[bootstrap] run `pnpm deps:install` only if dependency installation is intended');
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = runBootstrap();
