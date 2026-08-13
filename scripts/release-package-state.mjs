import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * multi-semantic-release computes sibling dependency upgrades before it runs
 * package prepare hooks. Gezel's source manifests must nevertheless stay on
 * `workspace:*`, so the prepare hook records that computed manifest outside
 * the checkout and restores the source invariant before the release commit.
 * The publish hook briefly materializes the recorded manifest again while
 * pnpm packs the tarball.
 */

function packageStatePath(repoRoot, packageName) {
  const checkoutRoot = realpathSync(resolve(repoRoot));
  const checkout = createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 20);
  const packageKey = Buffer.from(packageName).toString('base64url');
  return join(tmpdir(), 'gezel-npm-release', checkout, `${packageKey}.json`);
}

export function writeReleasePackageState({ repoRoot, packageName, packageVersion, source }) {
  const path = packageStatePath(repoRoot, packageName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ packageName, packageVersion, source }, null, 2)}\n`,
    'utf8',
  );
}

export function readReleasePackageState({ repoRoot, packageName, packageVersion }) {
  const path = packageStatePath(repoRoot, packageName);
  if (!existsSync(path)) return null;

  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (
    state.packageName !== packageName ||
    state.packageVersion !== packageVersion ||
    typeof state.source !== 'string'
  ) {
    throw new Error(
      `release state for ${packageName}@${packageVersion} is stale or malformed (${path})`,
    );
  }

  const manifest = JSON.parse(state.source);
  if (manifest.name !== packageName || manifest.version !== packageVersion) {
    throw new Error(
      `recorded manifest is ${manifest.name}@${manifest.version}; expected ${packageName}@${packageVersion}`,
    );
  }

  return { path, source: state.source };
}

export function clearReleasePackageState({ repoRoot, packageName }) {
  rmSync(packageStatePath(repoRoot, packageName), { force: true });
}

export function materializeReleasePackageState({
  repoRoot,
  packageName,
  packageVersion,
  manifestPath,
  sourceManifest,
}) {
  const releaseState = readReleasePackageState({ repoRoot, packageName, packageVersion });
  if (releaseState) writeFileSync(manifestPath, releaseState.source, 'utf8');

  let restored = false;
  return {
    materialized: releaseState !== null,
    restore() {
      if (restored) return;
      restored = true;
      if (releaseState) writeFileSync(manifestPath, sourceManifest, 'utf8');
      clearReleasePackageState({ repoRoot, packageName });
    },
  };
}
