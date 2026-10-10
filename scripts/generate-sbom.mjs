#!/usr/bin/env node
/**
 * Generate a CycloneDX inventory of everything a Gezel installer redistributes.
 *
 * Five sources, because no single one sees the whole payload:
 *
 *   - pnpm's production license inventory — npm identities and licences;
 *   - pnpm's resolved production trees — workspace roots and dependency edges;
 *   - the pin-bound inventory of pnpm's own vendored `dist/node_modules`;
 *   - NOTICE.md's native-engine, native-helper-source, and bundled-runtime
 *     rows, read through check-notice.mjs so the pins and legal texts are the
 *     ones it has already reconciled against `native/engines/<id>/VERSION`,
 *     helper-local notices, and the native license manifest;
 *   - native-payload.mjs, for which platform each native component ships on.
 *
 * Until July 2026 this emitted the npm tree alone, so roughly a gigabyte of
 * payload — llama.cpp, whisper.cpp, stable-diffusion.cpp, ds4, uv, the pinned
 * Node and pnpm runtimes, Electron, and NVIDIA's CUDA redistributables — was
 * absent from the SBOM published beside every installer, even though the
 * installed `resources/licenses/` manifest covered all of it.
 *
 * PLATFORM SCOPE: one SBOM accompanies installers for four platforms, so it is
 * a superset. Native components carry a `gezel:platforms` property naming the
 * payload keys they ship on; consumers filter on it. pnpm reports only the
 * optional dependencies installed on the generating host (`gezel:npm-platform`
 * records which host that was), so the platform prebuilds every other
 * installer carries are added from pnpm-lock.yaml by sbom-enrichment.mjs. The
 * vendored pnpm graph is pin-bound and platform-scoped separately.
 *
 * HASHES describe bytes, never a guess: an npm component carries the registry
 * tarball digest pnpm-lock.yaml pins; native payload files, the Windows
 * node.exe, the DuckDB executables, and the binaries inside onnxruntime-node
 * carry the SHA-256 of the file that ships; runtimes and elevate.exe carry
 * their distribution archive digests on `externalReferences`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readVulnerabilityExceptions,
  sbomVulnerabilityAnalyses,
} from './audit-vulnerability-policy.mjs';
import { verifyNoticeInventory } from './check-notice.mjs';
import { allPlatformKeys, platformKeysForEngine } from './native-payload.mjs';
import { mergePnpmRuntimeSbomComponents } from './pnpm-runtime-inventory.mjs';
import {
  DECLARED_BUT_NOT_SHIPPED,
  PACKAGED_WORKSPACE_ROOTS,
  packagedWorkspaceFilters,
  readPackagedProductionDependencyTree,
  readProductionLicenseInventory,
} from './production-dependency-inventory.mjs';
import {
  buildPnpmSbomGraph,
  finalizeSbomDependencyGraph,
  npmPurl,
} from './sbom-dependency-graph.mjs';
import {
  declaredManifestLicense,
  enrichNpmComponents,
  installerBinaryComponents,
  lockfilePlatformPrebuilds,
  nativePayloadComponents,
  normalizeComponentLicenses,
  readPnpmLockfile,
  runtimeArtifacts,
  supplementalBinaryComponents,
} from './sbom-enrichment.mjs';
import { loadSupplementalLicenses } from './supplemental-licenses.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? 'artifacts/gezel.cdx.json');
const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const byLicense = readProductionLicenseInventory({ filters: packagedWorkspaceFilters() });
const packagedProjects = readPackagedProductionDependencyTree();
const notice = await verifyNoticeInventory();
const supplemental = await loadSupplementalLicenses();
const lockfile = await readPnpmLockfile(join(repoRoot, 'pnpm-lock.yaml'));
const components = [];
const installedPackages = new Map();

for (const [license, packages] of Object.entries(byLicense)) {
  for (const pkg of packages) {
    for (const [index, version] of pkg.versions.entries()) {
      const purl = npmPurl(pkg.name, version);
      const slash = pkg.name.startsWith('@') ? pkg.name.indexOf('/') : -1;
      const path = pkg.paths?.[index];
      if (typeof path === 'string' && path) {
        const versions = installedPackages.get(pkg.name) ?? new Map();
        versions.set(version, path);
        installedPackages.set(pkg.name, versions);
      }
      // pnpm says Unknown for npm's legacy `licenses: [{ type }]` array shape;
      // the installed manifest still names the licence.
      let declared = license;
      if (license === 'Unknown' && typeof path === 'string' && path) {
        const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
        declared = declaredManifestLicense(manifest) ?? license;
      }
      components.push({
        type: 'library',
        'bom-ref': purl,
        ...(slash > 0 ? { group: pkg.name.slice(0, slash) } : {}),
        name: slash > 0 ? pkg.name.slice(slash + 1) : pkg.name,
        version,
        scope: 'required',
        licenses: [{ license: { name: declared } }],
        purl,
      });
    }
  }
}

const pnpmWorkspaceGraph = buildPnpmSbomGraph({
  projects: packagedProjects,
  components,
  entryWorkspaceNames: PACKAGED_WORKSPACE_ROOTS,
  repoRoot,
  excludedPackageNames: DECLARED_BUT_NOT_SHIPPED,
});
// Native engines — compiled from pinned upstream sources by build-native.yml
// and staged under `packages/app/native-bin/<platform-key>/`.
const engineRefs = new Map();
for (const engine of notice.native.components) {
  const purl = githubPurl(engine.source, engine.version);
  const ref = purl ?? `gezel:native/${engine.id}@${engine.version}`;
  engineRefs.set(engine.id, ref);
  components.push({
    type: 'application',
    'bom-ref': ref,
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

// Third-party source compiled into first-party helpers. These components do
// not have their own redistributed binary: their ABI declarations/constants
// are incorporated into the helper executable on the scoped platforms.
for (const component of notice.native.helperComponents) {
  components.push({
    type: 'library',
    'bom-ref': `gezel:native-helper-source/${component.id}@${component.version}`,
    name: component.id,
    version: component.version,
    scope: 'required',
    description:
      `${component.name} — third-party source compiled into ` +
      `${component.binary} (${component.helperId} helper)`,
    licenses: [licenseEntry(component.license)],
    properties: [
      { name: 'gezel:component-kind', value: 'native-helper-derived-source' },
      { name: 'gezel:platforms', value: component.platforms.join(',') },
      { name: 'gezel:native-helper', value: component.helperId },
      { name: 'gezel:native-binary', value: component.binary },
    ],
    externalReferences: [{ type: 'vcs', url: component.source }],
  });
}

// Bundled application runtimes — Electron, plus the pinned Node and pnpm the
// supervisor extracts for the sandbox runner and scheduled-job installs.
const runtimeFiles = await runtimeArtifacts({ repoRoot, versions: notice.runtimes.versions });
for (const runtime of notice.runtimes.components) {
  const purl = githubPurl(runtime.source, runtime.version);
  const artifacts = runtimeFiles[runtime.name];
  if (!artifacts)
    throw new Error(`sbom-enrichment.mjs has no pinned artifacts for ${runtime.name}`);
  components.push({
    type: 'application',
    'bom-ref': purl ?? `gezel:runtime/${runtime.name}@${runtime.version}`,
    name: runtime.name,
    version: runtime.version,
    scope: 'required',
    description: `${runtime.name} — application runtime shipped inside the installer`,
    licenses: [licenseEntry(runtime.license)],
    ...(purl ? { purl } : {}),
    ...(artifacts.hashes ? { hashes: artifacts.hashes } : {}),
    properties: [
      { name: 'gezel:component-kind', value: 'bundled-runtime' },
      { name: 'gezel:platforms', value: allPlatformKeys().join(',') },
    ],
    externalReferences: [
      ...(runtime.source ? [{ type: 'vcs', url: runtime.source }] : []),
      ...artifacts.externalReferences,
    ],
    ...(artifacts.components?.length ? { components: artifacts.components } : {}),
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

const nativeFileManifest = JSON.parse(
  await readFile(
    join(repoRoot, 'packages', 'service', 'src', 'engines', 'native-file-manifest.json'),
    'utf8',
  ),
);
const nativePayloads = nativePayloadComponents({
  manifest: nativeFileManifest,
  engineRefs,
  helperSourceRefsForKey: (key) =>
    notice.native.helperComponents
      .filter((component) => component.platforms.includes(key))
      .map((component) => `gezel:native-helper-source/${component.id}@${component.version}`),
  cudaRuntimeRef: 'gezel:native/nvidia-cuda-runtime',
});
components.push(...nativePayloads.components);

// Binaries carried inside npm packages under terms the package metadata omits
// (DirectML inside onnxruntime-node), and electron-builder's elevate.exe.
const embeddedBinaries = await supplementalBinaryComponents({ supplemental, installedPackages });
components.push(...embeddedBinaries.components);
components.push(...(await installerBinaryComponents({ supplemental, repoRoot })));

const hashedNpmComponents = enrichNpmComponents(components, lockfile);
const platformPrebuilds = lockfilePlatformPrebuilds({
  components,
  lockfile,
  excludedPackageNames: DECLARED_BUT_NOT_SHIPPED,
});
components.push(...platformPrebuilds.components);
const spdxIdentified = normalizeComponentLicenses(components);

components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

const rootPurl = npmPurl(rootPackage.name, rootPackage.version);
const directPayloadRefs = components
  .filter((component) =>
    component.properties?.some(
      (property) =>
        property.name === 'gezel:component-kind' &&
        [
          'native-engine',
          'native-helper-derived-source',
          'bundled-runtime',
          'native-redistributable',
          'native-payload',
          'installer-binary',
        ].includes(property.value),
    ),
  )
  .map((component) => component['bom-ref']);
const dependencies = finalizeSbomDependencyGraph({
  rootRef: rootPurl,
  rootDependsOn: [...pnpmWorkspaceGraph.entryRefs, ...directPayloadRefs],
  components,
  dependencyGroups: [
    pnpmWorkspaceGraph.dependencies,
    pnpmDependencies,
    nativePayloads.dependencies,
    embeddedBinaries.dependencies,
    platformPrebuilds.dependencies,
  ],
});
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
          version: '5',
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
      // superset. Components say which platforms they ship on. pnpm installs
      // only this host's optional dependencies; the other platforms' prebuilds
      // come from pnpm-lock.yaml and are marked `gezel:inventory-source`.
      { name: 'gezel:scope', value: 'superset-across-platforms' },
      { name: 'gezel:npm-platform', value: `${process.platform}-${process.arch}` },
      { name: 'gezel:npm-foreign-platform-source', value: 'pnpm-lock.yaml' },
      { name: 'gezel:native-platforms', value: allPlatformKeys().join(',') },
      { name: 'gezel:dependency-root-refs', value: pnpmWorkspaceGraph.entryRefs.join(',') },
      { name: 'gezel:native-inventory-refs', value: directPayloadRefs.join(',') },
      {
        name: 'gezel:hashes',
        value:
          'npm components: registry tarball digest pinned in pnpm-lock.yaml; file components: SHA-256 of the shipped file; runtimes and installer binaries: distribution archive digests on externalReferences',
      },
    ],
  },
  components,
  dependencies,
  vulnerabilities: sbomVulnerabilityAnalyses(components, byLicense, readVulnerabilityExceptions()),
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o600 });
console.log(
  `✓ wrote CycloneDX SBOM with ${components.length} components and ${dependencies.length} dependency nodes to ${output}`,
);
console.log(
  `  ${hashedNpmComponents} npm components hashed from pnpm-lock.yaml, ${platformPrebuilds.components.length} foreign-platform prebuilds added, ${spdxIdentified} licences expressed in SPDX, ${nativePayloads.components.length} native payloads and ${embeddedBinaries.components.length} embedded binary components with file digests`,
);

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
