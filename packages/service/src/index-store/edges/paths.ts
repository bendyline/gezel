/**
 * Path helpers shared by the resolvers. Every path is project-relative with
 * forward slashes and no leading `./`; the empty string is the project root.
 */

/** Collapse `.` and `..`; null when the path climbs above the project root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** `dir/rel`, normalized. */
export function joinPath(dir: string, rel: string): string | null {
  return normalizePath(dir ? `${dir}/${rel}` : rel);
}

/** Module extensions a JS/TS import may omit, in TypeScript's probing order. */
export const JS_MODULE_EXTS = ['ts', 'tsx', 'mts', 'cts', 'd.ts', 'js', 'jsx', 'mjs', 'cjs'];

// NodeNext-style TS imports name the EMITTED file ('../chat/manager.js') while
// the repo holds 'manager.ts' — probe the TS spellings of a JS extension too.
const JS_TO_TS: Record<string, string[]> = {
  js: ['ts', 'tsx'],
  jsx: ['tsx'],
  mjs: ['mts'],
  cjs: ['cts'],
};

/**
 * The file a module path names, probing the path itself, the TypeScript
 * spelling of a JS extension, each module extension, and `dir/index.*`.
 */
export function probeModule(
  base: string,
  pathSet: ReadonlySet<string>,
  exts: readonly string[] = JS_MODULE_EXTS,
): string | null {
  if (pathSet.has(base)) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > base.lastIndexOf('/') ? base.slice(dot + 1) : '';
  for (const e of JS_TO_TS[ext] ?? []) {
    const c = `${base.slice(0, dot)}.${e}`;
    if (pathSet.has(c)) return c;
  }
  for (const e of exts) {
    const c = `${base}.${e}`;
    if (pathSet.has(c)) return c;
  }
  for (const e of exts) {
    const c = base ? `${base}/index.${e}` : `index.${e}`;
    if (pathSet.has(c)) return c;
  }
  return null;
}
