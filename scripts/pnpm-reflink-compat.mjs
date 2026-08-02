import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { c as createTar } from 'tar';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPAT_SOURCE = join(
  scriptDir,
  '..',
  'packages',
  'app',
  'scripts',
  'pnpm-reflink-compat.cjs',
);
const UPSTREAM_REQUIRE = '__require("@reflink/reflink")';
const COMPAT_REQUIRE = '__require("./gezel-reflink-compat.cjs")';
const PATCH_TARGETS = [
  { path: ['dist', 'pnpm.mjs'], occurrences: 2 },
  { path: ['dist', 'worker.js'], occurrences: 1 },
];
const execFileP = promisify(execFile);

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() === true;
}

/**
 * Replace pnpm's optional native reflink binding with a tiny Node-fs adapter.
 *
 * The expected call counts deliberately bind this patch to the reviewed pnpm
 * pin. A future pnpm layout must be inspected rather than silently receiving a
 * partial source rewrite.
 */
export async function removePnpmReflinkDependency(
  root,
  { compatSource = DEFAULT_COMPAT_SOURCE } = {},
) {
  const packageRoot = join(root, 'dist', 'node_modules', '@reflink', 'reflink');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(
      `[pnpm-reflink] refusing to patch a runtime without the reviewed @reflink/reflink package: ${error.message}`,
    );
  }
  if (metadata.name !== '@reflink/reflink' || typeof metadata.version !== 'string') {
    throw new Error(`[pnpm-reflink] unrecognized package at ${packageRoot}`);
  }

  for (const target of PATCH_TARGETS) {
    const path = join(root, ...target.path);
    const source = await readFile(path, 'utf8');
    const found = occurrences(source, UPSTREAM_REQUIRE);
    if (found !== target.occurrences || occurrences(source, COMPAT_REQUIRE) !== 0) {
      throw new Error(
        `[pnpm-reflink] ${relative(root, path)} has ${found} reviewed native imports; expected ${target.occurrences}`,
      );
    }
    await writeFile(path, source.replaceAll(UPSTREAM_REQUIRE, COMPAT_REQUIRE), 'utf8');
  }

  const compatTarget = join(root, 'dist', 'gezel-reflink-compat.cjs');
  await copyFile(compatSource, compatTarget, constants.COPYFILE_EXCL);
  await rm(join(root, 'dist', 'node_modules', '@reflink'), { recursive: true, force: true });
  await verifyPnpmReflinkRemoval(root, { compatSource });
  return { removedPackage: `${metadata.name}@${metadata.version}`, patchedImports: 3 };
}

/** Assert that neither the package identities nor native addon survived. */
export async function verifyPnpmReflinkRemoval(
  root,
  { compatSource = DEFAULT_COMPAT_SOURCE } = {},
) {
  const scope = join(root, 'dist', 'node_modules', '@reflink');
  if ((await stat(scope).catch(() => null)) !== null) {
    throw new Error(`[pnpm-reflink] native @reflink package scope survived staging at ${scope}`);
  }

  const compatTarget = join(root, 'dist', 'gezel-reflink-compat.cjs');
  if (!(await isFile(compatTarget))) {
    throw new Error(`[pnpm-reflink] missing first-party compatibility module at ${compatTarget}`);
  }
  const [expectedCompat, actualCompat] = await Promise.all([
    readFile(compatSource),
    readFile(compatTarget),
  ]);
  if (!expectedCompat.equals(actualCompat)) {
    throw new Error('[pnpm-reflink] staged compatibility module differs from its reviewed source');
  }

  for (const target of PATCH_TARGETS) {
    const path = join(root, ...target.path);
    const source = await readFile(path, 'utf8');
    if (occurrences(source, UPSTREAM_REQUIRE) !== 0) {
      throw new Error(`[pnpm-reflink] native import survived in ${relative(root, path)}`);
    }
    const found = occurrences(source, COMPAT_REQUIRE);
    if (found !== target.occurrences) {
      throw new Error(
        `[pnpm-reflink] ${relative(root, path)} has ${found} compatibility imports; expected ${target.occurrences}`,
      );
    }
  }

  // The scope removal above is the primary invariant. This additional walk
  // catches a future pnpm layout that embeds a reflink addon somewhere else.
  const nativeAddons = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
      else if (entry.isFile() && /^reflink\..+\.node$/i.test(entry.name)) {
        nativeAddons.push(relative(root, path));
      }
    }
  }
  await walk(join(root, 'dist'));
  if (nativeAddons.length > 0) {
    throw new Error(`[pnpm-reflink] native addons survived staging: ${nativeAddons.join(', ')}`);
  }

  return { patchedImports: 3, nativeAddons: 0 };
}

/**
 * Run the staged pnpm through a real local-package install with explicit clone
 * mode. On Windows this forces the Node adapter to report ENOTSUP and exercises
 * pnpm's ordinary-copy fallback; on reflink-capable filesystems it exercises
 * the built-in clone itself. The fixture is wholly local and runs offline.
 */
export async function smokeTestPnpmCloneMode(root, { nodePath = process.execPath } = {}) {
  const runtimeRoot = resolve(root);
  const runtimeNode = resolve(nodePath);
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'gezel-pnpm-clone-smoke-'));
  try {
    const archiveSource = join(fixtureRoot, 'archive', 'package');
    const archive = join(fixtureRoot, 'gezel-pnpm-smoke-1.0.0.tgz');
    const project = join(fixtureRoot, 'project');
    await mkdir(archiveSource, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      join(archiveSource, 'package.json'),
      `${JSON.stringify({ name: 'gezel-pnpm-smoke', version: '1.0.0', main: 'index.js' })}\n`,
    );
    await writeFile(join(archiveSource, 'index.js'), "module.exports = 'clone fallback works';\n");
    await createTar(
      { cwd: join(fixtureRoot, 'archive'), file: archive, gzip: true, portable: true },
      ['package'],
    );
    await writeFile(
      join(project, 'package.json'),
      `${JSON.stringify({
        name: 'gezel-pnpm-smoke-project',
        version: '1.0.0',
        private: true,
        dependencies: { 'gezel-pnpm-smoke': 'file:../gezel-pnpm-smoke-1.0.0.tgz' },
      })}\n`,
    );

    const pnpmEntry = join(runtimeRoot, 'bin', 'pnpm.mjs');
    const { stdout } = await execFileP(
      runtimeNode,
      [
        pnpmEntry,
        'install',
        '--offline',
        '--ignore-scripts',
        '--package-import-method=clone',
        '--store-dir',
        join(fixtureRoot, 'store'),
      ],
      {
        cwd: project,
        env: { ...process.env, CI: 'true' },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    const installed = await readFile(
      join(project, 'node_modules', 'gezel-pnpm-smoke', 'index.js'),
      'utf8',
    );
    if (!installed.includes('clone fallback works')) {
      throw new Error('[pnpm-reflink] clone-mode smoke installed unexpected package contents');
    }
    return { installed: true, output: stdout.trim() };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
