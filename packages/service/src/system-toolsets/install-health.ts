import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Probe for the relocated-install failure mode: a package tree whose
 * `node_modules` links no longer resolve.
 *
 * Staged installs run `pnpm install` in a staging directory that is then
 * renamed into place. pnpm's isolated linker uses NTFS junctions on
 * Windows, and junction targets are stored as absolute paths — so after
 * the rename every link still points at the vanished staging path. The
 * install *looks* complete (tracking record satisfied, files on disk)
 * but the first cross-package require fails, which surfaced as
 * "playwright install chromium exited with 1: … Cannot find module
 * 'playwright…'" on every clean Windows machine. New installs avoid
 * this via `--config.node-linker=hoisted`; this check exists so trees
 * broken by older builds get reinstalled instead of being trusted
 * forever on the strength of their tracking record.
 */
export interface InstallTreeHealth {
  ok: boolean;
  /** First declared dependency that fails to resolve, for log lines. */
  missingDep?: string;
}

/**
 * A tree is unhealthy only when its `package.json` *declares* a
 * dependency that cannot be resolved under `node_modules/`. A missing
 * or unreadable `package.json`, or one with no dependencies, reads as
 * healthy — absence of evidence must never invent a reinstall (several
 * long-standing callers seed bare package dirs in tests and in the
 * reconcile path).
 */
export async function checkInstallTree(installPath: string): Promise<InstallTreeHealth> {
  let dependencies: string[];
  try {
    const pkg = JSON.parse(await readFile(join(installPath, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    dependencies = Object.keys(pkg.dependencies ?? {});
  } catch {
    return { ok: true };
  }
  for (const dep of dependencies) {
    // existsSync follows symlinks and junctions, so a dangling link
    // reads as missing — exactly the broken state this probes for.
    if (!existsSync(join(installPath, 'node_modules', dep, 'package.json'))) {
      return { ok: false, missingDep: dep };
    }
  }
  return { ok: true };
}
