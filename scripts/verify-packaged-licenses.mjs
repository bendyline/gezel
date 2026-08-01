#!/usr/bin/env node
/** Verify a staged or extracted resources/licenses directory byte-for-byte. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadPnpmRuntimeInventory,
  packagedPnpmRuntimePackages,
  pnpmReleaseTargets,
} from './pnpm-runtime-inventory.mjs';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function listFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files;
}

export async function verifyPnpmComponentInventory(pnpmComponents, expectedCount) {
  if (
    pnpmComponents.schemaVersion !== 1 ||
    !pnpmReleaseTargets().includes(pnpmComponents.target) ||
    !Array.isArray(pnpmComponents.packages) ||
    pnpmComponents.packageCount !== expectedCount ||
    pnpmComponents.packages.length !== expectedCount
  ) {
    throw new Error('pnpm component inventory does not match the legal bundle summary');
  }
  const pinnedPnpm = await loadPnpmRuntimeInventory();
  if (
    pnpmComponents.pnpmVersion !== pinnedPnpm.pnpmVersion ||
    pnpmComponents.packageSha256 !== pinnedPnpm.packageSha256
  ) {
    throw new Error('pnpm component inventory is not bound to the packaged pnpm pin');
  }
  const expectedPnpmPackages = packagedPnpmRuntimePackages(pinnedPnpm, pnpmComponents.target);
  if (JSON.stringify(pnpmComponents.packages) !== JSON.stringify(expectedPnpmPackages)) {
    throw new Error(`pnpm component inventory is stale for ${pnpmComponents.target}`);
  }
  return expectedPnpmPackages;
}

export async function verifyLicenseBundle(rootInput) {
  const root = resolve(rootInput);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`${manifestPath} is not a schemaVersion 1 legal bundle manifest`);
  }
  for (const field of [
    'productionPackages',
    'nativeEngines',
    'fontFamilies',
    'bundledRuntimes',
    'bundledPnpmPackages',
  ]) {
    if (!Number.isInteger(manifest[field]) || manifest[field] <= 0) {
      throw new Error(`${manifestPath} has invalid ${field}`);
    }
  }

  const required = [
    'LICENSE.txt',
    'NOTICE.md',
    'npm/manifest.json',
    'native/manifest.json',
    'runtimes/manifest.json',
    'runtimes/pnpm-components.json',
  ];
  for (const path of required) {
    if (!existsSync(join(root, path))) throw new Error(`legal bundle is missing ${path}`);
  }

  const declared = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.startsWith('/') ||
      file.path.split('/').includes('..') ||
      typeof file.sha256 !== 'string'
    ) {
      throw new Error(`invalid file record in ${manifestPath}`);
    }
    const path = join(root, file.path);
    if (!existsSync(path)) throw new Error(`legal bundle is missing ${file.path}`);
    const content = await readFile(path);
    const digest = sha256(content);
    if (digest !== file.sha256 || content.length !== file.size) {
      throw new Error(`legal bundle hash/size mismatch for ${file.path}`);
    }
    declared.add(file.path);
  }

  const actual = (await listFiles(root))
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .filter((path) => path !== 'manifest.json');
  const extras = actual.filter((path) => !declared.has(path));
  if (extras.length > 0) throw new Error(`legal bundle has undeclared files: ${extras.join(', ')}`);

  const npmManifest = JSON.parse(await readFile(join(root, 'npm', 'manifest.json'), 'utf8'));
  if (
    npmManifest.schemaVersion !== 1 ||
    npmManifest.packageCount !== manifest.productionPackages ||
    !Array.isArray(npmManifest.packages)
  ) {
    throw new Error('dependency-license manifest does not match the legal bundle summary');
  }
  for (const pkg of npmManifest.packages) {
    if (!Array.isArray(pkg.texts) || pkg.texts.length === 0) {
      throw new Error(`dependency ${pkg.name}@${pkg.version} has no packaged license text`);
    }
    for (const text of pkg.texts) {
      if (!existsSync(join(root, 'npm', text.file))) {
        throw new Error(`dependency ${pkg.name}@${pkg.version} references missing ${text.file}`);
      }
    }
  }

  const runtimeManifest = JSON.parse(
    await readFile(join(root, 'runtimes', 'manifest.json'), 'utf8'),
  );
  if (
    runtimeManifest.schemaVersion !== 1 ||
    runtimeManifest.runtimeCount !== manifest.bundledRuntimes ||
    !Array.isArray(runtimeManifest.runtimes) ||
    runtimeManifest.runtimes.length !== manifest.bundledRuntimes
  ) {
    throw new Error('bundled-runtime license manifest does not match the legal bundle summary');
  }
  for (const runtime of runtimeManifest.runtimes) {
    if (!Array.isArray(runtime.files) || runtime.files.length === 0) {
      throw new Error(`bundled runtime ${runtime.name}@${runtime.version} has no legal text`);
    }
    for (const file of runtime.files) {
      if (!existsSync(join(root, 'runtimes', file))) {
        throw new Error(`bundled runtime ${runtime.name}@${runtime.version} is missing ${file}`);
      }
    }
  }

  const pnpmComponents = JSON.parse(
    await readFile(join(root, 'runtimes', 'pnpm-components.json'), 'utf8'),
  );
  await verifyPnpmComponentInventory(pnpmComponents, manifest.bundledPnpmPackages);

  return {
    root,
    files: manifest.files.length,
    packages: manifest.productionPackages,
    nativeEngines: manifest.nativeEngines,
    fontFamilies: manifest.fontFamilies,
    bundledRuntimes: manifest.bundledRuntimes,
    bundledPnpmPackages: manifest.bundledPnpmPackages,
  };
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: node scripts/verify-packaged-licenses.mjs <licenses-dir>');
  const result = await verifyLicenseBundle(root);
  console.log(
    `\u2713 verified ${result.files} legal files in ${result.root} ` +
      `(${result.packages} packages, ${result.nativeEngines} native engines, ` +
      `${result.fontFamilies} font families, ${result.bundledRuntimes} bundled runtimes, ` +
      `${result.bundledPnpmPackages} pnpm runtime packages).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`\u2717 packaged-license verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
