/**
 * The deep subpaths that are resolved by string at runtime.
 *
 * Several call sites locate a sibling package with `require.resolve` /
 * `import.meta.resolve` rather than importing it, because they spawn it as
 * a subprocess or read files out of its directory. Node's `exports`-strict
 * resolution means dropping one of these entries from an `exports` map does
 * not fail the build, does not fail a typecheck, and does not fail any
 * in-package test — it fails at runtime, in production, often silently.
 *
 * CLAUDE.md documents two of these under "Gotchas" (the MCP server entry
 * and the gezeld binary); this test is their executable form, extended to
 * every such call site in the repo.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, exportTargets, loadPublishedPackages } from './_packages';

/**
 * specifier → the package that resolves it, the resolver it uses, and the
 * call site. Resolution is done FROM that package under THAT resolver,
 * exactly as Node would at runtime. Both details matter:
 *
 *   - resolving from the repo root is meaningless (no `node_modules/@bendyline`)
 *   - `require.resolve` matches the `require` condition and
 *     `import.meta.resolve` matches `import`, so a package whose exports
 *     declare only `import` is unreachable from CJS. Getting this wrong in
 *     the test would either miss a real break or invent a fake one.
 *
 * Keep `usedBy` accurate: it is what tells the next person why the entry
 * cannot be removed.
 */
const RUNTIME_RESOLVED: ReadonlyArray<{
  specifier: string;
  from: string;
  mode: 'require' | 'import';
  usedBy: string;
}> = [
  {
    specifier: '@bendyline/gezel-service/dist/bin/gezeld.js',
    from: 'cli',
    mode: 'require',
    usedBy:
      'src/bin/gezel.ts and src/connection.ts via client resolveDaemonEntry(parentUrl) — how the CLI spawns the daemon',
  },
  {
    specifier: '@bendyline/gezel-service/dist/bin/gezeld.js',
    from: 'app',
    mode: 'require',
    usedBy:
      'src/supervisor/index.ts via client resolveDaemonEntry(parentUrl) — the desktop dev-mode spawn path',
  },
  {
    specifier: '@bendyline/gezel-service/dist/bin/gezeld.js',
    from: 'vscode',
    mode: 'require',
    usedBy: 'src/daemon.ts resolveDaemonEntryFromExtension() — how the extension spawns the daemon',
  },
  {
    specifier: '@bendyline/gezel-mcp/dist/server.js',
    from: 'service',
    mode: 'require',
    usedBy: 'src/chat/manager.ts — without it, chat sessions silently run with no tools',
  },
  {
    specifier: '@bendyline/gezel-connectors-spectral/run-action',
    from: 'service',
    mode: 'require',
    usedBy: 'src/connectors/drivers/spectral-host.ts — spawned, never imported',
  },
  {
    specifier: '@bendyline/gezel/checks',
    from: 'service',
    mode: 'import',
    usedBy: 'src/scripts/sdk.ts',
  },
  {
    specifier: '@bendyline/gezel-script-stdlib/package.json',
    from: 'service',
    mode: 'import',
    usedBy: 'src/scripts/stdlib-source.ts resolveStdlibDir()',
  },
  {
    specifier: '@bendyline/gezel-sdk/package.json',
    from: 'service',
    mode: 'import',
    usedBy: 'src/scripts/sdk.ts resolveSdkDir()',
  },
];

/**
 * Run the ESM resolver in a child node started inside the consumer package.
 * `import.meta.resolve` is relative to the running module, so there is no
 * in-process way to ask it "resolve this as packages/service would".
 */
function resolveAsEsm(specifier: string, packageDir: string): { ok: boolean; error: string } {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import.meta.resolve(${JSON.stringify(specifier)})`],
    { cwd: packageDir, encoding: 'utf8' },
  );
  return { ok: result.status === 0, error: result.stderr.trim() };
}

describe('runtime-resolved subpaths', () => {
  it.each(RUNTIME_RESOLVED)(
    '$specifier resolves from $from via $mode',
    ({ specifier, from, mode, usedBy }) => {
      const packageDir = resolve(REPO_ROOT, 'packages', from);
      const because = `resolved by packages/${from}/${usedBy}`;

      if (mode === 'require') {
        const consumer = createRequire(resolve(packageDir, 'noop.js'));
        expect(() => consumer.resolve(specifier), because).not.toThrow();
        return;
      }

      const { ok, error } = resolveAsEsm(specifier, packageDir);
      expect(ok, `${because}\n${error}`).toBe(true);
    },
  );

  it.each(RUNTIME_RESOLVED)('$specifier is declared in an exports map', ({ specifier }) => {
    const [scope, name, ...rest] = specifier.split('/');
    const packageName = `${scope}/${name}`;
    const subpath = rest.length > 0 ? `./${rest.join('/')}` : '.';

    const owner = loadPublishedPackages().find((p) => p.name === packageName);
    expect(owner, `${packageName} is not in the published registry`).toBeDefined();

    const declared = new Set(Object.keys(owner!.pkg.exports ?? {}));
    expect(declared, `${packageName} must export ${subpath}`).toContain(subpath);
  });
});

describe('exports maps', () => {
  const packages = loadPublishedPackages();

  it.each(packages)(
    '$name declares a types condition wherever it emits declarations',
    ({ pkg, typed }) => {
      if (!typed) return;
      for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
        // Bare-string targets and the package.json escape hatch carry no
        // conditions by design.
        if (typeof value === 'string' || subpath === './package.json') continue;
        expect(value.types, `${pkg.name} export ${subpath} has no types condition`).toBeTruthy();
      }
    },
  );

  it.each(packages)('$name never exposes its whole directory', ({ pkg }) => {
    // A `"./*"` catch-all would make every internal module a public API
    // surface, which defeats the point of having an exports map at all.
    expect(Object.keys(pkg.exports ?? {})).not.toContain('./*');
  });

  it.each(packages)('$name resolves every declared export target', ({ pkg, path }) => {
    for (const { subpath, condition, target } of exportTargets(pkg)) {
      if (target.includes('*')) continue;
      expect(
        existsSync(resolve(path, target)),
        `${pkg.name} export ${subpath} (${condition}) → ${target} does not exist`,
      ).toBe(true);
    }
  });
});
