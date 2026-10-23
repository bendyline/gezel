import type { ImportBinding } from '../index-store-types.js';
import type { ResolveContext } from './context.js';
import { dirOf, joinPath } from './paths.js';
import type { Resolution } from './types.js';

/**
 * Python imports. Relative ones (`from . import a`, `from ..pkg.mod import x`)
 * climb one folder per extra dot; absolute ones (`import pkg.mod`) are tried
 * from the project root, `src/`, and every folder holding a pyproject.toml,
 * setup.py or setup.cfg. `from pkg import sub` may name a submodule rather
 * than a name inside `pkg/__init__.py`, so each imported name that is also a
 * file becomes its own edge.
 */
export function resolvePythonImport(
  ctx: ResolveContext,
  src: string,
  raw: string,
  bindings: ImportBinding[] | null,
): Resolution | null {
  const relative = /^(\.+)(.*)$/.exec(raw);
  if (relative) {
    let base: string | null = dirOf(src);
    for (let i = 1; i < relative[1]!.length && base !== null; i++) {
      base = base ? dirOf(base) : null;
    }
    if (base === null) return null;
    const dsts = modulesUnder(ctx, base, relative[2] ?? '', bindings);
    return dsts.length > 0 ? { dsts, resolver: 'py-rel' } : null;
  }
  for (const root of ctx.pythonRoots) {
    const dsts = modulesUnder(ctx, root, raw, bindings);
    if (dsts.length > 0) return { dsts, resolver: 'py-abs' };
  }
  return null;
}

/** The module `dotted` names under `base`, plus imported names that are submodules. */
function modulesUnder(
  ctx: ResolveContext,
  base: string,
  dotted: string,
  bindings: ImportBinding[] | null,
): string[] {
  const out: string[] = [];
  const modDir = dotted ? joinPath(base, dotted.replace(/\./g, '/')) : base;
  if (modDir === null) return out;
  const own = dotted ? moduleFile(ctx, modDir) : null;
  for (const b of bindings ?? []) {
    if (b.kind !== 'named') continue;
    const sub = joinPath(modDir, b.name);
    const hit = sub !== null ? moduleFile(ctx, sub) : null;
    if (hit && !out.includes(hit)) out.push(hit);
  }
  if (own && !out.includes(own)) out.unshift(own);
  if (out.length === 0 && !dotted) {
    // `from . import x` where x is a name defined in the package itself.
    const init = joinPath(base, '__init__.py');
    if (init !== null && ctx.pathSet.has(init)) out.push(init);
  }
  return out;
}

function moduleFile(ctx: ResolveContext, path: string): string | null {
  for (const c of [`${path}.py`, `${path}/__init__.py`]) if (ctx.pathSet.has(c)) return c;
  return null;
}
