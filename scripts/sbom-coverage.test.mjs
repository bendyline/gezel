/**
 * The SBOM published beside every installer must inventory what the installer
 * actually redistributes.
 *
 * A July 2026 audit of v1.26210.19 found it listing npm packages only: the
 * native engines, the pinned Node and pnpm runtimes, Electron, and NVIDIA's
 * CUDA redistributables — roughly a gigabyte of payload, and the one
 * proprietary component in it — were all absent, even though the installed
 * `resources/licenses/` manifest covered them. Nothing failed, because nothing
 * checked.
 *
 * These tests drive generate-sbom.mjs's non-npm half directly. The npm half is
 * left alone: it needs a real `pnpm licenses list`, which is slow and, on
 * Windows, cannot spawn `pnpm.cmd` outside a pnpm script.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyNoticeInventory } from './check-notice.mjs';
import { ENGINE_FOR_BINARY, NATIVE_PAYLOAD, allPlatformKeys } from './native-payload.mjs';
import {
  isRemovedPnpmRuntimePackage,
  loadPnpmRuntimeInventory,
  mergePnpmRuntimeSbomComponents,
  packagedPnpmRuntimePackages,
  pnpmPackageMatchesTarget,
  shippedPnpmRuntimePackages,
} from './pnpm-runtime-inventory.mjs';
import { PACKAGED_WORKSPACE_ROOTS } from './production-dependency-inventory.mjs';
import {
  buildPnpmSbomGraph,
  finalizeSbomDependencyGraph,
  npmPurl,
} from './sbom-dependency-graph.mjs';
import {
  cyclonedxLicenses,
  declaredManifestLicense,
  enrichNpmComponents,
  installerBinaryComponents,
  integrityHashes,
  lockfilePlatformPrebuilds,
  lockfileProductionClosure,
  nativePayloadComponents,
  normalizeComponentLicenses,
  parsePnpmLockfile,
  parseStringRecord,
  readPnpmLockfile,
  runtimeArtifacts,
  supplementalBinaryComponents,
} from './sbom-enrichment.mjs';
import { loadSupplementalLicenses } from './supplemental-licenses.mjs';
import { verifyPnpmComponentInventory } from './verify-packaged-licenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('the generator sources every non-npm component kind', async () => {
  const generator = await readFile(join(here, 'generate-sbom.mjs'), 'utf8');
  for (const kind of [
    'native-engine',
    'native-helper-derived-source',
    'bundled-runtime',
    'native-redistributable',
  ]) {
    assert.match(
      generator,
      new RegExp(`'gezel:component-kind', value: '${kind}'`),
      `generate-sbom.mjs no longer emits ${kind} components`,
    );
  }
  assert.match(generator, /mergePnpmRuntimeSbomComponents/);
  // The platform caveat is the honest part of shipping one SBOM for four
  // platforms; losing it would make the superset look authoritative.
  assert.match(generator, /gezel:npm-platform/);
  assert.match(generator, /gezel:native-platforms/);
  assert.match(generator, /gezel:dependency-root-refs/);
  assert.match(generator, /gezel:native-inventory-refs/);
  assert.match(generator, /superset-across-platforms/);
  assert.match(generator, /notice\.pnpmRuntime/);
  assert.match(generator, /readPackagedProductionDependencyTree/);
  assert.match(generator, /buildPnpmSbomGraph/);
  assert.match(generator, /finalizeSbomDependencyGraph/);
  assert.match(generator, /dependencies,/);
  // The v1.26270.76 audit: no hashes, no SPDX ids, no foreign prebuilds, no
  // elevate.exe, no DirectML. Each of these calls is one of those gaps.
  for (const call of [
    'enrichNpmComponents',
    'lockfilePlatformPrebuilds',
    'nativePayloadComponents',
    'runtimeArtifacts',
    'supplementalBinaryComponents',
    'installerBinaryComponents',
    'normalizeComponentLicenses',
  ]) {
    assert.match(
      generator,
      new RegExp(`\\b${call}\\(`),
      `generate-sbom.mjs no longer calls ${call}`,
    );
  }
  for (const kind of ['native-payload', 'installer-binary']) {
    assert.match(generator, new RegExp(`'${kind}'`), `${kind} components must hang off the root`);
  }
});

test('the packaged workspace graph emits roots, resolved edges, leaves, and native inventory', () => {
  const workspace = (name, version, path, dependencies = {}) => ({
    name,
    version,
    path,
    dependencies,
  });
  const dependency = (name, version, dependencies = {}) => ({
    from: name,
    version,
    dependencies,
  });
  const app = workspace('@bendyline/gezel-app', '1.2.3', '/fixture/app', {
    '@bendyline/gezel-client': {
      from: '@bendyline/gezel-client',
      version: 'link:../client',
      path: '/fixture/client',
      dependencies: { undici: dependency('undici', '8.9.0') },
    },
  });
  const service = workspace('@bendyline/gezel-service', '1.2.3', '/fixture/service', {
    hono: dependency('hono', '4.13.9', { cookie: dependency('cookie', '1.0.2') }),
  });
  const ui = workspace('@bendyline/gezel-ui', '0.0.0', '/fixture/ui');
  const ml = workspace('@bendyline/internal-ml-runtime', '0.0.0', '/fixture/ml');
  const client = workspace('@bendyline/gezel-client', '1.2.3', '/fixture/client', {
    undici: dependency('undici', '8.9.0'),
  });
  const components = ['undici@8.9.0', 'hono@4.13.9', 'cookie@1.0.2'].map((identity) => {
    const separator = identity.lastIndexOf('@');
    const name = identity.slice(0, separator);
    const version = identity.slice(separator + 1);
    const purl = npmPurl(name, version);
    return { type: 'library', 'bom-ref': purl, name, version, purl };
  });
  const graph = buildPnpmSbomGraph({
    projects: [app, service, ui, ml, client],
    components,
    entryWorkspaceNames: PACKAGED_WORKSPACE_ROOTS,
    repoRoot: '/fixture',
  });
  const nativeRef = 'gezel:native/example@1';
  components.push({
    type: 'application',
    'bom-ref': nativeRef,
    name: 'example-native',
    version: '1',
    properties: [{ name: 'gezel:component-kind', value: 'native-engine' }],
  });
  const rootRef = npmPurl('gezel', '1.2.3');
  const dependencies = finalizeSbomDependencyGraph({
    rootRef,
    rootDependsOn: [...graph.entryRefs, nativeRef],
    components,
    dependencyGroups: [graph.dependencies],
  });

  assert.equal(graph.entryRefs.length, PACKAGED_WORKSPACE_ROOTS.length);
  assert.deepEqual(
    dependencies.find((entry) => entry.ref === rootRef)?.dependsOn,
    [...graph.entryRefs, nativeRef].sort(),
  );
  assert.deepEqual(
    dependencies.find((entry) => entry.ref === npmPurl('@bendyline/gezel-service', '1.2.3'))
      ?.dependsOn,
    [npmPurl('hono', '4.13.9')],
  );
  assert.deepEqual(
    dependencies.find((entry) => entry.ref === npmPurl('hono', '4.13.9'))?.dependsOn,
    [npmPurl('cookie', '1.0.2')],
  );
  assert.ok(dependencies.some((entry) => entry.ref === nativeRef));
  assert.equal(
    dependencies.length,
    components.length + 1,
    'every component plus the root has a node',
  );
});

test('dependency finalization rejects an inventoried component outside the graph', () => {
  assert.throws(
    () =>
      finalizeSbomDependencyGraph({
        rootRef: 'pkg:npm/gezel@1',
        rootDependsOn: [],
        components: [{ type: 'library', 'bom-ref': 'pkg:npm/orphan@1', name: 'orphan' }],
        dependencyGroups: [],
      }),
    /outside the dependency graph/,
  );
  assert.throws(
    () =>
      finalizeSbomDependencyGraph({
        rootRef: 'pkg:npm/gezel@1',
        rootDependsOn: ['pkg:npm/duplicate@1'],
        components: [
          { type: 'library', 'bom-ref': 'pkg:npm/duplicate@1', name: 'duplicate' },
          { type: 'library', 'bom-ref': 'pkg:npm/duplicate@1', name: 'duplicate-again' },
        ],
        dependencyGroups: [],
      }),
    /bom-refs must be unique/,
  );
});

test('the graph omits uninstalled platform optionals and discovers override workspaces', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'gezel-sbom-graph-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = join(fixture, 'root');
  const compatibilityPath = join(fixture, 'packages', 'compatibility');
  await mkdir(rootPath, { recursive: true });
  await mkdir(compatibilityPath, { recursive: true });
  await writeFile(
    join(rootPath, 'package.json'),
    JSON.stringify({
      name: '@example/root',
      version: '1.0.0',
      license: 'MIT',
      optionalDependencies: { '@example/foreign-binary': '1.0.0' },
    }),
  );
  await writeFile(
    join(compatibilityPath, 'package.json'),
    JSON.stringify({ name: '@example/compatibility', version: '1.0.0', license: 'MIT' }),
  );
  const components = [];
  const graph = buildPnpmSbomGraph({
    projects: [
      {
        name: '@example/root',
        version: '1.0.0',
        path: rootPath,
        dependencies: {
          '@example/compatibility': {
            from: '@example/compatibility',
            version: 'link:../packages/compatibility',
            path: compatibilityPath,
          },
          '@example/foreign-binary': {
            from: '@example/foreign-binary',
            version: '1.0.0',
          },
        },
      },
    ],
    components,
    entryWorkspaceNames: ['@example/root'],
    repoRoot: fixture,
  });

  assert.ok(
    components.some(
      (component) => component['bom-ref'] === npmPurl('@example/compatibility', '1.0.0'),
    ),
    'workspace substitutions must be components even when pnpm does not return them as roots',
  );
  assert.equal(
    components.some(
      (component) => component['bom-ref'] === npmPurl('@example/foreign-binary', '1.0.0'),
    ),
    false,
    'foreign platform optionals absent from the installed inventory must stay out of this host SBOM',
  );
  assert.deepEqual(
    graph.dependencies.find((entry) => entry.ref === npmPurl('@example/root', '1.0.0'))?.dependsOn,
    [npmPurl('@example/compatibility', '1.0.0')],
  );
});

test('the pin-bound pnpm graph covers every released target without @reflink or foreign addons', async () => {
  const inventory = await loadPnpmRuntimeInventory();
  const shipped = shippedPnpmRuntimePackages(inventory);
  assert.ok(
    inventory.packages.length > shipped.length,
    'the source tarball should include pruned targets',
  );
  assert.ok(shipped.length > 0, 'pnpm runtime inventory is empty');

  const byName = new Map(inventory.packages.map((pkg) => [pkg.name, pkg]));
  const darwinAddon = byName.get('@reflink/reflink-darwin-arm64');
  const windowsAddon = byName.get('@reflink/reflink-win32-x64-msvc');
  assert.ok(darwinAddon);
  assert.ok(windowsAddon);
  assert.equal(pnpmPackageMatchesTarget(darwinAddon, 'darwin-arm64'), true);
  assert.equal(pnpmPackageMatchesTarget(darwinAddon, 'win32-x64'), false);
  assert.equal(pnpmPackageMatchesTarget(windowsAddon, 'win32-x64'), true);
  assert.equal(pnpmPackageMatchesTarget(windowsAddon, 'linux-x64'), false);

  const shippedNames = new Set(shipped.map((pkg) => pkg.name));
  for (const pkg of inventory.packages.filter(isRemovedPnpmRuntimePackage)) {
    assert.equal(shippedNames.has(pkg.name), false, `${pkg.name} must be removed before packaging`);
  }
});

test('the SBOM merge emits every shipped pnpm identity, scope, and dependency edge', async () => {
  const inventory = await loadPnpmRuntimeInventory();
  const components = shippedPnpmRuntimePackages(inventory);
  const runtime = { ...inventory, components };
  const tarVersion = components.find((pkg) => pkg.name === 'tar').version;
  const existingRef = `pkg:npm/tar@${tarVersion}`;
  const sbomComponents = [
    {
      type: 'library',
      'bom-ref': existingRef,
      name: 'tar',
      version: tarVersion,
      purl: existingRef,
    },
  ];
  const pnpmRef = `pkg:github/pnpm/pnpm@${inventory.pnpmVersion}`;
  const dependencies = mergePnpmRuntimeSbomComponents(sbomComponents, runtime, pnpmRef);

  const refs = new Set(sbomComponents.map((component) => component['bom-ref']));
  for (const pkg of components) {
    const suffix = `${encodeURIComponent(pkg.name.split('/').pop())}@${encodeURIComponent(pkg.version)}`;
    assert.ok(
      [...refs].some((ref) => ref.endsWith(suffix)),
      `${pkg.name}@${pkg.version} is absent`,
    );
  }
  assert.equal(
    sbomComponents.filter((component) => component['bom-ref'] === existingRef).length,
    1,
    'an identity shared with the workspace graph must be upserted, not duplicated',
  );
  assert.equal(
    sbomComponents.some((component) => component.group === '@reflink'),
    false,
    'the SBOM must describe the staged graph, not pnpm tarball packages removed before shipping',
  );
  const pnpmEdge = dependencies.find((entry) => entry.ref === pnpmRef);
  assert.equal(pnpmEdge.dependsOn.length, components.length);
  assert.ok(dependencies.some((entry) => entry.ref === existingRef && entry.dependsOn.length > 0));
});

test('the packaged legal bundle rejects a stale or incomplete pnpm graph', async () => {
  const inventory = await loadPnpmRuntimeInventory();
  const target = 'win32-x64';
  const packages = packagedPnpmRuntimePackages(inventory, target);
  const manifest = {
    schemaVersion: 1,
    pnpmVersion: inventory.pnpmVersion,
    packageSha256: inventory.packageSha256,
    target,
    packageCount: packages.length,
    packages,
  };
  await verifyPnpmComponentInventory(manifest, packages.length);
  await assert.rejects(
    () =>
      verifyPnpmComponentInventory(
        { ...manifest, packageCount: packages.length - 1, packages: packages.slice(0, -1) },
        packages.length - 1,
      ),
    /stale for win32-x64/,
  );
});

test('every native engine, helper component, and bundled runtime reaches the SBOM', async () => {
  const notice = await verifyNoticeInventory();

  const engineIds = new Set(Object.values(ENGINE_FOR_BINARY).filter(Boolean));
  const inventoried = new Set(notice.native.components.map((c) => c.id));
  assert.deepEqual(
    [...engineIds].sort(),
    [...inventoried].sort(),
    'the engines staged into installers and the engines NOTICE.md pins must be the same set',
  );

  for (const engine of notice.native.components) {
    assert.ok(engine.version, `${engine.id} has no pinned version`);
    assert.ok(engine.license, `${engine.id} has no license`);
    assert.ok(engine.commit, `${engine.id} has no upstream commit`);
    assert.match(engine.source ?? '', /^https:\/\//, `${engine.id} has no source URL`);
  }

  assert.equal(notice.native.helpers, 1);
  assert.equal(notice.native.helperComponents.length, 1);
  const adl = notice.native.helperComponents[0];
  assert.equal(adl.id, 'amd-adl-sdk-headers');
  assert.equal(adl.helperId, 'device-health');
  assert.equal(adl.binary, 'gezel-device-health');
  assert.equal(adl.license, 'MIT');
  // Both Windows keys: the ADL declarations in device-health's main.cpp are
  // `#ifdef _WIN32`-gated, not arch-gated, so they compile into the arm64
  // binary too and the inventory must say so.
  assert.deepEqual(adl.platforms, ['win32-x64', 'win32-arm64']);
  assert.match(adl.source, /^https:\/\/github\.com\/GPUOpen-LibrariesAndSDKs\/display-library$/);
  for (const platform of adl.platforms) {
    assert.ok(
      NATIVE_PAYLOAD[platform]?.includes(adl.binary),
      `${adl.id} claims ${platform}, which does not ship ${adl.binary}`,
    );
  }

  assert.equal(notice.runtimes.components.length, notice.runtimes.count);
  for (const runtime of notice.runtimes.components) {
    assert.ok(runtime.version, `${runtime.name} has no pinned version`);
    assert.ok(runtime.license, `${runtime.name} has no license`);
  }
});

test('CUDA components are scoped to the platforms that carry them', () => {
  const cuda = allPlatformKeys().filter((key) => key.endsWith('-cuda'));
  assert.ok(cuda.length > 0, 'no CUDA platform keys — the scoping property would be empty');
  assert.ok(
    cuda.every((key) => !key.startsWith('darwin-')),
    'macOS carries no CUDA payload; scoping it there would overstate the SBOM',
  );
});

/**
 * An August 2026 audit of v1.26217.39 found the Windows installer embedding
 * `vc_redist.x64.exe` (18.5 MB) and executing it during `customInstall`, while
 * the SBOM, NOTICE.md and the EULA all omitted it — the same "nothing failed
 * because nothing checked" shape as the CUDA gap above, in the one document
 * that tells users its inventory is complete.
 *
 * The installer stages it whenever `stage-vc-redist.mjs` finds it, so the
 * disclosure is not variant-specific: it rides along with every Windows build.
 */
test('the Visual C++ redistributable is disclosed wherever Windows ships', async () => {
  const win32 = allPlatformKeys().filter((key) => key.startsWith('win32-'));
  assert.ok(win32.length > 0, 'no Windows platform keys — the scoping property would be empty');

  const generator = await readFile(join(here, 'generate-sbom.mjs'), 'utf8');
  assert.match(
    generator,
    /'bom-ref': 'gezel:native\/msvc-runtime-redistributable'/,
    'the SBOM must carry the Visual C++ redistributable the Windows installer runs',
  );
  assert.match(
    generator,
    /key\.startsWith\('win32-'\)/,
    'the redistributable accompanies every Windows variant, not just one',
  );

  // The two documents a user actually reads: the installed inventory, and the
  // terms they accept before any of it reaches disk.
  const notice = await readFile(join(root, 'NOTICE.md'), 'utf8');
  assert.match(
    notice,
    /Microsoft Visual C\+\+ 2015-2022 Redistributable/,
    'NOTICE.md must name the redistributable it ships',
  );
  const eula = await readFile(join(root, 'packages', 'app', 'EULA.txt'), 'utf8');
  assert.match(
    eula,
    /Microsoft Visual C\+\+ 2015-2022 Redistributable/,
    'the EULA names every component whose terms differ from the MIT License',
  );
  const includedComponents = eula.match(
    /3\. Third-party components included with Gezel\n\n([\s\S]*?)\n\nWhere a bundled component's license/,
  )?.[1];
  assert.ok(includedComponents, 'the EULA must retain its bundled-components disclosure section');
  assert.doesNotMatch(
    includedComponents,
    /\n {4}\S/,
    'EULA bullets must not contain hard-wrapped continuation lines; Installer.app wraps them to its own width',
  );
});

/**
 * The v1.26270.76 SBOM listed 824 components with no hash and no SPDX id, left
 * out the Windows prebuilds a Linux runner never installs and electron-builder's
 * elevate.exe, and gave no sign that onnxruntime-node carries a proprietary
 * DirectML.dll. The tests below pin each of those against the real lockfile,
 * pins, and installed packages, without running pnpm.
 */
const lockfilePromise = readPnpmLockfile(join(root, 'pnpm-lock.yaml'));

function npmComponent(name, version) {
  const purl = npmPurl(name, version);
  const slash = name.startsWith('@') ? name.indexOf('/') : -1;
  return {
    type: 'library',
    'bom-ref': purl,
    ...(slash > 0 ? { group: name.slice(0, slash) } : {}),
    name: slash > 0 ? name.slice(slash + 1) : name,
    version,
    licenses: [{ license: { name: 'MIT' } }],
    purl,
  };
}

function npmName(component) {
  return component.group ? `${component.group}/${component.name}` : component.name;
}

function lockedVersion(lockfile, name) {
  const versions = [...lockfile.packages.keys()]
    .filter((key) => key.startsWith(`${name}@`))
    .map((key) => key.slice(name.length + 1));
  assert.equal(versions.length, 1, `expected one locked ${name}`);
  return versions[0];
}

function property(component, name) {
  return component.properties?.find((entry) => entry.name === name)?.value;
}

test('SRI integrity becomes a CycloneDX hex digest', () => {
  const digest = createHash('sha512').update('gezel').digest();
  assert.deepEqual(integrityHashes(`sha512-${digest.toString('base64')}`), [
    { alg: 'SHA-512', content: digest.toString('hex') },
  ]);
  assert.deepEqual(integrityHashes('sha512-not base64 at all'), []);
});

test('npm components carry the tarball digest pnpm-lock.yaml pins', async () => {
  const lockfile = await lockfilePromise;
  const version = lockedVersion(lockfile, '@napi-rs/keyring');
  const component = npmComponent('@napi-rs/keyring', version);
  const windows = npmComponent('@napi-rs/keyring-win32-x64-msvc', version);
  assert.equal(enrichNpmComponents([component, windows], lockfile), 2);
  const expected = integrityHashes(lockfile.packages.get(`@napi-rs/keyring@${version}`).integrity);
  assert.deepEqual(component.hashes, expected);
  assert.equal(component.hashes[0].alg, 'SHA-512');
  assert.match(component.hashes[0].content, /^[0-9a-f]{128}$/);
  assert.equal(property(component, 'gezel:platforms'), undefined, 'not platform-specific');
  assert.equal(
    property(windows, 'gezel:platforms'),
    'win32-x64,win32-x64-cpu,win32-x64-vulkan,win32-x64-cuda',
  );
});

test('prebuilds the SBOM host did not install come from the lockfile, scoped to their installers', async () => {
  const lockfile = await lockfilePromise;
  const parents = ['@napi-rs/keyring', '@resvg/resvg-js', '@vscode/ripgrep', 'sqlite-vec'];
  const components = parents.map((name) => npmComponent(name, lockedVersion(lockfile, name)));
  components[1].licenses = [{ license: { name: 'MPL-2.0' } }];
  // What a linux-x64 runner does install.
  components.push(npmComponent('sqlite-vec-linux-x64', lockedVersion(lockfile, 'sqlite-vec')));

  const { components: added, dependencies } = lockfilePlatformPrebuilds({ components, lockfile });
  const byName = new Map(added.map((component) => [npmName(component), component]));
  for (const name of [
    '@napi-rs/keyring-win32-x64-msvc',
    '@resvg/resvg-js-win32-x64-msvc',
    '@vscode/ripgrep-win32-x64',
    'sqlite-vec-windows-x64',
  ]) {
    const component = byName.get(name);
    assert.ok(component, `${name} is missing from the SBOM`);
    assert.match(property(component, 'gezel:platforms'), /^win32-x64(,|$)/);
    assert.equal(property(component, 'gezel:component-kind'), 'npm-platform-prebuild');
    assert.equal(component.hashes?.[0]?.alg, 'SHA-512');
  }
  const resvg = byName.get('@resvg/resvg-js-win32-x64-msvc');
  assert.deepEqual(resvg.licenses, [{ license: { name: 'MPL-2.0' } }]);
  assert.match(property(resvg, 'gezel:license-source'), /^inherited from @resvg\/resvg-js@/);
  assert.equal(byName.has('sqlite-vec-linux-x64'), false, 'already installed on the host');
  for (const name of byName.keys()) {
    assert.doesNotMatch(
      name,
      /musl|freebsd|android|ia32|darwin-x64|linux-arm-|gnueabihf|riscv|s390x|ppc64/,
      `${name} ships in no installer`,
    );
  }
  const keyringEdges = dependencies.find((entry) => entry.ref === components[0]['bom-ref']);
  assert.ok(
    keyringEdges.dependsOn.includes(byName.get('@napi-rs/keyring-win32-x64-msvc')['bom-ref']),
  );
});

test('lockfile prebuild discovery honours libc, negated os, and a prebuild of its own', () => {
  const sri = (fill) => `sha512-${Buffer.alloc(64, fill).toString('base64')}`;
  const lockfile = parsePnpmLockfile(
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      parent:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '',
      'packages:',
      '',
      '  parent@1.0.0:',
      `    resolution: {integrity: ${sri(1)}}`,
      '',
      '  parent-linux-x64-musl@1.0.0:',
      `    resolution: {integrity: ${sri(2)}}`,
      '    cpu: [x64]',
      '    os: [linux]',
      '    libc: [musl]',
      '',
      '  parent-not-windows@1.0.0:',
      `    resolution: {integrity: ${sri(3)}}`,
      "    os: ['!win32']",
      '    cpu: [arm64]',
      '',
      '  helper@2.0.0:',
      `    resolution: {integrity: ${sri(4)}}`,
      '',
      'snapshots:',
      '',
      '  parent@1.0.0:',
      '    optionalDependencies:',
      '      parent-linux-x64-musl: 1.0.0',
      '      parent-not-windows: 1.0.0',
      '',
      '  parent-linux-x64-musl@1.0.0:',
      '    optional: true',
      '',
      '  parent-not-windows@1.0.0:',
      '    dependencies:',
      '      helper: 2.0.0',
      '    optional: true',
      '',
      '  helper@2.0.0: {}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(lockfile.importers.get('.').dependencies, { parent: '1.0.0' });
  const { components } = lockfilePlatformPrebuilds({
    components: [npmComponent('parent', '1.0.0')],
    lockfile,
  });
  assert.deepEqual(components.map((component) => component.name).sort(), [
    'helper',
    'parent-not-windows',
  ]);
  const notWindows = components.find((component) => component.name === 'parent-not-windows');
  assert.equal(
    property(notWindows, 'gezel:platforms'),
    'darwin-arm64,darwin-arm64-metal,linux-arm64,linux-arm64-cpu,linux-arm64-cuda',
  );
  const helper = components.find((component) => component.name === 'helper');
  assert.equal(property(helper, 'gezel:platforms'), property(notWindows, 'gezel:platforms'));
  assert.deepEqual(helper.licenses, [{ license: { name: 'Unknown' } }], 'no licence is guessed');
});

async function workspaceImporters() {
  const byName = new Map();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    const manifest = join(root, 'packages', entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    byName.set(JSON.parse(await readFile(manifest, 'utf8')).name, `packages/${entry.name}`);
  }
  return byName;
}

test('the shipped roots cannot reach the Capacitor packages only the mobile app uses', async () => {
  const lockfile = await lockfilePromise;
  const importers = await workspaceImporters();
  const roots = PACKAGED_WORKSPACE_ROOTS.map((name) => importers.get(name));
  assert.ok(roots.every(Boolean), 'every packaged root is a workspace importer');
  const shipped = [...lockfileProductionClosure(lockfile, roots)];
  assert.deepEqual(
    shipped.filter((key) => key.startsWith('@capacitor/')),
    [],
    'a packaged root reaches Capacitor; the SBOM would list mobile-only packages',
  );
  assert.ok(shipped.some((key) => key.startsWith('onnxruntime-node@')));
  const mobile = lockfileProductionClosure(lockfile, ['packages/mobile']);
  assert.ok(
    [...mobile].some((key) => key.startsWith('@capacitor/core@')),
    'the closure walk must be able to see Capacitor for the check above to mean anything',
  );
});

test('every native payload file carries the digest the installer verifier checks', async () => {
  const manifest = JSON.parse(
    await readFile(
      join(root, 'packages', 'service', 'src', 'engines', 'native-file-manifest.json'),
      'utf8',
    ),
  );
  const engineIds = [...new Set(Object.values(ENGINE_FOR_BINARY).filter(Boolean))];
  const { components, dependencies } = nativePayloadComponents({
    manifest,
    engineRefs: new Map(engineIds.map((id) => [id, `engine:${id}`])),
    cudaRuntimeRef: 'cuda',
  });
  assert.deepEqual(
    components.map((component) => property(component, 'gezel:platforms')).sort(),
    allPlatformKeys().sort(),
  );
  for (const component of components) {
    const key = property(component, 'gezel:platforms');
    const files = manifest.platforms[key].files;
    assert.equal(component.components.length, Object.keys(files).length, key);
    for (const file of component.components) {
      assert.deepEqual(file.hashes, [{ alg: 'SHA-256', content: files[file.name].sha256 }]);
    }
    const dependsOn = dependencies.find((entry) => entry.ref === component['bom-ref']).dependsOn;
    assert.equal(dependsOn.includes('cuda'), key.endsWith('-cuda'), key);
    for (const binary of NATIVE_PAYLOAD[key]) {
      const engine = ENGINE_FOR_BINARY[binary];
      if (engine) assert.ok(dependsOn.includes(`engine:${engine}`), `${key} -> ${engine}`);
    }
  }
});

test('every bundled runtime carries pinned digests for every installer target', async () => {
  const notice = await verifyNoticeInventory();
  const artifacts = await runtimeArtifacts({ repoRoot: root, versions: notice.runtimes.versions });
  const targets = new Set(allPlatformKeys().map((key) => key.split('-').slice(0, 2).join('-')));
  for (const runtime of notice.runtimes.components) {
    const entry = artifacts[runtime.name];
    assert.ok(entry, `${runtime.name} has no pinned artifacts in sbom-enrichment.mjs`);
    const hashed = entry.externalReferences.filter((reference) => reference.hashes?.length);
    assert.ok(hashed.length > 0, `${runtime.name} has no hashed distribution`);
    for (const reference of hashed) assert.equal(reference.hashes[0].alg, 'SHA-256');
  }
  for (const name of ['Electron', 'Node.js', 'DuckDB']) {
    assert.equal(artifacts[name].externalReferences.length, targets.size, name);
  }
  const nodePins = parseStringRecord(
    await readFile(join(root, 'packages', 'app', 'src', 'node-version.ts'), 'utf8'),
    'NODE_SHA256',
  );
  const nodeExe = artifacts['Node.js'].components.find((file) =>
    property(file, 'gezel:platforms').startsWith('win32-x64'),
  );
  assert.deepEqual(nodeExe.hashes, [{ alg: 'SHA-256', content: nodePins['win-x64'] }]);
});

// pnpm-workspace.yaml publicly hoists *onnxruntime*, so those resolve at the
// root; several of these packages do not export ./package.json.
function installedPackageDir(name) {
  for (const modules of [
    join(root, 'packages', 'ml-runtime', 'node_modules'),
    join(root, 'node_modules'),
  ]) {
    const path = join(modules, ...name.split('/'));
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error(`${name} is not installed`);
}

test('DirectML and the other binaries inside ONNX Runtime packages carry file digests', async () => {
  const supplemental = await loadSupplementalLicenses();
  const installedPackages = new Map();
  for (const name of ['onnxruntime-node', 'onnxruntime-web', '@huggingface/transformers']) {
    const path = installedPackageDir(name);
    const { version } = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    installedPackages.set(name, new Map([[version, path]]));
  }
  const { components, dependencies } = await supplementalBinaryComponents({
    supplemental,
    installedPackages,
  });
  const directml = components.find((component) => component.name === 'DirectML');
  assert.ok(directml, 'DirectML must be visible in the SBOM, not hidden inside onnxruntime-node');
  const reviewed = supplemental.npmPackages
    .get('onnxruntime-node')
    .components.find((component) => component.id === 'directml');
  assert.equal(directml.purl, `pkg:nuget/Microsoft.AI.DirectML@${reviewed.version}`);
  assert.equal(property(directml, 'gezel:proprietary'), 'true');
  assert.equal(directml.licenses[0].license.id, undefined, 'proprietary terms are not an SPDX id');
  const ortPath = installedPackageDir('onnxruntime-node');
  const x64 = directml.components.find((file) => file.name.endsWith('win32/x64/DirectML.dll'));
  const bytes = await readFile(join(ortPath, 'bin', 'napi-v6', 'win32', 'x64', 'DirectML.dll'));
  assert.equal(x64.hashes[0].content, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(property(x64, 'gezel:platforms').split(',')[0], 'win32-x64');

  const ortVersion = [...installedPackages.get('onnxruntime-node').keys()][0];
  const edges = dependencies.find((entry) => entry.ref === npmPurl('onnxruntime-node', ortVersion));
  assert.ok(edges.dependsOn.includes(directml['bom-ref']));
  const gpu = components.find((component) =>
    component.purl?.startsWith('pkg:nuget/Microsoft.ML.OnnxRuntime.Gpu.Linux@'),
  );
  assert.ok(gpu, 'the CUDA providers the linux-x64 install script fetches must be inventoried');
  assert.match(property(gpu, 'gezel:platforms'), /^linux-x64(,|$)/);
  const web = components.filter((component) => component.name === 'ONNX Runtime Web');
  assert.equal(web.length, 1, 'one upstream build carried by two packages is one component');
  assert.match(
    property(web[0], 'gezel:carried-by'),
    /^@huggingface\/transformers@[^,]+,onnxruntime-web@/,
  );
});

test('elevate.exe is a component bound to the toolset electron-builder verifies', async () => {
  const supplemental = await loadSupplementalLicenses();
  const [elevate] = await installerBinaryComponents({ supplemental, repoRoot: root });
  assert.equal(elevate.name, 'Elevate');
  assert.deepEqual(elevate.licenses, [{ license: { id: 'MIT' } }]);
  assert.match(property(elevate, 'gezel:platforms'), /^win32-x64(,|$)/);
  assert.equal(property(elevate, 'gezel:installed-path'), 'resources/elevate.exe');
  const distribution = elevate.externalReferences.find(
    (reference) => reference.type === 'distribution',
  );
  assert.match(distribution.hashes[0].content, /^[0-9a-f]{64}$/);

  // electron-builder copies elevate.exe into every per-machine NSIS build, and
  // takes it from the legacy toolset only while no `toolsets.nsis` is pinned.
  const config = await readFile(join(root, 'packages', 'app', 'electron-builder.yml'), 'utf8');
  assert.match(config, /^\s+perMachine: true$/m);
  assert.doesNotMatch(config, /^toolsets:/m);
});

test('licences become SPDX ids or expressions only when they are valid SPDX', () => {
  const cases = [
    ['MIT', [{ license: { id: 'MIT' } }]],
    ['BlueOak-1.0.0', [{ license: { id: 'BlueOak-1.0.0' } }]],
    ['Apache-2.0 OR MIT', [{ expression: 'Apache-2.0 OR MIT' }]],
    ['(MIT OR EUPL-1.1+)', [{ expression: '(MIT OR EUPL-1.1+)' }]],
    ['(CC-BY-4.0 AND OFL-1.1 AND MIT)', [{ expression: '(CC-BY-4.0 AND OFL-1.1 AND MIT)' }]],
    ['Apache-2.0 WITH LLVM-exception', [{ expression: 'Apache-2.0 WITH LLVM-exception' }]],
    ['MIT OR Apache', [{ expression: 'MIT OR Apache-2.0' }]],
    ['MIT/Apache-2.0', [{ expression: 'MIT OR Apache-2.0' }]],
    [
      'MIT, with bundled Chromium notices',
      [{ license: { name: 'MIT, with bundled Chromium notices' } }],
    ],
    ['MIT OR Proprietary', [{ license: { name: 'MIT OR Proprietary' } }]],
    ['NVIDIA CUDA Toolkit EULA', [{ license: { name: 'NVIDIA CUDA Toolkit EULA' } }]],
    ['Unknown', [{ license: { name: 'Unknown' } }]],
    ['', [{ license: { name: 'Unknown' } }]],
  ];
  for (const [declared, expected] of cases) {
    assert.deepEqual(cyclonedxLicenses(declared), expected, declared);
  }
  const components = [
    { licenses: [{ license: { name: 'ISC' } }] },
    { licenses: [{ expression: 'Apache-2.0 OR MIT' }] },
    { licenses: [{ license: { name: 'Microsoft Visual C++ Redistributable Terms' } }] },
  ];
  assert.equal(normalizeComponentLicenses(components), 2);
  assert.deepEqual(components[0].licenses, [{ license: { id: 'ISC' } }]);
  assert.equal(declaredManifestLicense({ licenses: [{ type: 'Apache-2.0' }] }), 'Apache-2.0');
  assert.equal(declaredManifestLicense({ license: { type: 'MIT' } }), 'MIT');
  assert.equal(declaredManifestLicense({}), null);
});
