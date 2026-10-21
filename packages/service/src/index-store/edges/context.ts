import { baseOf, dirOf, joinPath } from './paths.js';
import type { EdgeFile, ProjectConfigFiles } from './types.js';

/** A workspace package: its manifest name, folder, and manifest. */
export interface WorkspacePackage {
  name: string;
  dir: string;
  manifest: Record<string, unknown>;
}

/** A Go module rooted at a go.mod. */
export interface GoModule {
  module: string;
  dir: string;
}

/** A Rust crate rooted at a Cargo.toml with a [package] section. */
export interface RustCrate {
  /** The name as Rust code spells it (dashes become underscores). */
  name: string;
  srcDir: string;
  /** src/lib.rs, else src/main.rs, when present. */
  rootFile: string | null;
}

/** Everything resolution derives from the file set and manifests, built once. */
export interface ResolveContext {
  pathSet: ReadonlySet<string>;
  /** Folder → the files directly inside it. */
  filesByDir: ReadonlyMap<string, readonly string[]>;
  /** Folders with a tsconfig/jsconfig, mapped to that config's path. */
  tsconfigDirs: ReadonlyMap<string, string>;
  tsconfigs: ReadonlyMap<string, unknown>;
  /** Longest name first, so `@a/b-c` wins over `@a/b`. */
  packages: readonly WorkspacePackage[];
  /** Folders a Python absolute import may start from. */
  pythonRoots: readonly string[];
  goModules: readonly GoModule[];
  rustCrates: readonly RustCrate[];
  /** Folders named `include` (and the project root) a C header may live under. */
  includeRoots: readonly string[];
  /** File name → every path with that name, for a unique-suffix header match. */
  pathsByBase: ReadonlyMap<string, readonly string[]>;
}

const PY_PROJECT_MARKERS = new Set(['pyproject.toml', 'setup.py', 'setup.cfg']);

export function buildResolveContext(
  files: readonly EdgeFile[],
  configs: ProjectConfigFiles,
): ResolveContext {
  const pathSet = new Set(files.map((f) => f.path));
  const filesByDir = new Map<string, string[]>();
  const pathsByBase = new Map<string, string[]>();
  const pythonRoots = new Set<string>(['', 'src']);
  const includeRoots = new Set<string>(['']);
  for (const f of files) {
    const dir = dirOf(f.path);
    const base = baseOf(f.path);
    pushTo(filesByDir, dir, f.path);
    pushTo(pathsByBase, base, f.path);
    if (PY_PROJECT_MARKERS.has(base)) {
      pythonRoots.add(dir);
      pythonRoots.add(dir ? `${dir}/src` : 'src');
    }
    const segs = dir.split('/');
    const at = segs.lastIndexOf('include');
    if (at >= 0) includeRoots.add(segs.slice(0, at + 1).join('/'));
  }

  const tsconfigDirs = new Map<string, string>();
  for (const path of [...configs.tsconfigs.keys()].sort()) {
    const base = baseOf(path);
    // A folder's own tsconfig.json wins over a jsconfig or a variant.
    const dir = dirOf(path);
    const current = tsconfigDirs.get(dir);
    if (!current || base === 'tsconfig.json') tsconfigDirs.set(dir, path);
  }

  const packages: WorkspacePackage[] = [];
  for (const [path, manifest] of configs.packageJsons) {
    if (!isRecord(manifest) || typeof manifest.name !== 'string' || !manifest.name) continue;
    packages.push({ name: manifest.name, dir: dirOf(path), manifest });
  }
  packages.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));

  const goModules: GoModule[] = [];
  for (const [path, text] of configs.goMods) {
    const m = /^\s*module\s+(\S+)/m.exec(text);
    if (m?.[1]) goModules.push({ module: m[1].replace(/^"|"$/g, ''), dir: dirOf(path) });
  }
  goModules.sort((a, b) => b.module.length - a.module.length);

  const rustCrates: RustCrate[] = [];
  for (const [path, text] of configs.cargoTomls) {
    const name = cargoPackageName(text);
    if (!name) continue;
    const srcDir = joinPath(dirOf(path), 'src') ?? 'src';
    const lib = `${srcDir}/lib.rs`;
    const main = `${srcDir}/main.rs`;
    rustCrates.push({
      name: name.replace(/-/g, '_'),
      srcDir,
      rootFile: pathSet.has(lib) ? lib : pathSet.has(main) ? main : null,
    });
  }
  rustCrates.sort((a, b) => b.srcDir.length - a.srcDir.length);

  return {
    pathSet,
    filesByDir,
    tsconfigDirs,
    tsconfigs: configs.tsconfigs,
    packages,
    pythonRoots: [...pythonRoots].sort((a, b) => a.length - b.length || a.localeCompare(b)),
    goModules,
    rustCrates,
    includeRoots: [...includeRoots].sort(),
    pathsByBase,
  };
}

/** `name = "…"` inside Cargo.toml's `[package]` table. */
export function cargoPackageName(text: string): string | null {
  let inPackage = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inPackage = t === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const m = /^name\s*=\s*["']([^"']+)["']/.exec(t);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
