/**
 * The published manifest and payload of every npm package.
 *
 * `npm pack --dry-run` is the authority on what actually ships: it applies
 * the `files` field, the implicit includes (README, LICENSE, package.json)
 * and the implicit excludes. Asserting against `dist/` on disk would miss
 * both.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  VERSIONED_NOT_PUBLISHED,
  exportTargets,
  loadPublishedPackages,
  readManifest,
} from './_packages';

interface PackFile {
  path: string;
  size: number;
}
interface PackResult {
  name: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackFile[];
}

/**
 * Coarse release guardrails, not byte-level regression targets. Keep enough
 * headroom that ordinary feature work does not require ratcheting these,
 * while still catching an accidental payload addition — the case that
 * motivated them was `dist/ui` plus source maps putting the service at
 * 39.4 MB packed / 138.5 MB unpacked before `!dist/**\/*.map` was added.
 */
const PACKED_SIZE_BUDGETS: Record<string, number> = {
  // Roughly 1.5x the measured size at the time of writing, so ordinary
  // feature work has room without a ratchet.        measured (packed)
  '@bendyline/gezel': 1_700_000, //                    1.08 MB
  '@bendyline/gezel-client': 250_000, //                94 KB
  '@bendyline/gezel-sdk': 150_000, //                   47 KB
  '@bendyline/gezel-app-sdk': 100_000, //               12 KB
  '@bendyline/gezel-plugin-sdk': 50_000, //              2 KB
  '@bendyline/gezel-catalog': 150_000, //               28 KB
  '@bendyline/gezel-knowledge': 150_000, //             ~25 KB
  '@bendyline/gezel-mcp': 300_000, //                  111 KB
  '@bendyline/gezel-connectors-spectral': 100_000, //    4 KB
  '@bendyline/gezel-script-stdlib': 100_000, //         14 KB
  '@bendyline/gezel-cli': 150_000, //                   31 KB
  // Carries the bundled web UI (`dist/ui`) and the handboek content so a
  // Node-only CLI install can serve `gezel start --web` with nothing else
  // to fetch. That is essentially all of this budget.
  '@bendyline/gezel-service': 25_000_000, //          18.1 MB
};

const ROOT_LICENSE = readFileSync(resolve(REPO_ROOT, 'LICENSE'), 'utf8');

const caches: string[] = [];
afterAll(() => {
  for (const dir of caches) rmSync(dir, { recursive: true, force: true });
});

function dryRunPack(directory: string): PackResult {
  const cache = mkdtempSync(join(tmpdir(), 'gezel-pack-cache-'));
  caches.push(cache);
  const packArgs = [
    'pack',
    '.',
    '--dry-run',
    '--json',
    '--ignore-scripts',
    '--workspaces=false',
    '--cache',
    cache,
  ];
  // npm is exposed through a .cmd shim on Windows. Node cannot launch
  // command-script shims directly, so invoke it explicitly through cmd.exe.
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...packArgs] : packArgs;
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      `npm pack failed in ${directory} (status=${result.status}, signal=${result.signal}):\n${detail}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  const packed = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packed?.files) throw new Error(`npm pack returned no package for ${directory}`);
  return packed as PackResult;
}

const packages = loadPublishedPackages();

describe('published package manifests', () => {
  it.each(packages)('$name is publishable', ({ pkg }) => {
    expect(pkg.private, 'must not be private — nothing would publish').toBeUndefined();
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.publishConfig?.provenance).toBe(true);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(packages)('$name carries npm page metadata', ({ dir, pkg }) => {
    const manifest = pkg as unknown as Record<string, unknown>;
    expect(manifest.description, 'shown under the package name on npm').toBeTruthy();
    expect(manifest.license).toBe('MIT');
    expect(manifest.homepage).toBeTruthy();
    expect(manifest.repository).toMatchObject({ directory: `packages/${dir}` });
  });

  it.each(packages)('$name runs no code on install', ({ pkg }) => {
    // Nothing we publish executes during `npm install`. That is a property
    // worth stating plainly to anyone auditing the supply chain, and it is
    // only true by construction — npm runs whatever these fields name.
    //
    // The service used to carry a `postinstall` that chmod +x'd node-pty's
    // macOS spawn-helper. npm 11.16 defers install scripts behind
    // `allowScripts`, so it stopped running on a plain install anyway; the
    // repair now happens lazily on the PTY spawn path
    // (`ensureNodePtyExecutable`), which also covers `--ignore-scripts` and
    // corporate policies that block them outright.
    const scripts = (pkg as unknown as { scripts?: Record<string, string> }).scripts ?? {};
    const lifecycle = ['preinstall', 'install', 'postinstall'].filter((name) => scripts[name]);
    expect(lifecycle, `${lifecycle.join(', ')} would execute on every consumer install`).toEqual(
      [],
    );
  });

  it.each(VERSIONED_NOT_PUBLISHED)('%s stays private so publish-package.mjs skips it', (dir) => {
    // multi-semantic-release versions, tags and changelogs these, but they
    // ship through electron-builder / the VS Code Marketplace. `private`
    // is the only switch keeping them off npm.
    expect(readManifest(dir).private).toBe(true);
  });
});

describe('published package payloads', () => {
  const packed = new Map(packages.map((p) => [p.name, dryRunPack(p.path)] as const));

  it.each(packages)('$name ships the workspace MIT license text', ({ name, path }) => {
    // Each package carries its own copy rather than leaning on the package
    // manager's implicit include. pnpm only injects the workspace-root LICENSE
    // when the package looks license-free, so vendoring third-party texts
    // silently suppresses it — that is how the service, which stages font
    // licenses into `dist/licenses/`, once packed with no MIT text at all
    // while still declaring `"license": "MIT"`.
    const files = packed.get(name)!.files.map((file) => file.path.replace(/\\/g, '/'));
    expect(files).toContain('LICENSE');
    expect(readFileSync(resolve(path, 'LICENSE'), 'utf8')).toBe(ROOT_LICENSE);
  });

  it.each(packages)('$name ships no source maps', ({ name }) => {
    const maps = packed.get(name)!.files.filter((f) => f.path.endsWith('.map'));
    expect(maps.map((f) => f.path)).toEqual([]);
  });

  it.each(packages)('$name ships no dangling source-map references', ({ name, path }) => {
    const references = packed
      .get(name)!
      .files.filter((file) => /\.(?:c|m)?js$/i.test(file.path))
      .filter((file) => {
        const source = readFileSync(resolve(path, file.path), 'utf8');
        return /^(?:[\t ]*\/\/[#@]|[\t ]*\/\*[#@])\s*sourceMappingURL\s*=/m.test(source);
      })
      .map((file) => file.path);
    expect(references).toEqual([]);
  });

  it.each(packages)('$name stays inside its packed-size budget', ({ name }) => {
    const budget = PACKED_SIZE_BUDGETS[name];
    expect(budget, `no size budget declared for ${name}`).toBeDefined();
    expect(packed.get(name)!.size).toBeLessThanOrEqual(budget);
  });

  it.each(packages.filter((p) => p.typed))(
    '$name ships no dangling relative imports in its declarations',
    ({ name, path }) => {
      // A dts rollup that inlines another package's chunk-split declarations
      // hoists that package's relative `./chunk-<hash>.js` imports into this
      // package's dist, where nothing resolves them: the packed tarball then
      // fails skipLibCheck=false typechecks and the editor type server loses
      // the surface. The SDK hit exactly this when core's dts grew a shared
      // chunk. Its public wire types now stay self-contained, and this pins
      // the invariant for every typed package against what npm actually packs.
      const files = packed.get(name)!.files.map((file) => file.path.replace(/\\/g, '/'));
      const declarations = files.filter((file) => file.endsWith('.d.ts'));
      const shipped = new Set(files);
      const dangling: string[] = [];
      for (const declaration of declarations) {
        // Comments hold JSDoc example imports and {@link import(...)} tags
        // that TypeScript never resolves as modules — scan only real code.
        const source = readFileSync(resolve(path, declaration), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[\t ]*\/\/.*$/gm, '');
        const parent = declaration.split('/').slice(0, -1).join('/');
        const specifiers = [
          ...source.matchAll(/\b(?:from\s+|import\s*\()\s*['"](\.\.?\/[^'"]+\.js)['"]/g),
          // Bare side-effect imports resolve too (TS2882 when missing).
          ...source.matchAll(/^\s*import\s*['"](\.\.?\/[^'"]+\.js)['"]/gm),
        ].map((match) => match[1] as string);
        for (const specifier of specifiers) {
          const segments = [...(parent ? parent.split('/') : []), ...specifier.split('/')];
          const normalized: string[] = [];
          for (const segment of segments) {
            if (segment === '.' || segment === '') continue;
            if (segment === '..') normalized.pop();
            else normalized.push(segment);
          }
          const target = normalized.join('/').replace(/\.js$/, '.d.ts');
          if (!shipped.has(target)) dangling.push(`${declaration} -> ${specifier}`);
        }
      }
      expect(dangling).toEqual([]);
    },
  );

  it.each(packages)('$name ships a README for its npm page', ({ name }) => {
    const files = packed.get(name)!.files.map((f) => f.path.toLowerCase());
    expect(files).toContain('readme.md');
  });

  it('does not ship the script stdlib test suite as runtime source', () => {
    const files = packed
      .get('@bendyline/gezel-script-stdlib')!
      .files.map((file) => file.path.replace(/\\/g, '/'));
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);
  });

  it('does not ship Python caches or test modules in the service payload', () => {
    const files = packed
      .get('@bendyline/gezel-service')!
      .files.map((file) => file.path.replace(/\\/g, '/'));
    expect(files.some((file) => file.includes('/__pycache__/'))).toBe(false);
    expect(files.some((file) => file.endsWith('.pyc'))).toBe(false);
    expect(files.some((file) => /\/(?:[^/]+_test|[^/]+_modeltest)\.py$/.test(file))).toBe(false);
  });

  it('ships attribution and license texts for every service UI font', () => {
    const service = packages.find((pkg) => pkg.name === '@bendyline/gezel-service')!;
    const files = new Set(
      packed.get(service.name)!.files.map((file) => file.path.replace(/\\/g, '/')),
    );
    expect(files.has('dist/NOTICE.md')).toBe(true);

    const fontAssets = [...files].filter(
      (file) => file.startsWith('dist/ui/assets/') && /\.(?:woff2?|ttf|otf)$/i.test(file),
    );
    expect(fontAssets.length).toBeGreaterThan(0);

    const legalRoot = resolve(service.dist, 'licenses/fonts');
    const legalFiles = readdirSync(legalRoot);
    expect(legalFiles).toHaveLength(19);
    for (const file of legalFiles) {
      expect(files.has(`dist/licenses/fonts/${file}`), file).toBe(true);
    }

    const notice = readFileSync(resolve(service.dist, 'NOTICE.md'), 'utf8');
    for (const attribution of [
      'OpenMoji attribution note',
      'Font Awesome Free 7.2.0',
      'Visual Studio Code icons',
      'Microsoft Corporation',
    ]) {
      expect(notice, attribution).toContain(attribution);
    }
  });

  it.each(packages)(
    '$name ships every file its exports and bin point at',
    ({ name, path, pkg }) => {
      const shipped = new Set(packed.get(name)!.files.map((f) => f.path.replace(/\\/g, '/')));
      const referenced = [
        ...exportTargets(pkg).map((t) => t.target),
        ...Object.values(pkg.bin ?? {}),
        pkg.main,
        pkg.module,
        pkg.types,
        // No install-script target to check — "runs no code on install" above
        // forbids the lifecycle fields entirely.
      ].filter((t): t is string => typeof t === 'string' && t.startsWith('./'));

      for (const target of new Set(referenced)) {
        const relative = target.slice(2);
        // Wildcard subpaths (`./scripts/*`) resolve at import time; assert the
        // directory exists rather than trying to expand the pattern here.
        if (relative.includes('*')) {
          expect(existsSync(resolve(path, relative.split('*')[0]))).toBe(true);
          continue;
        }
        expect(
          shipped.has(relative) || relative === 'package.json',
          `${name}: ${target} is referenced but not packed`,
        ).toBe(true);
      }
    },
  );

  it('reports the packed footprint', () => {
    const rows = packages
      .map((p) => ({ name: p.name, ...packed.get(p.name)! }))
      .sort((a, b) => b.size - a.size)
      .map(
        (r) =>
          `  ${(r.size / 1e6).toFixed(2)} MB  ${r.entryCount.toString().padStart(4)} files  ${r.name}`,
      );
    console.log(`packed footprint (repo root ${REPO_ROOT}):\n${rows.join('\n')}`);
    expect(rows.length).toBe(packages.length);
  });
});
