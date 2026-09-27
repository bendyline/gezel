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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const existingRef = 'pkg:npm/tar@7.5.20';
  const sbomComponents = [
    {
      type: 'library',
      'bom-ref': existingRef,
      name: 'tar',
      version: '7.5.20',
      purl: existingRef,
    },
  ];
  const pnpmRef = 'pkg:github/pnpm/pnpm@11.15.1';
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
