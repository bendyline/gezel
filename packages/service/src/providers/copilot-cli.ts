import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

/**
 * Where the Copilot CLI handed to the SDK came from. Logged at client
 * start — when Copilot fails to launch, the first question is always
 * which binary it was pointed at.
 */
export type CopilotCliSource = 'env' | 'managed' | 'path';

export interface CopilotCliResolution {
  path: string;
  source: CopilotCliSource;
}

/**
 * Filename appended to a directory so the ancestor walk below starts at
 * that directory rather than its parent. Never opened.
 */
const RESOLVE_ANCHOR = 'gezel-copilot-anchor.js';

/**
 * Platform packages the Copilot CLI publishes for this host, mirroring
 * the SDK's own `getCliPlatformPackageNames()`. Linux ships glibc and
 * musl builds under different names, so both are candidates there.
 */
export function copilotPlatformPackages(
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  const variants = platform === 'linux' ? ['linux', 'linuxmusl'] : [platform];
  return variants.map((variant) => `@github/copilot-${variant}-${arch}`);
}

/**
 * The `node_modules` directories Node would consult for `anchor`, walked
 * by hand rather than through `createRequire`. Two reasons: the global
 * folders `require.resolve.paths` appends can hand back an unrelated CLI
 * that we would then mislabel as the managed one, and vitest patches
 * `createRequire` to resolve against the vite root, which makes any
 * resolution built on it untestable.
 */
function* ancestorModuleDirs(anchor: string): Generator<string> {
  let dir = dirname(anchor);
  while (true) {
    if (basename(dir) !== 'node_modules') yield join(dir, 'node_modules');
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Entrypoints a package manifest names for itself, most specific first. */
function declaredEntries(manifest: Record<string, unknown>): string[] {
  const found: string[] = [];
  const exported = manifest.exports;
  if (typeof exported === 'string') found.push(exported);
  else if (exported && typeof exported === 'object') {
    const root = (exported as Record<string, unknown>)['.'];
    if (typeof root === 'string') found.push(root);
  }
  const bin = manifest.bin;
  if (typeof bin === 'string') found.push(bin);
  else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') found.push(value);
    }
  }
  return found;
}

/**
 * The file to spawn for a platform package: the native binary it
 * declares, falling back to its `index.js` loader.
 *
 * Preferring the binary is load-bearing, not tidiness. The SDK's own
 * lookup returns `index.js` and then launches it with `process.execPath`
 * — which is the Electron executable whenever the daemon runs embedded
 * in the desktop app, so the CLI comes up against an argv Electron has
 * already claimed part of and dies before it can serve a request (exit 0,
 * empty stderr, "CLI server exited unexpectedly"). The `@github/copilot`
 * bin resolves the same platform package and execs its binary directly;
 * so do we, which keeps Node out of the picture entirely.
 */
function platformEntry(pkgDir: string): string | null {
  const manifestPath = join(pkgDir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  let declared: string[] = [];
  try {
    declared = declaredEntries(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    declared = [];
  }
  for (const rel of [...declared, 'index.js']) {
    const candidate = join(pkgDir, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function platformEntryIn(base: string, packages: string[]): string | null {
  for (const pkg of packages) {
    const entry = platformEntry(join(base, ...pkg.split('/')));
    if (entry) return entry;
  }
  return null;
}

/**
 * Find the platform CLI entrypoint near `anchor`, falling back to a walk
 * re-anchored on `@github/copilot` itself.
 *
 * That fallback is the whole point. The SDK searches only the ancestor
 * `node_modules` of its own file, which assumes npm's flat hoisting.
 * Under pnpm's isolated linker the platform package is an optional dep
 * of `@github/copilot` and sits beside it in the virtual store, invisible
 * from the SDK's own directory — which is how a complete, integrity-
 * verified `~/.gezel/system-toolsets/` install still reported "Could not
 * find a @github/copilot platform package. Searched 9 paths." Resolving
 * the CLI package's real location is the one step every linker layout
 * agrees on, because the two are always adjacent there.
 */
function platformEntryFrom(anchor: string, packages: string[]): string | null {
  const bases = [...ancestorModuleDirs(anchor)];
  for (const base of bases) {
    const hit = platformEntryIn(base, packages);
    if (hit) return hit;
  }
  for (const base of bases) {
    const manifest = join(base, '@github', 'copilot', 'package.json');
    if (!existsSync(manifest)) continue;
    let real: string;
    try {
      real = realpathSync(manifest);
    } catch {
      continue;
    }
    for (const inner of ancestorModuleDirs(real)) {
      const hit = platformEntryIn(inner, packages);
      if (hit) return hit;
    }
  }
  return null;
}

function fromPath(
  env: NodeJS.ProcessEnv,
  packages: string[],
  platform: string,
): CopilotCliResolution | null {
  const names = platform === 'win32' ? ['copilot.exe', 'copilot.cmd'] : ['copilot'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const bin = join(dir, name);
      if (!existsSync(bin)) continue;

      // npm's global prefix keeps the shim beside a sibling
      // `node_modules/` on Windows, and symlinks it into
      // `lib/node_modules/@github/copilot/` everywhere else.
      const sibling = platformEntryFrom(join(dir, RESOLVE_ANCHOR), packages);
      if (sibling) return { path: sibling, source: 'path' };

      let real: string | null = null;
      try {
        real = realpathSync(bin);
      } catch {
        real = null;
      }
      const linked = real ? platformEntryFrom(real, packages) : null;
      if (linked) return { path: linked, source: 'path' };

      // A standalone install with no package tree around it. The SDK
      // spawns any non-`.js` path directly, which rules out `.cmd`
      // shims — Node's shell-less spawn cannot execute a batch file.
      if (!name.endsWith('.cmd')) return { path: bin, source: 'path' };
    }
  }
  return null;
}

/**
 * Find a Copilot CLI to hand the SDK, preferring the copy we manage.
 *
 * Order: an explicit `COPILOT_CLI_PATH`, then the `@github/copilot` that
 * ships with our pinned system-toolset install of `@github/copilot-sdk`,
 * then a CLI the user installed themselves and put on PATH. Returns
 * `null` when none of those turn one up, leaving the SDK to run its own
 * lookup — which is what still covers the dev workspace, where the SDK
 * resolves from `node_modules/.pnpm/node_modules/`.
 */
export function resolveCopilotCliPath(
  opts: {
    installRoot?: string | null;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    arch?: string;
  } = {},
): CopilotCliResolution | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const packages = copilotPlatformPackages(platform, opts.arch);

  const override = env.COPILOT_CLI_PATH;
  if (override) return { path: override, source: 'env' };

  if (opts.installRoot) {
    const managed = platformEntryFrom(join(opts.installRoot, RESOLVE_ANCHOR), packages);
    if (managed) return { path: managed, source: 'managed' };
  }

  return fromPath(env, packages, platform);
}
