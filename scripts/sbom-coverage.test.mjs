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
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyNoticeInventory } from './check-notice.mjs';
import { ENGINE_FOR_BINARY, allPlatformKeys } from './native-payload.mjs';
import {
  isRemovedPnpmRuntimePackage,
  loadPnpmRuntimeInventory,
  mergePnpmRuntimeSbomComponents,
  packagedPnpmRuntimePackages,
  pnpmPackageMatchesTarget,
  shippedPnpmRuntimePackages,
} from './pnpm-runtime-inventory.mjs';
import { verifyPnpmComponentInventory } from './verify-packaged-licenses.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('the generator sources every non-npm component kind', async () => {
  const generator = await readFile(join(here, 'generate-sbom.mjs'), 'utf8');
  for (const kind of ['native-engine', 'bundled-runtime', 'native-redistributable']) {
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
  assert.match(generator, /superset-across-platforms/);
  assert.match(generator, /notice\.pnpmRuntime/);
  assert.match(generator, /dependencies: pnpmDependencies/);
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

test('every native engine and bundled runtime reaches the SBOM with a pin', async () => {
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
