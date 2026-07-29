#!/usr/bin/env node
/**
 * Assert that every release-version surface agrees with the version selected
 * by release preflight. Optional artifact arguments extend the check to the
 * post-build service metadata and SBOM.
 *
 * Usage:
 *   node scripts/verify-release-version.mjs --version 1.26123.45
 *   node scripts/verify-release-version.mjs --version 1.26123.45 \
 *     --service-meta packages/app/dist/service-bundle.meta.json \
 *     --sbom artifacts/gezel.cdx.json
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  if (index === process.argv.length - 1) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

const expected = arg('--version');
if (!expected || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected)) {
  throw new Error('--version must be a numeric X.Y.Z version');
}

const packagePaths = [
  'package.json',
  'packages/app/package.json',
  'packages/core/package.json',
  'packages/service/package.json',
];

for (const relativePath of packagePaths) {
  const pkg = await readJson(resolve(repoRoot, relativePath));
  assertVersion(relativePath, pkg.version, expected);
}

const coreSourcePath = resolve(repoRoot, 'packages/core/src/index.ts');
const coreSource = await readFile(coreSourcePath, 'utf8');
const sourceMatch = /export const GEZEL_VERSION = '([^']*)';/.exec(coreSource);
assertVersion('packages/core/src/index.ts GEZEL_VERSION', sourceMatch?.[1], expected);

const builtCorePath = resolve(repoRoot, 'packages/core/dist/index.js');
if (existsSync(builtCorePath)) {
  const builtCore = await readFile(builtCorePath, 'utf8');
  const builtMatch =
    /(?:const|var)\s+GEZEL_VERSION\s*=\s*["']([^"']*)["']/.exec(builtCore) ??
    /GEZEL_VERSION\s*=\s*["']([^"']*)["']/.exec(builtCore);
  assertVersion('packages/core/dist/index.js GEZEL_VERSION', builtMatch?.[1], expected);
}

const serviceMetaArg = arg('--service-meta');
if (serviceMetaArg) {
  const serviceMeta = await readJson(resolve(repoRoot, serviceMetaArg));
  assertVersion(`${serviceMetaArg} version`, serviceMeta.version, expected);
}

const sbomArg = arg('--sbom');
if (sbomArg) {
  const sbom = await readJson(resolve(repoRoot, sbomArg));
  assertVersion(`${sbomArg} root component`, sbom?.metadata?.component?.version, expected);
  const bomRef = sbom?.metadata?.component?.['bom-ref'];
  if (typeof bomRef !== 'string' || !bomRef.endsWith(`@${expected}`)) {
    throw new Error(`${sbomArg} root bom-ref does not end with @${expected}: ${String(bomRef)}`);
  }
}

console.log(`✓ every checked release-version surface reports ${expected}`);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assertVersion(label, actual, wanted) {
  if (actual !== wanted) {
    throw new Error(`${label} reports ${String(actual)}; expected ${wanted}`);
  }
}
