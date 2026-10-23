import { resolveSpecifier } from '../../filemap/affinity.js';
import { type ResolveContext, type WorkspacePackage, isRecord } from './context.js';
import { dirOf, joinPath, normalizePath, probeModule } from './paths.js';
import { resolveRequireJsImport } from './requirejs.js';
import type { Resolution } from './types.js';

/**
 * JS/TS (and Vue/Svelte script) imports: a relative specifier exactly as the
 * Village has always resolved it, then the importer's tsconfig `paths` and
 * `baseUrl`, then a workspace package by its manifest name — mapped back to
 * the package's source, because `exports` usually names built output — then
 * an AMD module id against the RequireJS `baseUrl` of the page that governs
 * the importer.
 */
export function resolveJsImport(ctx: ResolveContext, src: string, raw: string): Resolution | null {
  if (raw.startsWith('.')) {
    const dst = resolveSpecifier(src, raw, ctx.pathSet as Set<string>);
    return dst ? { dsts: [dst], resolver: 'relative' } : null;
  }
  if (raw.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const viaPaths = resolveTsPaths(ctx, src, raw);
  if (viaPaths) return { dsts: [viaPaths], resolver: 'ts-paths' };
  const viaPackage = resolveWorkspacePackage(ctx, raw);
  if (viaPackage) return { dsts: [viaPackage], resolver: 'workspace' };
  const viaRequireJs = resolveRequireJsImport(ctx, src, raw);
  if (viaRequireJs) {
    return {
      dsts: [viaRequireJs.dst],
      resolver: viaRequireJs.local ? 'requirejs-local' : 'requirejs',
    };
  }
  return null;
}

// ── tsconfig paths / baseUrl ─────────────────────────────────────────────

interface EffectiveTsConfig {
  /** Folder `baseUrl` points at, when a config in the chain set one. */
  baseDir: string | null;
  paths: Record<string, string[]> | null;
  /** Folder `paths` targets are relative to (baseUrl, else the config that declared them). */
  pathsDir: string | null;
}

const tsconfigCache = new WeakMap<ResolveContext, Map<string, EffectiveTsConfig | null>>();

/** The tsconfig governing a file: the nearest one at or above its folder. */
function nearestTsConfig(ctx: ResolveContext, src: string): EffectiveTsConfig | null {
  let cache = tsconfigCache.get(ctx);
  if (!cache) {
    cache = new Map();
    tsconfigCache.set(ctx, cache);
  }
  let dir = dirOf(src);
  for (;;) {
    const configPath = ctx.tsconfigDirs.get(dir);
    if (configPath) {
      if (!cache.has(configPath)) cache.set(configPath, effectiveConfig(ctx, configPath, 0));
      return cache.get(configPath) ?? null;
    }
    if (!dir) return null;
    dir = dirOf(dir);
  }
}

/** Follow relative `extends` (up to 8 deep); a child's options win. */
function effectiveConfig(
  ctx: ResolveContext,
  configPath: string,
  depth: number,
): EffectiveTsConfig | null {
  const json = ctx.tsconfigs.get(configPath);
  if (!isRecord(json)) return null;
  let inherited: EffectiveTsConfig = { baseDir: null, paths: null, pathsDir: null };
  const ext = json.extends;
  for (const parent of typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : []) {
    if (typeof parent !== 'string' || !parent.startsWith('.') || depth >= 8) continue;
    const target = joinPath(
      dirOf(configPath),
      parent.endsWith('.json') ? parent : `${parent}.json`,
    );
    const resolved = target ? effectiveConfig(ctx, target, depth + 1) : null;
    if (resolved) inherited = { ...inherited, ...definedOnly(resolved) };
  }
  const options = isRecord(json.compilerOptions) ? json.compilerOptions : {};
  const configDir = dirOf(configPath);
  const baseDir =
    typeof options.baseUrl === 'string' ? joinPath(configDir, options.baseUrl) : inherited.baseDir;
  const ownPaths = isRecord(options.paths) ? stringArrays(options.paths) : null;
  return {
    baseDir,
    paths: ownPaths ?? inherited.paths,
    // An effective baseUrl wins; without one, targets are relative to the
    // config that declared the paths.
    pathsDir: baseDir ?? (ownPaths ? configDir : inherited.pathsDir),
  };
}

function definedOnly(config: EffectiveTsConfig): Partial<EffectiveTsConfig> {
  return Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null));
}

function stringArrays(record: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) out[key] = value.filter((v): v is string => typeof v === 'string');
  }
  return out;
}

function resolveTsPaths(ctx: ResolveContext, src: string, raw: string): string | null {
  const config = nearestTsConfig(ctx, src);
  if (!config) return null;
  if (config.paths && config.pathsDir !== null) {
    // TypeScript takes the pattern with the longest literal prefix.
    const matches: Array<{ prefixLength: number; star: string; targets: string[] }> = [];
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const star = pattern.indexOf('*');
      if (star < 0) {
        if (pattern === raw) matches.push({ prefixLength: pattern.length, star: '', targets });
        continue;
      }
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (
        raw.length >= prefix.length + suffix.length &&
        raw.startsWith(prefix) &&
        raw.endsWith(suffix)
      ) {
        matches.push({
          prefixLength: prefix.length,
          star: raw.slice(prefix.length, raw.length - suffix.length),
          targets,
        });
      }
    }
    matches.sort((a, b) => b.prefixLength - a.prefixLength);
    for (const match of matches) {
      for (const target of match.targets) {
        const base = joinPath(config.pathsDir, target.replace('*', match.star));
        const hit = base !== null ? probeModule(base, ctx.pathSet) : null;
        if (hit) return hit;
      }
    }
  }
  if (config.baseDir !== null) {
    const base = joinPath(config.baseDir, raw);
    const hit = base !== null ? probeModule(base, ctx.pathSet) : null;
    if (hit) return hit;
  }
  return null;
}

// ── workspace packages ───────────────────────────────────────────────────

/** Conditions in the order that best names a package's source. */
const CONDITION_ORDER = [
  'source',
  'development',
  'types',
  'typings',
  'import',
  'module',
  'browser',
  'node',
  'require',
  'default',
];

/** Build-output folders a manifest points into, whose source sits in `src/`. */
const OUT_DIRS = new Set(['dist', 'build', 'lib', 'out', 'esm', 'cjs', 'types']);

export function resolveWorkspacePackage(ctx: ResolveContext, raw: string): string | null {
  const pkg = ctx.packages.find((p) => raw === p.name || raw.startsWith(`${p.name}/`));
  if (!pkg) return null;
  const sub = raw === pkg.name ? '.' : `./${raw.slice(pkg.name.length + 1)}`;
  const exported = exportTarget(pkg.manifest.exports, sub);
  if (exported) {
    const hit = sourceFor(ctx, pkg, exported);
    if (hit) return hit;
  }
  if (sub === '.') {
    for (const field of ['source', 'types', 'typings', 'module', 'main']) {
      const value = pkg.manifest[field];
      if (typeof value !== 'string') continue;
      const hit = sourceFor(ctx, pkg, value);
      if (hit) return hit;
    }
    for (const base of [joinPath(pkg.dir, 'src/index'), joinPath(pkg.dir, 'index')]) {
      const hit = base !== null ? probeModule(base, ctx.pathSet) : null;
      if (hit) return hit;
    }
    return null;
  }
  const rest = sub.slice(2);
  for (const base of [joinPath(pkg.dir, rest), joinPath(pkg.dir, `src/${rest}`)]) {
    const hit = base !== null ? probeModule(base, ctx.pathSet) : null;
    if (hit) return hit;
  }
  return null;
}

/** The `exports` target for a subpath (`.` or `./x`), conditions resolved. */
function exportTarget(exports: unknown, sub: string): string | null {
  if (exports === undefined || exports === null) return null;
  if (typeof exports === 'string') return sub === '.' ? exports : null;
  if (Array.isArray(exports)) {
    for (const e of exports) {
      const t = exportTarget(e, sub);
      if (t) return t;
    }
    return null;
  }
  if (!isRecord(exports)) return null;
  const keys = Object.keys(exports);
  // A conditions object (no `./` keys) is the target of `.`.
  if (!keys.some((k) => k.startsWith('.'))) return sub === '.' ? pickCondition(exports) : null;
  if (sub in exports) return pickCondition(exports[sub]);
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      sub.startsWith(prefix) &&
      sub.endsWith(suffix) &&
      sub.length >= prefix.length + suffix.length
    ) {
      const target = pickCondition(exports[key]);
      return target
        ? target.replace('*', sub.slice(prefix.length, sub.length - suffix.length))
        : null;
    }
  }
  return null;
}

function pickCondition(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value;
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = pickCondition(v, depth + 1);
      if (t) return t;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const condition of CONDITION_ORDER) {
    if (condition in value) {
      const t = pickCondition(value[condition], depth + 1);
      if (t) return t;
    }
  }
  for (const v of Object.values(value)) {
    const t = pickCondition(v, depth + 1);
    if (t) return t;
  }
  return null;
}

/**
 * The source file behind a manifest path: `dist/x.js` (or `.d.ts`) → `src/x.ts`
 * when that source exists, else the path itself when it is indexed.
 */
function sourceFor(ctx: ResolveContext, pkg: WorkspacePackage, target: string): string | null {
  const full = joinPath(pkg.dir, target);
  if (full === null) return null;
  const stem = full.replace(/\.d\.[cm]?ts$/, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const inPkg = pkg.dir ? stem.slice(pkg.dir.length + 1) : stem;
  const [first, ...rest] = inPkg.split('/');
  if (first && OUT_DIRS.has(first) && rest.length > 0) {
    const srcStem = normalizePath(`${pkg.dir ? `${pkg.dir}/` : ''}src/${rest.join('/')}`);
    const hit = srcStem !== null ? probeModule(srcStem, ctx.pathSet, SOURCE_EXTS) : null;
    if (hit) return hit;
  }
  const own = probeModule(stem, ctx.pathSet, SOURCE_EXTS);
  if (own) return own;
  return ctx.pathSet.has(full) ? full : null;
}

const SOURCE_EXTS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];
