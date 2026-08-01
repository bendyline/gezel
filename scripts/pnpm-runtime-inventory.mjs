/**
 * Pin-bound inventory for the dependency graph vendored inside pnpm's
 * ordinary npm tarball.
 *
 * This graph is separate from Gezel's workspace lockfile: pnpm publishes its
 * CLI with a private `dist/node_modules/` tree, including platform-qualified
 * native addons. Packaging prunes foreign platform packages and removes the
 * optional @reflink scope, so the release SBOM and legal notices must start
 * from the unpruned, checked-in inventory rather than whichever platform
 * happened to generate the SBOM.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allPlatformKeys } from './native-payload.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
export const PNPM_RUNTIME_INVENTORY_PATH = join(
  repoRoot,
  'packages',
  'app',
  'src',
  'pnpm-runtime-inventory.json',
);
const PNPM_PIN_PATH = join(repoRoot, 'packages', 'app', 'src', 'pnpm-version.ts');

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeStringArray(value, field, packageName) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new Error(`${packageName} has an invalid ${field} list in the pnpm runtime inventory`);
  }
  const normalized = sortedUnique(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePackage(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid pnpm runtime package record');
  const { name, version, license } = value;
  if (typeof name !== 'string' || !name) throw new Error('pnpm runtime package has no name');
  if (typeof version !== 'string' || !version) throw new Error(`${name} has no version`);
  if (typeof license !== 'string' || !license) throw new Error(`${name}@${version} has no license`);
  return {
    name,
    version,
    license,
    ...(normalizeStringArray(value.os, 'os', name) ? { os: sortedUnique(value.os) } : {}),
    ...(normalizeStringArray(value.cpu, 'cpu', name) ? { cpu: sortedUnique(value.cpu) } : {}),
    dependencies: normalizeStringArray(value.dependencies ?? [], 'dependencies', name) ?? [],
  };
}

async function pinnedValue(name) {
  const source = await readFile(PNPM_PIN_PATH, 'utf8');
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*['\"]([^'\"]+)['\"]`));
  if (!match) throw new Error(`cannot parse ${name} from packages/app/src/pnpm-version.ts`);
  return match[1].toLowerCase();
}

export async function loadPnpmRuntimeInventory() {
  const raw = JSON.parse(await readFile(PNPM_RUNTIME_INVENTORY_PATH, 'utf8'));
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.packages)) {
    throw new Error('pnpm-runtime-inventory.json must have schemaVersion 1 and a packages array');
  }
  const inventory = {
    schemaVersion: 1,
    pnpmVersion: String(raw.pnpmVersion ?? ''),
    packageSha256: String(raw.packageSha256 ?? '').toLowerCase(),
    packages: raw.packages.map(normalizePackage),
  };
  const pinnedVersion = await pinnedValue('PNPM_VERSION');
  const pinnedSha = await pinnedValue('PNPM_PACKAGE_SHA256');
  if (inventory.pnpmVersion.toLowerCase() !== pinnedVersion) {
    throw new Error(
      `pnpm runtime inventory is for ${inventory.pnpmVersion}; pin is ${pinnedVersion}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(inventory.packageSha256)) {
    throw new Error('pnpm runtime inventory has no valid package sha256');
  }
  if (inventory.packageSha256 !== pinnedSha) {
    throw new Error('pnpm runtime inventory is not bound to PNPM_PACKAGE_SHA256');
  }
  const identities = inventory.packages.map((pkg) => `${pkg.name}@${pkg.version}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('pnpm runtime inventory contains duplicate package identities');
  }
  return inventory;
}

/** Platform/architecture targets for which desktop installers are published. */
export function pnpmReleaseTargets() {
  return sortedUnique(allPlatformKeys().map((key) => key.split('-').slice(0, 2).join('-')));
}

function splitTarget(target) {
  const [platform, arch] = String(target).split('-');
  return { platform, arch };
}

export function pnpmPackageMatchesTarget(pkg, target) {
  const { platform, arch } = splitTarget(target);
  return (!pkg.os || pkg.os.includes(platform)) && (!pkg.cpu || pkg.cpu.includes(arch));
}

export function pnpmPackageTargets(pkg) {
  return pnpmReleaseTargets().filter((target) => pnpmPackageMatchesTarget(pkg, target));
}

export function pnpmPackagePlatformKeys(pkg) {
  return allPlatformKeys().filter((key) =>
    pnpmPackageMatchesTarget(pkg, key.split('-').slice(0, 2).join('-')),
  );
}

/**
 * @reflink is present in pnpm's upstream npm tarball, but Gezel removes the
 * whole optional native package scope and patches pnpm to Node's built-in
 * COPYFILE_FICLONE_FORCE before packaging.
 */
export function isRemovedPnpmRuntimePackage(pkg) {
  return pkg.name === '@reflink/reflink' || pkg.name.startsWith('@reflink/reflink-');
}

/** Exact package graph staged into one installer target. */
export function packagedPnpmRuntimePackages(inventory, target) {
  return inventory.packages.filter(
    (pkg) => pnpmPackageMatchesTarget(pkg, target) && !isRemovedPnpmRuntimePackage(pkg),
  );
}

/** Union of package identities present in at least one released installer. */
export function shippedPnpmRuntimePackages(inventory) {
  return inventory.packages
    .filter((pkg) => !isRemovedPnpmRuntimePackage(pkg) && pnpmPackageTargets(pkg).length > 0)
    .map((pkg) => ({
      ...pkg,
      targets: pnpmPackageTargets(pkg),
      platforms: pnpmPackagePlatformKeys(pkg),
    }));
}

export function pnpmTargetFor(platform, arch) {
  return `${platform}-${arch}`;
}

async function readTreePackages(root) {
  const packages = [];
  const modulesRoot = join(root, 'dist', 'node_modules');
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') continue;
        const dependencies = sortedUnique([
          ...Object.keys(metadata.dependencies ?? {}),
          ...Object.keys(metadata.optionalDependencies ?? {}),
        ]);
        packages.push(
          normalizePackage({
            name: metadata.name,
            version: metadata.version,
            license: metadata.license,
            os: metadata.os,
            cpu: metadata.cpu,
            dependencies,
          }),
        );
      }
    }
  }
  await walk(modulesRoot);
  return packages.sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function comparable(pkg) {
  return JSON.stringify(pkg);
}

/**
 * Verify an extracted pnpm tree against the exact tarball inventory. Pass a
 * target after foreign-platform pruning; omit it for the unpruned cache.
 */
export async function verifyPnpmRuntimeTree(root, { target } = {}) {
  const inventory = await loadPnpmRuntimeInventory();
  const rootMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (rootMetadata.name !== 'pnpm' || rootMetadata.version !== inventory.pnpmVersion) {
    throw new Error(
      `pnpm runtime root is ${rootMetadata.name}@${rootMetadata.version}; expected pnpm@${inventory.pnpmVersion}`,
    );
  }
  const expected = (
    target ? packagedPnpmRuntimePackages(inventory, target) : inventory.packages
  ).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const actual = await readTreePackages(root);
  if (
    actual.length !== expected.length ||
    actual.some((pkg, index) => comparable(pkg) !== comparable(expected[index]))
  ) {
    const expectedIds = expected.map((pkg) => `${pkg.name}@${pkg.version}`);
    const actualIds = actual.map((pkg) => `${pkg.name}@${pkg.version}`);
    throw new Error(
      [
        `pnpm runtime package graph differs from the pin-bound inventory${target ? ` for ${target}` : ''}`,
        `  expected: ${expectedIds.join(', ')}`,
        `  actual: ${actualIds.join(', ')}`,
        'Run `node scripts/bump-pnpm.mjs <version>` and review the refreshed inventory.',
      ].join('\n'),
    );
  }
  return actual;
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function addProperty(component, name, value) {
  component.properties ??= [];
  if (
    !component.properties.some((property) => property.name === name && property.value === value)
  ) {
    component.properties.push({ name, value });
  }
}

/** Merge pnpm's private vendored graph into a CycloneDX component list. */
export function mergePnpmRuntimeSbomComponents(target, runtime, pnpmBomRef) {
  const byRef = new Map(target.map((component) => [component['bom-ref'], component]));
  const refByName = new Map();
  for (const pkg of runtime.components) {
    const purl = npmPurl(pkg.name, pkg.version);
    refByName.set(pkg.name, purl);
    let component = byRef.get(purl);
    if (!component) {
      const slash = pkg.name.startsWith('@') ? pkg.name.indexOf('/') : -1;
      component = {
        type: 'library',
        'bom-ref': purl,
        ...(slash > 0 ? { group: pkg.name.slice(0, slash) } : {}),
        name: slash > 0 ? pkg.name.slice(slash + 1) : pkg.name,
        version: pkg.version,
        scope: 'required',
        licenses: [{ license: { name: pkg.license } }],
        purl,
      };
      target.push(component);
      byRef.set(purl, component);
    }
    addProperty(component, 'gezel:component-kind', 'bundled-pnpm-dependency');
    addProperty(component, 'gezel:bundled-in', `pnpm@${runtime.pnpmVersion}`);
    addProperty(component, 'gezel:platforms', pkg.platforms.join(','));
  }

  const dependencies = [
    {
      ref: pnpmBomRef,
      dependsOn: [...refByName.values()].sort((a, b) => a.localeCompare(b)),
    },
  ];
  for (const pkg of runtime.components) {
    const dependsOn = pkg.dependencies
      .map((name) => refByName.get(name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (dependsOn.length > 0) {
      dependencies.push({ ref: refByName.get(pkg.name), dependsOn });
    }
  }
  return dependencies.sort((a, b) => a.ref.localeCompare(b.ref));
}
