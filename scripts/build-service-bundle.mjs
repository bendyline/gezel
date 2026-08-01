#!/usr/bin/env node
/**
 * Build the relocatable gezel service bundle.
 *
 * Output layout (after this script runs):
 *
 *   packages/app/dist/service-bundle/         (intermediate, kept for inspection)
 *     package.json         — the service's package.json, workspace: refs resolved
 *     dist/                — pre-built service ESM (dist/index.js, dist/bin/gezeld.js)
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
import { createReadStream, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, readdir, readlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { pruneForeignBinariesWithReport } from './prune-foreign-binaries.mjs';
import {
  pruneRuntimeFilesWithReport,
  verifyRuntimeDeclarationAssets,
} from './prune-runtime-files.mjs';
import { stageSharpCompatibilityStub, verifySharpCompatibilityTree } from './sharp-compat.mjs';
import { signMachOTree } from './sign-macho-tree.mjs';
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

  const args = [
    '--filter',
    '@bendyline/gezel-service',
    'deploy',
    '--prod',
    // pnpm v10+ requires either `inject-workspace-packages=true` on the
    // workspace or `--legacy` on the deploy. `--legacy` keeps our workspace
    // config untouched (which would otherwise subtly change how sibling
    // packages resolve during `pnpm dev`).
    '--legacy',
    // Force a flat hoisted node_modules — no symlinks, no .pnpm/<pkg>/...
    // virtual store. Required for Windows: when the tarball is extracted on
    // a filesystem that can't create symlinks without privilege (vanilla
    // user account), pnpm's default symlinked layout collapses into broken
    // path copies and Node's resolver fails to find transitive dependencies
    // of workspace packages.
    // The flat tree is ~10% larger on disk but extracts identically on
    // every OS. See:
    //   ~/.gezel/service/node_modules/@bendyline/gezel  on Linux: symlink
    //   ~/.gezel/service/node_modules/@bendyline/gezel  on Windows: real dir
    // hoisted=true eliminates this skew at source.
    '--node-linker=hoisted',
    // The app-builder-lib patch targets an electron-builder dep that only
    // exists in packages/app's graph — a service-only deploy legitimately
    // never applies it, and pnpm's strict default turns that into a fatal
    // ERR_PNPM_UNUSED_PATCH. Scoped to this command so ordinary installs
    // keep the strict check (which catches genuinely stale patches).
    '--config.allow-unused-patches=true',
    target,
  ];
  console.log(`[build-service-bundle] pnpm ${args.join(' ')}`);
  // `pnpm deploy --prod --node-linker=hoisted` rewrites this workspace-private
  // state file with `dev: false`, `nodeLinker: hoisted`, and
  // `filteredInstall: true`, even though the deployed virtual store itself
  // lives under `target`. The next ordinary pnpm command then trusts that
  // stale state and prunes the checkout's development dependencies. Preserve
  // the caller's workspace state so bundle validation is side-effect free.
  const workspaceStatePath = join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json');
  const workspaceStateBefore = existsSync(workspaceStatePath)
    ? await readFile(workspaceStatePath)
    : null;
  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await withoutLocalLinkOverrides(() =>
      exec('pnpm', args, {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        // Windows: pnpm on PATH is `pnpm.cmd` (a shim). Node's child_process
        // can't launch a .cmd without going through cmd.exe — without this
        // the spawn fails with ENOENT even though `pnpm` works fine in the
        // shell. Same fix as packages/service/src/packages/pnpm.ts and
        // system-toolsets/bootstrap.ts. Args are 100% internally constructed
        // (no user input touching the shell), so injection isn't a concern.
        shell: process.platform === 'win32',
      }),
    ));
  } finally {
    if (workspaceStateBefore) {
      await writeFile(workspaceStatePath, workspaceStateBefore);
    } else if (existsSync(workspaceStatePath)) {
      await unlink(workspaceStatePath);
    }
  }
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);

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

  // `pnpm deploy --legacy` leaves a few bookkeeping symlinks under
  // `.pnpm/node_modules/` that point back up to the workspace source (e.g.
  // the deployed package itself re-linked to `packages/service/`). Nothing
  // in the runtime dep graph follows them — but electron-builder's
  // recursive copy does, so we prune anything that escapes the bundle.
  await pruneEscapingSymlinks(target);

  // Before the import check below, not after: if this ever removes something
  // the service actually loads, the verification spawn fails here rather than
  // shipping a bundle that breaks on a user's machine.
  await pruneForeignBinariesWithReport(target);

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

  console.log('[build-service-bundle] verifying the bundle imports cleanly');
  // Importing the service module resolves the whole dep graph, including
  // native modules. We spawn a throwaway node process, let it import
  // `index.js` (which exports `startService` without *calling* it — so no
  // port binding), then exit. This is ~1s and catches a huge class of
  // packaging bugs that `--check` misses.
  //
  // Use pathToFileURL to convert the absolute path to a file:// URL.
  // Node's ESM loader on Windows rejects bare absolute paths (`D:\…`)
  // because `D:` is parsed as the URL scheme. file:// works on every
  // platform.
  const indexPath = join(target, 'dist', 'index.js');
  const indexUrl = pathToFileURL(indexPath).href;
  await exec(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(indexUrl)});`],
    { cwd: target, maxBuffer: 16 * 1024 * 1024 },
  );

  // TypeScript is deliberately external in the service bundle and is used at
  // runtime for parsing/transpiling user scripts. Exercise that lazy path
  // after declarations have been pruned; importing the service alone does not
  // call it and would miss an over-aggressive prune.
  const typescriptUrl = pathToFileURL(
    join(target, 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ).href;
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const ts=(await import(${JSON.stringify(typescriptUrl)})).default; const out=ts.transpileModule('const value: number = 1;', { compilerOptions: { module: ts.ModuleKind.ESNext } }); if (!out.outputText.includes('const value = 1')) throw new Error('bundled TypeScript transpile smoke failed');`,
    ],
    { cwd: target, maxBuffer: 16 * 1024 * 1024 },
  );

  if (process.env.GEZEL_SKIP_BUNDLE_ARCHIVE === '1') {
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
  await emitMeta(target, archivePath, metaPath);
  console.log('[build-service-bundle] ✓ bundle ready');
}

/**
 * Pack the tree at `src` into a gzipped tarball at `archivePath`.
 *
 * Why shell out to the system `tar` binary instead of using the `tar` npm
 * package: zero new dep at the script's resolution root, and `tar.exe`
 * ships with Windows 10 1803+ as libarchive bsdtar.
 *
 * Windows quirk: when the build runs from git-bash, PATH has git-bash's
 * GNU tar ahead of System32's bsdtar. GNU tar interprets `C:\...` paths as
 * remote rsync-style specs (`host:path`) and fails with "Cannot connect to
 * C: resolve failed". Hardcoding the System32 path on win32 sidesteps it.
 */
async function emitArchive(src, archivePath) {
  if (existsSync(archivePath)) rmSync(archivePath, { force: true });
  console.log(`[build-service-bundle] archiving → ${basename(archivePath)}`);
  const t0 = Date.now();
  const tarBin =
    process.platform === 'win32'
      ? join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  await exec(tarBin, ['-czf', archivePath, '-C', src, '.'], {
    maxBuffer: 64 * 1024 * 1024,
  });
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

/**
 * Run `fn` with any local `link:` overrides for our sibling checkouts
 * (squisq, gilde) temporarily lifted out of `pnpm-workspace.yaml`.
 *
 * `pnpm deploy` cannot materialize a `link:` dep — it lands as a symlink
 * pointing outside the bundle, `pruneEscapingSymlinks` (correctly) removes it,
 * and the import check dies with ERR_MODULE_NOT_FOUND on `@bendyline/squisq`.
 * Linked development is a supported workflow, so rather than refusing to build,
 * deploy against the registry pins the package.json files already carry. That
 * is also what has to ship: the bundle is a release artifact and must match a
 * clean checkout. The linked sources still back every other step of the gate.
 */
async function withoutLocalLinkOverrides(fn) {
  const workspacePath = join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) return fn();

  const original = await readFile(workspacePath, 'utf8');
  const dropped = [];
  const patched = original
    .split('\n')
    .filter((line) => {
      const match = /^\s{2}["']?(@bendyline\/(?:squisq|gilde)[^"':]*)["']?:\s*["']?link:/.exec(
        line,
      );
      if (!match) return true;
      dropped.push(match[1]);
      return false;
    })
    .join('\n');
  if (dropped.length === 0) return fn();

  console.log(
    `[build-service-bundle] local link override(s) in use: ${dropped.join(', ')} — deploying against the registry pins instead; changes in those checkouts are NOT in this bundle`,
  );

  const restore = () => {
    try {
      writeFileSync(workspacePath, original);
    } catch {}
  };
  const onSignal = (signal) => {
    restore();
    process.kill(process.pid, signal);
  };
  await writeFile(workspacePath, patched);
  process.on('exit', restore);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await fn();
  } finally {
    restore();
    process.off('exit', restore);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
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
