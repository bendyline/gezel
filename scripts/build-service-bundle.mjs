#!/usr/bin/env node
/**
 * Build the relocatable gezel service bundle.
 *
 * Output layout (after this script runs):
 *
 *   packages/app/dist/service-bundle/         (intermediate, kept for inspection)
 *     package.json         — the service's package.json, workspace: refs resolved
 *     dist/                — pre-built service ESM (dist/index.js, dist/bin/gezeld.js)
 *       ui/index.html      — browser UI served by user and legacy-full daemons
 *     node_modules/        — real, non-symlinked deps (incl. native binaries)
 *
 *   packages/app/dist/service-bundle.tar.gz   — shippable archive
 *   packages/app/dist/service-bundle.meta.json — { version, sha256, sizeBytes, fileCount }
 *
 * Electron packaging asar-unpacks the tarball + meta (one file each) instead
 * of 30k+ loose files — the install-time difference on Windows with Defender
 * is enormous (a 30-minute NSIS extraction collapses to seconds). The Electron
 * shell extracts the tarball into the user's `~/.gezel/service/` on first
 * launch (and into the system service home at install time).
 *
 * Per-platform note: `pnpm deploy --prod` only resolves the optional
 * dependencies that match the current OS/arch. Building on macOS arm64
 * produces a macOS-arm64 bundle. A production CI pipeline will need
 * per-platform build jobs.
 *
 * Environment controls:
 *   GEZEL_SKIP_SERVICE_BUNDLE=1   — skip entirely (dev-mode fast iteration)
 *   GEZEL_BUNDLE_TARGET=<path>    — override default output path (loose tree)
 *   GEZEL_SKIP_BUNDLE_ARCHIVE=1   — skip the tar/meta emission (dev iteration)
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { readFile, readdir, readlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { deployMlRuntime } from './deploy-ml-runtime.mjs';
import { fixDeployedNodePtyPermissions } from './fix-deployed-node-pty-perms.mjs';
import { runIsolatedPnpmDeploy } from './pnpm-deploy.mjs';
import { pruneForeignBinariesWithReport } from './prune-foreign-binaries.mjs';
import {
  pruneRuntimeFilesWithReport,
  verifyRuntimeDeclarationAssets,
} from './prune-runtime-files.mjs';
import { stageSharpCompatibilityStub, verifySharpCompatibilityTree } from './sharp-compat.mjs';
import { signMachOTree } from './sign-macho-tree.mjs';
import { createBundleArchive, verifyBundleArchiveRoundTrip } from './verify-bundle-archive.mjs';
import { verifyPeTree } from './verify-pe-tree.mjs';

const exec = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const defaultTarget = join(repoRoot, 'packages', 'app', 'dist', 'service-bundle');
const target = process.env.GEZEL_BUNDLE_TARGET
  ? resolve(process.env.GEZEL_BUNDLE_TARGET)
  : defaultTarget;
const archivePath = `${target}.tar.gz`;
const metaPath = `${target}.meta.json`;

if (process.env.GEZEL_SKIP_SERVICE_BUNDLE === '1') {
  console.log('[build-service-bundle] skipped (GEZEL_SKIP_SERVICE_BUNDLE=1)');
  process.exit(0);
}

async function main() {
  console.log(`[build-service-bundle] target: ${target}`);

  // pnpm deploy refuses to run into a non-empty directory. Wipe the target
  // first so repeat builds are deterministic.
  if (existsSync(target)) {
    console.log('[build-service-bundle] clearing existing bundle dir');
    rmSync(target, { recursive: true, force: true });
  }

  // PNPM's dedicated-lockfile deploy installs entirely below `target`.
  // Keep the hoisted layout: a flat, real-file tree survives extraction on
  // Windows accounts that cannot create symlinks. The helper also suppresses
  // local sibling links through the registry resolutions in the lockfile.
  await runIsolatedPnpmDeploy({
    repoRoot,
    filter: '@bendyline/gezel-service',
    target,
    label: 'build-service-bundle',
  });

  // Public npm consumers opt into native/large optional peers. Installer
  // builds remain full-featured by merging the private deployment-only package.
  await deployMlRuntime(repoRoot, target, 'build-service-bundle');

  const gezeldBin = join(target, 'dist', 'bin', 'gezeld.js');
  if (!existsSync(gezeldBin)) {
    throw new Error(
      `[build-service-bundle] expected ${gezeldBin} after deploy; pnpm deploy likely failed`,
    );
  }

  // The catalog CONTENT is the transitive registry dep @bendyline/gilde.
  // Nothing imports its data at module-load time, so the import-check
  // below cannot catch it going missing — a silent miss ships an app
  // with an empty catalog (no models, templates, or craftbooks). Assert
  // the data tree made it into the deploy graph explicitly.
  const gildeIndex = join(
    target,
    'node_modules',
    '@bendyline',
    'gilde',
    'data',
    'chat-models',
    'index.json',
  );
  if (!existsSync(gildeIndex)) {
    throw new Error(
      `[build-service-bundle] expected ${gildeIndex} after deploy; the @bendyline/gilde content package did not ride into the bundle (empty catalog in production). Bundles always build against the registry pin — pnpm deploy cannot materialize a link: dep — so check that the pinned @bendyline/gilde version resolves and still ships data/.`,
    );
  }

  // `pnpm deploy` can leave a few bookkeeping symlinks under
  // `.pnpm/node_modules/` that point back up to the workspace source (e.g.
  // the deployed package itself re-linked to `packages/service/`). Nothing
  // in the runtime dep graph follows them — but electron-builder's
  // recursive copy does, so we prune anything that escapes the bundle.
  await pruneEscapingSymlinks(target);

  // Before the import check below, not after: if this ever removes something
  // the service actually loads, the verification spawn fails here rather than
  // shipping a bundle that breaks on a user's machine.
  await pruneForeignBinariesWithReport(target);
  await fixDeployedNodePtyPermissions(target);

  await stageSharpCompatibilityStub(target);
  const sharpCompatibility = await verifySharpCompatibilityTree(target);
  console.log(
    `[sharp-compat] verified ${sharpCompatibility.stubs} no-image stub(s); no native Sharp/libvips payload`,
  );

  // `pnpm deploy` includes published source maps and declaration files. They
  // are useful to package consumers, but this tree is an application runtime:
  // every extra file costs a tar extraction + Defender scan on first launch.
  // Run after staging the Sharp compatibility package so its declaration is
  // covered too. The pruner preserves the declarations read by the script
  // editor at runtime.
  await pruneRuntimeFilesWithReport(target);
  const declarationAssets = await verifyRuntimeDeclarationAssets(target);
  console.log(
    `[prune-runtime] verified ${declarationAssets.total} runtime declaration assets for script-editor IntelliSense`,
  );

  // The installed machine service may remain `legacy-full` while an older
  // machine-owned product home awaits migration. That process discovers the
  // UI beside dist/bin/gezeld.js; it does not rely on GEZEL_UI_DIR from the
  // platform service definition. Missing this file would therefore produce a
  // healthy API that serves only the "web UI bundle was not included"
  // placeholder. Assert the final, pruned deployment tree before archiving it.
  const uiIndex = join(target, 'dist', 'ui', 'index.html');
  if (!existsSync(uiIndex)) {
    throw new Error(
      `[build-service-bundle] expected ${uiIndex} after deploy; packaged service bundles must include the browser UI. Build @bendyline/gezel-ui before @bendyline/gezel-service and verify the service build stages dist/ui.`,
    );
  }
  console.log('[build-service-bundle] verified bundled browser UI');

  // Runtime import verification happens after archive creation against a
  // freshly extracted copy. Checking only this loose tree missed a Windows
  // release whose archive/extraction lost entities/dist/esm/decode.js.
  await finishBundle();
}

async function verifyBundleRuntime(root) {
  console.log(`[build-service-bundle] verifying extracted runtime: ${root}`);
  // Importing the service module resolves its eager dependency graph. We
  // spawn a throwaway node process, let it import
  // `index.js` (which exports `startService` without *calling* it — so no
  // port binding), then exit. This is ~1s and catches a huge class of
  // packaging bugs that `--check` misses.
  //
  // Use pathToFileURL to convert the absolute path to a file:// URL.
  // Node's ESM loader on Windows rejects bare absolute paths (`D:\…`)
  // because `D:` is parsed as the URL scheme. file:// works on every
  // platform.
  const indexPath = join(root, 'dist', 'index.js');
  const indexUrl = pathToFileURL(indexPath).href;
  await exec(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(indexUrl)});`],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );

  // node-pty is an optional peer for public npm consumers and dynamically
  // imported on the first terminal command. Complete app bundles are not
  // optional-feature installs: the desktop terminal must be present. Import
  // the deployed module explicitly so the deployment-only merge cannot
  // silently ship a terminal-less application.
  const nodePtyUrl = pathToFileURL(join(root, 'node_modules', 'node-pty', 'lib', 'index.js')).href;
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const p=await import(${JSON.stringify(nodePtyUrl)}); if(typeof p.spawn!=='function') throw new Error('bundled node-pty spawn export missing');`,
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );

  // The service imports Transformers/Kokoro lazily. Exercise that complete
  // distribution path explicitly so the dependency merge and Sharp stub are
  // proven before packaging.
  const transformersUrl = pathToFileURL(
    join(root, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'),
  ).href;
  const kokoroUrl = pathToFileURL(
    join(root, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js'),
  ).href;
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const t=await import(${JSON.stringify(transformersUrl)}); const k=await import(${JSON.stringify(kokoroUrl)}); if(typeof t.pipeline!=='function'||typeof k.KokoroTTS!=='function') throw new Error('bundled ML runtime exports missing');`,
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );

  // TypeScript is deliberately external in the service bundle and is used at
  // runtime for parsing/transpiling user scripts. Exercise that lazy path
  // after declarations have been pruned; importing the service alone does not
  // call it and would miss an over-aggressive prune.
  const typescriptUrl = pathToFileURL(
    join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ).href;
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const ts=(await import(${JSON.stringify(typescriptUrl)})).default; const out=ts.transpileModule('const value: number = 1;', { compilerOptions: { module: ts.ModuleKind.ESNext } }); if (!out.outputText.includes('const value = 1')) throw new Error('bundled TypeScript transpile smoke failed');`,
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
}

async function finishBundle() {
  if (process.env.GEZEL_SKIP_BUNDLE_ARCHIVE === '1') {
    await verifyBundleRuntime(target);
    console.log('[build-service-bundle] ✓ bundle ready (archive skipped)');
    return;
  }

  // Both must happen before the tarball exists: Apple's notary service
  // inspects the archive contents, and on Windows neither the afterPack sweep
  // nor the release workflow's signature gate can reach inside it. macOS
  // signs (notarization requires it); Windows only audits, because every
  // unsigned binary in there is a prebuilt npm artifact we did not compile.
  await signMachOTree(target);
  await verifyPeTree(target);

  await emitArchive(target, archivePath);
  const meta = await emitMeta(target, archivePath, metaPath);
  console.log('[build-service-bundle] round-tripping the shipped archive');
  const roundTrip = await verifyBundleArchiveRoundTrip({
    sourceDir: target,
    archivePath,
    expectedFileCount: meta.fileCount,
    validateExtracted: verifyBundleRuntime,
  });
  console.log(`[build-service-bundle] verified archive round-trip (${roundTrip.fileCount} files)`);
  console.log('[build-service-bundle] ✓ bundle ready');
}

/**
 * Pack the tree at `src` into a gzipped tarball at `archivePath`.
 *
 * Use the pinned Node `tar` implementation on every platform. Windows'
 * built-in bsdtar returned success for a release archive while silently
 * omitting one Gilde manifest; the round-trip verifier caught the incomplete
 * artifact, but the creator itself provided no warning to act on.
 */
async function emitArchive(src, archivePath) {
  if (existsSync(archivePath)) rmSync(archivePath, { force: true });
  console.log(`[build-service-bundle] archiving → ${basename(archivePath)}`);
  const t0 = Date.now();
  await createBundleArchive({ sourceDir: src, archivePath });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const sz = statSync(archivePath).size;
  console.log(`[build-service-bundle] archived ${(sz / 1024 / 1024).toFixed(1)} MB in ${dt}s`);
}

/**
 * Write the meta sidecar — small (< 1 KB) so the supervisor can read
 * `{ version, sha256 }` cheaply at startup without untarring just to
 * decide whether to extract.
 */
async function emitMeta(src, archivePath, metaPath) {
  const pkg = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') {
    throw new Error('[build-service-bundle] service package.json missing version');
  }
  const sha256 = await hashFile(archivePath);
  const sizeBytes = statSync(archivePath).size;
  const fileCount = await countFiles(src);
  const meta = {
    version: pkg.version,
    sha256,
    sizeBytes,
    fileCount,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(
    `[build-service-bundle] meta: v${meta.version} sha256=${sha256.slice(0, 12)}… files=${fileCount}`,
  );
  return meta;
}

function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', rejectHash);
  });
}

async function countFiles(root) {
  let n = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() || e.isSymbolicLink()) n += 1;
    }
  }
  await walk(root);
  return n;
}

async function pruneEscapingSymlinks(root) {
  let removed = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const targetRaw = await readlink(p);
        const resolved = resolve(dirname(p), targetRaw);
        const rel = relative(root, resolved);
        if (rel.startsWith('..') || rel === '') {
          await unlink(p);
          removed += 1;
        }
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  }
  await walk(root);
  if (removed > 0) console.log(`[build-service-bundle] pruned ${removed} escaping symlink(s)`);
}

main().catch((err) => {
  console.error('[build-service-bundle] failed:', err.message ?? err);
  process.exit(1);
});
