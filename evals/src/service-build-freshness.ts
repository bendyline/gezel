import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export interface ServiceBuildFreshness {
  fresh: boolean;
  daemonEntry: string;
  newestSourcePath?: string;
  newestSourceMtimeMs?: number;
  daemonMtimeMs?: number;
}

function newestFileUnder(root: string): { path: string; mtimeMs: number } | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        const mtimeMs = statSync(path).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      }
    }
  };
  visit(root);
  return newest;
}

/**
 * Detect the workspace-only failure mode where evals spawn the compiled
 * service package after its source changed. Published installs have no sibling
 * `src/` tree and are deliberately treated as fresh.
 */
export function inspectServiceBuildFreshness(daemonEntry: string): ServiceBuildFreshness {
  const serviceRoot = resolve(dirname(daemonEntry), '..', '..');
  const sourceRoot = resolve(serviceRoot, 'src');
  if (!existsSync(sourceRoot)) return { fresh: true, daemonEntry };

  const daemonMtimeMs = statSync(daemonEntry).mtimeMs;
  const newestSource = newestFileUnder(sourceRoot);
  if (!newestSource) return { fresh: true, daemonEntry, daemonMtimeMs };
  return {
    fresh: newestSource.mtimeMs <= daemonMtimeMs,
    daemonEntry,
    newestSourcePath: newestSource.path,
    newestSourceMtimeMs: newestSource.mtimeMs,
    daemonMtimeMs,
  };
}

export function assertServiceBuildFresh(daemonEntry: string): void {
  if (/^(?:1|true)$/i.test(process.env.GEZEL_EVAL_ALLOW_STALE_SERVICE_DIST ?? '')) return;
  const result = inspectServiceBuildFreshness(daemonEntry);
  if (result.fresh) return;
  const serviceRoot = resolve(dirname(daemonEntry), '..', '..');
  const source = result.newestSourcePath ? relative(serviceRoot, result.newestSourcePath) : 'src/';
  throw new Error(
    `eval service build is stale: ${source} is newer than ${relative(serviceRoot, daemonEntry)}. Run \`pnpm --filter @bendyline/gezel-service build\` before measuring model behavior (or set GEZEL_EVAL_ALLOW_STALE_SERVICE_DIST=1 only for an intentional stale-build reproduction).`,
  );
}
