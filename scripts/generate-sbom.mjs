#!/usr/bin/env node
/**
 * Generate a CycloneDX inventory of everything a Gezel installer redistributes.
 *
 * Four sources, because no single one sees the whole payload:
 *
 *   - pnpm's production license graph — the npm dependency tree;
 *   - the pin-bound inventory of pnpm's own vendored `dist/node_modules`;
 *   - NOTICE.md's native-engine and bundled-runtime tables, read through
 *     check-notice.mjs so the pins are the ones it has already reconciled
 *     against `native/engines/<id>/VERSION` and the native license manifest;
 *   - native-payload.mjs, for which platform each engine actually ships on.
 *
 * Until July 2026 this emitted the npm tree alone, so roughly a gigabyte of
 * payload — llama.cpp, whisper.cpp, stable-diffusion.cpp, ds4, uv, the pinned
 * Node and pnpm runtimes, Electron, and NVIDIA's CUDA redistributables — was
 * absent from the SBOM published beside every installer, even though the
 * installed `resources/licenses/` manifest covered all of it.
 *
 * PLATFORM SCOPE: one SBOM accompanies installers for four platforms, so it is
 * a superset. Native components carry a `gezel:platforms` property naming the
 * payload keys they ship on; consumers filter on it. The workspace npm half
 * cannot be scoped that way — pnpm reports only the optional dependencies
 * installed on the generating host — so `gezel:npm-platform` records which
 * host that was. The vendored pnpm graph is pin-bound and platform-scoped
 * separately, so it is complete even when generated on Linux.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { verifyNoticeInventory } from './check-notice.mjs';
import { allPlatformKeys, platformKeysForEngine } from './native-payload.mjs';
import { mergePnpmRuntimeSbomComponents } from './pnpm-runtime-inventory.mjs';
import { readProductionLicenseInventory } from './production-dependency-inventory.mjs';

const output = resolve(process.argv[2] ?? 'artifacts/gezel.cdx.json');
const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const byLicense = readProductionLicenseInventory();
const notice = await verifyNoticeInventory();
const components = [];

for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    for (const version of pkg.versions) {
      const purl = npmPurl(pkg.name, version);
      const slash = pkg.name.startsWith('@') ? pkg.name.indexOf('/') : -1;
      components.push({
        type: 'library',
        'bom-ref': purl,
        ...(slash > 0 ? { group: pkg.name.slice(0, slash) } : {}),
        name: slash > 0 ? pkg.name.slice(slash + 1) : pkg.name,
        version,
        scope: 'required',
        licenses: [{ license: { name: license } }],
        purl,
      });
    }
  }
}
// Native engines — compiled from pinned upstream sources by build-native.yml
// and staged under `packages/app/native-bin/<platform-key>/`.
for (const engine of notice.native.components) {
  const purl = githubPurl(engine.source, engine.version);
  components.push({
    type: 'application',
    'bom-ref': purl ?? `gezel:native/${engine.id}@${engine.version}`,
    name: engine.id,
    version: engine.version,
    scope: 'required',
    description: `${engine.name} — native engine compiled from source and bundled per platform`,
    licenses: [licenseEntry(engine.license)],
    ...(purl ? { purl } : {}),
    properties: [
      { name: 'gezel:component-kind', value: 'native-engine' },
      { name: 'gezel:platforms', value: platformKeysForEngine(engine.id).join(',') },
      // The upstream tag alone is ambiguous for a moving branch, so pin both.
      { name: 'gezel:upstream-tag', value: engine.tag },
      { name: 'gezel:upstream-commit', value: engine.commit },
    ],
    ...(engine.source ? { externalReferences: [{ type: 'vcs', url: engine.source }] } : {}),
  });
}

// Bundled application runtimes — Electron, plus the pinned Node and pnpm the
// supervisor extracts for the sandbox runner and scheduled-job installs.
for (const runtime of notice.runtimes.components) {
  const purl = githubPurl(runtime.source, runtime.version);
  components.push({
    type: 'application',
    'bom-ref': purl ?? `gezel:runtime/${runtime.name}@${runtime.version}`,
    name: runtime.name,
    version: runtime.version,
    scope: 'required',
    description: `${runtime.name} — application runtime shipped inside the installer`,
    licenses: [licenseEntry(runtime.license)],
    ...(purl ? { purl } : {}),
    properties: [
      { name: 'gezel:component-kind', value: 'bundled-runtime' },
      { name: 'gezel:platforms', value: allPlatformKeys().join(',') },
    ],
    ...(runtime.source ? { externalReferences: [{ type: 'vcs', url: runtime.source }] } : {}),
  });
}

const pnpmRuntimeComponent = components.find(
  (component) =>
    component.name === 'pnpm' &&
    component.properties?.some(
      (property) =>
        property.name === 'gezel:component-kind' && property.value === 'bundled-runtime',
    ),
);
if (!pnpmRuntimeComponent) throw new Error('bundled pnpm runtime component was not generated');
const pnpmDependencies = mergePnpmRuntimeSbomComponents(
  components,
  notice.pnpmRuntime,
  pnpmRuntimeComponent['bom-ref'],
);

// NVIDIA's CUDA redistributables, bundled beside the CUDA engine variants so
// they run without a local CUDA Toolkit. Deliberately version-less: nothing in
// this repo pins one — native/engines/*/build.{sh,ps1} copy whatever the build
// host's toolkit provides — and inventing a number would be worse than saying
// so. The soname major is visible in the shipped file names (cudart64_<major>).
components.push({
  type: 'library',
  'bom-ref': 'gezel:native/nvidia-cuda-runtime',
  name: 'nvidia-cuda-runtime',
  scope: 'required',
  description:
    'NVIDIA CUDA runtime redistributables (cudart, cublas, cublasLt) bundled with the CUDA engine variants',
  licenses: [{ license: { name: 'NVIDIA CUDA Toolkit EULA' } }],
  properties: [
    { name: 'gezel:component-kind', value: 'native-redistributable' },
    {
      name: 'gezel:platforms',
      value: allPlatformKeys()
        .filter((key) => key.endsWith('-cuda'))
        .join(','),
    },
    {
      name: 'gezel:version-note',
      value: 'tracks the CUDA Toolkit on the native build host; not pinned in-repo',
    },
  ],
  externalReferences: [{ type: 'website', url: 'https://docs.nvidia.com/cuda/eula/index.html' }],
});

// The Microsoft Visual C++ runtime, embedded in the NSIS installer and run
// during customInstall (see packages/app/installer/nsis-hooks.nsh). Windows
// only, and genuinely part of the payload rather than a prerequisite we merely
// document: every engine DLL we ship imports MSVCP140/VCRUNTIME140, so the
// installer carries the redistributable and executes it.
//
// Version-less for the same reason as CUDA above: stage-vc-redist.mjs takes the
// copy belonging to the Visual Studio toolset that compiled those DLLs, and
// nothing in this repo pins which toolset that is. What *is* asserted at
// staging time is provenance — the file must carry a valid Authenticode
// signature naming Microsoft Corporation before it may enter the installer.
//
// Unlike the CUDA payload, no licence text is staged into resources/licenses/:
// the redistributable ships as a single self-extracting executable with its
// terms held in the Visual Studio licence, not as a text file sitting beside
// the binaries. The externalReference below is the authoritative text.
components.push({
  type: 'library',
  'bom-ref': 'gezel:native/msvc-runtime-redistributable',
  name: 'microsoft-visual-cpp-redistributable',
  scope: 'required',
  description:
    'Microsoft Visual C++ 2015-2022 Redistributable (x64) embedded in the Windows installer and executed during install; supplies MSVCP140/VCRUNTIME140 for the bundled native engines',
  licenses: [{ license: { name: 'Microsoft Visual C++ Redistributable Terms' } }],
  properties: [
    { name: 'gezel:component-kind', value: 'native-redistributable' },
    {
      name: 'gezel:platforms',
      value: allPlatformKeys()
        .filter((key) => key.startsWith('win32-'))
        .join(','),
    },
    {
      name: 'gezel:version-note',
      value:
        'tracks the Visual Studio toolset on the Windows build host; not pinned in-repo, Authenticode-verified as Microsoft-signed at staging time',
    },
  ],
  externalReferences: [
    {
      type: 'website',
      url: 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution',
    },
  ],
});

components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

const rootPurl = npmPurl(rootPackage.name, rootPackage.version);
const bom = {
  $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: {
      components: [
        {
          type: 'application',
          author: 'Bendyline',
          name: 'gezel-sbom-generator',
          version: '3',
        },
      ],
    },
    component: {
      type: 'application',
      'bom-ref': rootPurl,
      name: rootPackage.name,
      version: rootPackage.version,
      purl: rootPurl,
    },
    properties: [
      // One SBOM is published beside installers for four platforms, so it is a
      // superset. Native components say which platforms they ship on; the npm
      // half cannot, because pnpm only reports optional dependencies installed
      // on this host. Record the host so a consumer can tell which
      // platform-specific npm packages are represented and which are missing.
      { name: 'gezel:scope', value: 'superset-across-platforms' },
      { name: 'gezel:npm-platform', value: `${process.platform}-${process.arch}` },
      { name: 'gezel:native-platforms', value: allPlatformKeys().join(',') },
    ],
  },
  components,
  dependencies: pnpmDependencies,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o600 });
console.log(`✓ wrote CycloneDX SBOM with ${components.length} components to ${output}`);

/**
 * A CycloneDX licence entry. SPDX expressions ("Apache-2.0 OR MIT") belong in
 * `expression`; anything else — including prose like "MIT, with bundled
 * Chromium notices" — goes in `name`, since an invalid `id` is worse than an
 * unparsed string.
 */
function licenseEntry(license) {
  const value = String(license ?? '').trim();
  if (!value) return { license: { name: 'Unknown' } };
  return /\s(?:OR|AND|WITH)\s/.test(value) ? { expression: value } : { license: { name: value } };
}

/** `pkg:github/<owner>/<repo>@<version>` from a GitHub source URL. */
function githubPurl(sourceUrl, version) {
  const match = String(sourceUrl ?? '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!match || !version) return null;
  const [, owner, repo] = match;
  return `pkg:github/${encodeURIComponent(owner)}/${encodeURIComponent(repo.replace(/\.git$/, ''))}@${encodeURIComponent(version)}`;
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}
