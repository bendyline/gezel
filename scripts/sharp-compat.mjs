import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUB_MARKER = 'gezelSharpCompatibilityStub';
const STUB_FILES = ['index.cjs', 'index.d.ts', 'index.mjs', 'LICENSE', 'package.json', 'README.md'];
const DEFAULT_STUB_ROOT = fileURLToPath(new URL('../packages/sharp-compat', import.meta.url));

/**
 * Materialize the workspace-only compatibility package in a production deploy.
 *
 * pnpm's legacy deploy does not materialize a workspace override reached only
 * through transitive dependencies, so the app bundle stages the stub
 * explicitly. Refuse to overwrite any other Sharp implementation.
 */
export async function stageSharpCompatibilityStub(root, sourceRoot = DEFAULT_STUB_ROOT) {
  const sharpRoot = join(root, 'node_modules', 'sharp');
  let existingEntries = [];
  try {
    existingEntries = await readdir(sharpRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (existingEntries.length > 0) {
    let existingPackage;
    try {
      existingPackage = JSON.parse(await readFile(join(sharpRoot, 'package.json'), 'utf8'));
    } catch {
      throw new Error(
        `[sharp-compat] refusing to replace an unrecognized Sharp directory at ${sharpRoot}`,
      );
    }
    if (existingPackage[STUB_MARKER] !== true) {
      throw new Error(`[sharp-compat] refusing to replace upstream Sharp at ${sharpRoot}`);
    }
  }

  await mkdir(sharpRoot, { recursive: true });
  await Promise.all(
    STUB_FILES.map((name) => copyFile(join(sourceRoot, name), join(sharpRoot, name))),
  );
  return sharpRoot;
}

/**
 * Assert that a deployed service uses Gezel's deliberate no-image Sharp stub
 * and contains none of upstream Sharp's native libvips payload.
 */
export async function verifySharpCompatibilityTree(root) {
  const nodeModules = join(root, 'node_modules');
  const nativePayloads = [];
  const upstreamSharpPackages = [];
  let stubs = 0;

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;

      if (/libvips/i.test(basename(path))) {
        nativePayloads.push(relative(root, path));
      }
      if (entry.name !== 'package.json') continue;

      const pkg = JSON.parse(await readFile(path, 'utf8'));
      if (pkg.name === 'sharp') {
        if (pkg[STUB_MARKER] === true) stubs += 1;
        else upstreamSharpPackages.push(relative(root, path));
      }
      if (typeof pkg.name === 'string' && /^@img\/sharp(?:-|$)/.test(pkg.name)) {
        nativePayloads.push(relative(root, path));
      }
    }
  }

  await walk(nodeModules);

  if (upstreamSharpPackages.length > 0) {
    throw new Error(
      `[sharp-compat] upstream Sharp package survived deployment:\n${upstreamSharpPackages
        .sort()
        .map((path) => `  - ${path}`)
        .join('\n')}`,
    );
  }
  if (nativePayloads.length > 0) {
    throw new Error(
      `[sharp-compat] native Sharp/libvips payload survived deployment:\n${[
        ...new Set(nativePayloads),
      ]
        .sort()
        .map((path) => `  - ${path}`)
        .join('\n')}`,
    );
  }
  if (stubs === 0) {
    throw new Error(`[sharp-compat] ${root} does not contain Gezel's Sharp compatibility stub`);
  }

  return { stubs };
}
