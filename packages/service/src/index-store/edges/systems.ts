import type { ResolveContext, RustCrate } from './context.js';
import { baseOf, dirOf, joinPath, normalizePath } from './paths.js';
import type { Resolution } from './types.js';

/** A Go import names a package — a folder — so it depends on that folder's files. */
const GO_PACKAGE_FILE_CAP = 50;

/**
 * Go: an import path under a go.mod's `module` names the package folder at
 * the same relative path; the edge goes to each non-test `.go` file there.
 */
export function resolveGoImport(ctx: ResolveContext, raw: string): Resolution | null {
  const mod = ctx.goModules.find((m) => raw === m.module || raw.startsWith(`${m.module}/`));
  if (!mod) return null;
  const rest = raw.slice(mod.module.length).replace(/^\//, '');
  const pkgDir = joinPath(mod.dir, rest);
  if (pkgDir === null) return null;
  const dsts = (ctx.filesByDir.get(pkgDir) ?? [])
    .filter((p) => p.endsWith('.go') && !p.endsWith('_test.go'))
    .sort()
    .slice(0, GO_PACKAGE_FILE_CAP);
  return dsts.length > 0 ? { dsts, resolver: 'go-mod' } : null;
}

/**
 * Rust: `mod x;` loads `x.rs` or `x/mod.rs` beside its parent module;
 * `use crate::a::b` / `self::` / `super::` / `other_crate::a` walk module
 * folders to the deepest file that exists (the rest of the path names items
 * inside it). External crates (std, crates.io) resolve to nothing.
 */
export function resolveRustImport(
  ctx: ResolveContext,
  src: string,
  raw: string,
): Resolution | null {
  if (raw.startsWith('mod ')) {
    const name = raw.slice(4).trim();
    const dst = rustModuleFile(ctx, joinPath(rustModuleDir(src), name));
    return dst ? { dsts: [dst], resolver: 'rust' } : null;
  }
  // `crate::a::b::{c, d}` / `crate::a::*` / `a::b as c` → the path part.
  const path = raw
    .replace(/\s+as\s+\w+$/, '')
    .replace(/::\{.*$/, '')
    .replace(/::\*$/, '');
  const segs = path.split('::').filter(Boolean);
  if (segs.length === 0) return null;
  const crate = crateOf(ctx, src);
  let dir: string | null;
  let rest: string[];
  if (segs[0] === 'crate') {
    if (!crate) return null;
    dir = crate.srcDir;
    rest = segs.slice(1);
  } else if (segs[0] === 'self' || segs[0] === 'super') {
    dir = rustModuleDir(src);
    rest = segs;
    while (rest[0] === 'self' || rest[0] === 'super') {
      if (rest[0] === 'super') dir = dir ? dirOf(dir) : null;
      rest = rest.slice(1);
      if (dir === null) return null;
    }
  } else {
    const other = ctx.rustCrates.find((c) => c.name === segs[0]);
    if (!other) return null;
    dir = other.srcDir;
    rest = segs.slice(1);
  }
  for (let k = rest.length; k > 0; k--) {
    const dst = rustModuleFile(ctx, joinPath(dir, rest.slice(0, k).join('/')));
    if (dst && dst !== src) return { dsts: [dst], resolver: 'rust' };
  }
  const root = segs[0] === 'crate' ? crate?.rootFile : null;
  return root && root !== src ? { dsts: [root], resolver: 'rust' } : null;
}

/** The folder a Rust file's child modules live in. */
function rustModuleDir(file: string): string {
  const base = baseOf(file);
  const dir = dirOf(file);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  const stem = base.replace(/\.rs$/, '');
  return dir ? `${dir}/${stem}` : stem;
}

function rustModuleFile(ctx: ResolveContext, path: string | null): string | null {
  if (path === null) return null;
  for (const c of [`${path}.rs`, `${path}/mod.rs`]) if (ctx.pathSet.has(c)) return c;
  return null;
}

function crateOf(ctx: ResolveContext, src: string): RustCrate | undefined {
  return ctx.rustCrates.find((c) => src === c.srcDir || src.startsWith(`${c.srcDir}/`));
}

/**
 * C/C++: `#include "x.h"` is looked for beside the includer, then under the
 * project's include folders, then as the one file whose path ends in `x.h`.
 * `#include <x.h>` is a system header unless a project include folder has it.
 */
export function resolveCInclude(ctx: ResolveContext, src: string, raw: string): Resolution | null {
  const system = raw.startsWith('<');
  const name = system ? raw.slice(1, -1).trim() : raw;
  if (!name) return null;
  const candidates = [
    ...(system ? [] : [joinPath(dirOf(src), name)]),
    ...ctx.includeRoots.filter((r) => system || r !== '').map((r) => joinPath(r, name)),
    ...(system ? [] : [normalizePath(name)]),
  ];
  for (const c of candidates) {
    if (c && c !== src && ctx.pathSet.has(c)) return { dsts: [c], resolver: 'c-include' };
  }
  if (system) return null;
  const suffix = `/${name}`;
  const matches = (ctx.pathsByBase.get(baseOf(name)) ?? []).filter(
    (p) => p !== src && (p === name || p.endsWith(suffix)),
  );
  return matches.length === 1 ? { dsts: [matches[0]!], resolver: 'c-include' } : null;
}

/**
 * A markdown link: relative to the document, or to the project root for
 * `/docs/x.md`. A folder link opens its README or index; a wiki-style link
 * without an extension finds the `.md` of that name.
 */
export function resolveMarkdownLink(
  ctx: ResolveContext,
  src: string,
  raw: string,
): Resolution | null {
  const target = raw.startsWith('/') ? normalizePath(raw.slice(1)) : joinPath(dirOf(src), raw);
  if (target === null) return null;
  const candidates = [
    target,
    `${target}.md`,
    joinPath(target, 'README.md'),
    joinPath(target, 'readme.md'),
    joinPath(target, 'index.md'),
  ];
  for (const c of candidates) {
    if (c && c !== src && ctx.pathSet.has(c)) return { dsts: [c], resolver: 'md-link' };
  }
  return null;
}
