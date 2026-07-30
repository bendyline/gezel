import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

function runPnpm(args) {
  const configuredStore = process.env.GEZEL_PNPM_STORE_DIR;
  const effectiveArgs = configuredStore ? [`--config.store-dir=${configuredStore}`, ...args] : args;
  const configuredCli = process.env.GEZEL_PNPM_CLI;
  const invokingCli = process.env.npm_execpath;
  const pnpmCli =
    configuredCli ||
    (invokingCli && basename(invokingCli).toLowerCase().includes('pnpm') ? invokingCli : null);
  if (pnpmCli) {
    const isJavaScriptCli = /\.(?:c|m)?js$/i.test(pnpmCli);
    return execFileSync(
      isJavaScriptCli ? process.execPath : pnpmCli,
      [...(isJavaScriptCli ? [pnpmCli] : []), ...effectiveArgs],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
  }
  return execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', effectiveArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * Workspace projects whose dependencies never reach a user. Every gezel
 * package is private, so "production" means the Electron installer and the
 * VSCode extension — not the eval harness or its local result viewer.
 *
 * Without this, the eval tooling's own dependencies were audited as if they
 * shipped: a July 2026 release was blocked by advisories against js-yaml 5.x
 * (only `evals` pulls it; the shipped 3.15.0/4.3.0 are outside the advisory
 * range) and react-router (only `eval-viewer` pulls it at all).
 *
 * Deliberately an exclusion list, not an allowlist of shipping packages: if
 * this list goes stale, a new dev tool gets audited unnecessarily. The
 * inverse mistake would silently stop auditing something we ship.
 */
const NON_SHIPPING_PROJECTS = ['@bendyline/gezel-evals', '@bendyline/gezel-eval-viewer'];

/**
 * Production declarations that never reach a released artifact.
 *
 * `@bendyline/squisq-editor-react` imports only the tree-shakable
 * `@bendyline/squisq-video-react/cover-image` entry. Upstream currently keeps
 * the browser encoder and `@ffmpeg/core` in that package's production
 * dependency graph even though the cover-image entry excludes it and Gezel no
 * longer publishes the core assets. The emitted UI is the shipping authority;
 * `tests/published/bundledAssets.test.ts` guards that the ffmpeg runtime stays
 * absent.
 */
const DECLARED_BUT_NOT_SHIPPED = new Set(['@ffmpeg/core']);

/** Read pnpm's exact production package/version/license inventory. */
export function readProductionLicenseInventory() {
  const raw = runPnpm([
    'licenses',
    'list',
    '--prod',
    '--json',
    ...NON_SHIPPING_PROJECTS.map((name) => `--filter=!${name}`),
  ]);
  const inventory = JSON.parse(raw);
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new Error('pnpm returned an invalid production dependency inventory');
  }
  for (const [license, packages] of Object.entries(inventory)) {
    if (!Array.isArray(packages)) {
      throw new Error(`pnpm returned an invalid package list for license ${license}`);
    }
    inventory[license] = packages.filter((pkg) => !DECLARED_BUT_NOT_SHIPPED.has(pkg.name));
    if (inventory[license].length === 0) delete inventory[license];
  }
  return inventory;
}

/** Convert the license grouping to the npm bulk-advisory request shape. */
export function packageVersionsFromInventory(inventory) {
  const versionsByName = new Map();
  for (const packages of Object.values(inventory)) {
    if (!Array.isArray(packages)) throw new Error('pnpm returned an invalid license group');
    for (const pkg of packages) {
      if (!pkg || typeof pkg.name !== 'string' || !Array.isArray(pkg.versions)) {
        throw new Error('pnpm returned an invalid production package record');
      }
      let versions = versionsByName.get(pkg.name);
      if (!versions) {
        versions = new Set();
        versionsByName.set(pkg.name, versions);
      }
      for (const version of pkg.versions) {
        if (typeof version === 'string' && version.length > 0) versions.add(version);
      }
    }
  }
  return Object.fromEntries(
    Array.from(versionsByName, ([name, versions]) => [name, [...versions].sort()]).sort(
      ([a], [b]) => a.localeCompare(b),
    ),
  );
}
