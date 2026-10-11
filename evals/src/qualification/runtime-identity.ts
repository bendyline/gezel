import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { treeIdentity } from './metadata.ts';
import { isEvalInputPath } from './source-identity.ts';

interface RuntimePackage {
  name: string;
  type?: string;
  main?: string;
  exports?: unknown;
  imports?: unknown;
  bin?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Check installed workspace code, not unbuilt source, release scripts or the lockfile. */
export async function workspaceRuntimeIdentity(root: string) {
  const packages = new Map<string, { dir: string; pkg: RuntimePackage }>();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    const pkg = await readFile(join(dir, 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
    if (pkg?.name) packages.set(pkg.name, { dir, pkg });
  }
  const evalDir = join(root, 'evals');
  const evalPkg = JSON.parse(await readFile(join(evalDir, 'package.json'), 'utf8'));
  packages.set(evalPkg.name, { dir: evalDir, pkg: evalPkg });
  const pending = [evalPkg.name as string];
  const visited = new Set<string>();
  const manifest: Record<string, string> = {};
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  while (pending.length) {
    const name = pending.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const { dir, pkg } = packages.get(name)!;
    // These fields affect module loading. Scripts, release file lists and dependency
    // declarations do not change the already installed code's identity.
    manifest[`${name}/package.json`] = digest({
      type: pkg.type,
      main: pkg.main,
      exports: pkg.exports,
      imports: pkg.imports,
      bin: pkg.bin,
    });
    if (name !== evalPkg.name && name !== '@bendyline/gezel-service') {
      // The standard gate-script package is intentionally interpreted in place.
      const folder = name === '@bendyline/gezel-script-stdlib' ? 'scripts' : 'dist';
      const build = await treeIdentity(join(dir, folder), {
        ignorePythonBytecode: true,
        includeManifest: true,
        includePath: (path) =>
          !/\.(map|d\.[cm]?ts)$/.test(path) &&
          (folder === 'dist' || isEvalInputPath(`packages/script-stdlib/scripts/${path}`)),
      });
      for (const [path, hash] of Object.entries(build.manifest!))
        manifest[`${name}/${folder}/${path}`] = hash;
    }
    const require = createRequire(join(dir, 'package.json'));
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    }).sort()) {
      if (packages.has(dependency)) {
        pending.push(dependency);
        continue;
      }
      // Resolve the installed package, not the requested range in package.json or
      // pnpm-lock.yaml. Pin changes take effect only after installation.
      let installed: string | undefined;
      for (const base of require.resolve.paths(dependency) ?? []) {
        const path = join(base, dependency, 'package.json');
        try {
          installed = await realpath(path);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const metadata = installed ? JSON.parse(await readFile(installed, 'utf8')) : null;
      manifest[`${name}/dependency/${dependency}`] = digest({ path: installed ?? null, metadata });
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    algorithm: 'workspace-runtime-v1',
    sha256: digest(sorted),
    files: Object.keys(sorted).length,
    manifest: sorted,
  };
}
