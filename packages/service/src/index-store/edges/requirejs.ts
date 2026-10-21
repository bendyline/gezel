import type { ResolveContext } from './context.js';
import { dirOf, joinPath, probeModule } from './paths.js';

/**
 * RequireJS (AMD) module ids. An AMD codebase writes `require("utils/StringUtils")`
 * and means a file under the loader's `baseUrl`, not an npm package: Brackets
 * resolved 33 of its 1,972 imports before this, so its load-bearing files and
 * Village roads were nearly empty (2026-10-21).
 *
 * The configuration comes from the pages that load RequireJS: a page's
 * `data-main` script and its other local scripts may call `require.config`
 * (or set `var require = {…}`) with a `baseUrl` and `paths`. Without a
 * `baseUrl`, ids resolve against the `data-main` script's folder, else the
 * page's own. Ids are matched only against files that exist, so an npm
 * package name resolves to nothing.
 */

/** A RequireJS setup found on a page that loads it. */
export interface RequireJsConfig {
  /** Folder of the page that loads RequireJS. */
  pageDir: string;
  /** Folder module ids resolve against. */
  baseDir: string;
  /** `paths` aliases; each target resolves against `baseDir`. */
  paths: Record<string, string>;
}

/** What a page tells us: whether it loads RequireJS, its data-main, and its other local scripts. */
export function requireJsPage(
  html: string,
  pagePath: string,
): { dataMain: string | null; scripts: string[] } | null {
  const pageDir = dirOf(pagePath);
  const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  const loadsRequire = tags.some((tag) =>
    /\bsrc\s*=\s*["'][^"']*\brequire(?:\.min)?\.js["']/i.test(tag),
  );
  if (!loadsRequire) return null;
  let dataMain: string | null = null;
  const scripts: string[] = [];
  for (const tag of tags) {
    const main = /\bdata-main\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (main && !dataMain) dataMain = localScript(pageDir, main);
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src && !/\brequire(?:\.min)?\.js$/i.test(src)) {
      const path = localScript(pageDir, src);
      if (path) scripts.push(path);
    }
  }
  return { dataMain, scripts };
}

function localScript(pageDir: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref) || ref.startsWith('/')) return null;
  const clean = ref.split(/[?#]/)[0] ?? '';
  return joinPath(pageDir, /\.js$/i.test(clean) ? clean : `${clean}.js`);
}

/** `baseUrl` and `paths` from every `require.config` / `requirejs.config` / `var require = {…}` in a script. */
export function parseRequireJsConfig(js: string): {
  baseUrl: string | null;
  paths: Record<string, string>;
} {
  const text = stripComments(js);
  let baseUrl: string | null = null;
  const paths: Record<string, string> = {};
  const starts =
    /\b(?:require(?:js)?\.config\s*\(\s*|(?:var|let|const)\s+require\s*=\s*|window\.require\s*=\s*)\{/g;
  for (const m of text.matchAll(starts)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const body = braced(text, open);
    if (body === null) continue;
    const base = /\bbaseUrl\s*:\s*(["'])(.*?)\1/.exec(body)?.[2];
    if (base !== undefined) baseUrl = base;
    const pathsAt = /\bpaths\s*:\s*\{/.exec(body);
    if (!pathsAt) continue;
    const inner = braced(body, pathsAt.index + pathsAt[0].length - 1);
    if (inner === null) continue;
    const entry = /(["']?)([\w$@./-]+)\1\s*:\s*(?:(["'])(.*?)\3|\[\s*(["'])(.*?)\5)/g;
    for (const e of inner.matchAll(entry)) {
      const target = e[4] ?? e[6];
      if (e[2] && target !== undefined) paths[e[2]] = target;
    }
  }
  return { baseUrl, paths };
}

/** Build a page's config from its scripts' text (`data-main` first, as RequireJS reads it). */
export function requireJsConfigFor(
  pagePath: string,
  page: { dataMain: string | null },
  scriptTexts: readonly string[],
): RequireJsConfig | null {
  const pageDir = dirOf(pagePath);
  let baseUrl: string | null = null;
  const paths: Record<string, string> = {};
  for (const js of scriptTexts) {
    const parsed = parseRequireJsConfig(js);
    if (parsed.baseUrl !== null) baseUrl = parsed.baseUrl;
    Object.assign(paths, parsed.paths);
  }
  const baseDir =
    baseUrl !== null
      ? /^[a-z][a-z0-9+.-]*:|^\/\//i.test(baseUrl)
        ? null
        : joinPath(pageDir, baseUrl.replace(/\/+$/, '') || '.')
      : page.dataMain
        ? dirOf(page.dataMain)
        : pageDir;
  if (baseDir === null) return null;
  return { pageDir, baseDir, paths };
}

/**
 * Resolve an AMD module id for an importer a RequireJS page governs: the page
 * whose folder, or whose base folder, is the nearest one containing it.
 * Loader plugins (`text!a.html`, `i18n!nls/strings`) resolve what follows the
 * `!`.
 */
export function resolveRequireJsImport(
  ctx: ResolveContext,
  src: string,
  raw: string,
): { dst: string; local: boolean } | null {
  const config = governing(ctx.requireJs, src);
  if (!config) return null;
  const bang = raw.lastIndexOf('!');
  const id = bang >= 0 ? raw.slice(bang + 1) : raw;
  if (!id || id.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(id)) return null;
  if (id.startsWith('.')) {
    const rel = joinPath(dirOf(src), id);
    const dst = rel !== null ? probeModule(rel, ctx.pathSet) : null;
    return dst ? { dst, local: false } : null;
  }
  let target = id;
  let longest = -1;
  for (const [alias, location] of Object.entries(config.paths)) {
    if ((id === alias || id.startsWith(`${alias}/`)) && alias.length > longest) {
      longest = alias.length;
      target = `${location}${id.slice(alias.length)}`;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) return null;
  const base = joinPath(config.baseDir, target);
  const dst = base !== null ? probeModule(base, ctx.pathSet) : null;
  if (dst) return { dst, local: false };
  // A nested loader context (Brackets loads each extension with its own
  // folder as the base) resolves ids from a folder between the importer and
  // the page's base. Tried only when the base finds nothing, nearest first.
  if (target !== id) return null;
  for (let dir = dirOf(src); dir !== config.baseDir && dir !== ''; dir = dirOf(dir)) {
    const near = joinPath(dir, id);
    const hit = near !== null ? probeModule(near, ctx.pathSet) : null;
    if (hit) return { dst: hit, local: true };
  }
  return null;
}

function governing(configs: readonly RequireJsConfig[], src: string): RequireJsConfig | null {
  let best: RequireJsConfig | null = null;
  let bestDepth = -1;
  for (const config of configs) {
    for (const dir of [config.pageDir, config.baseDir]) {
      const inside = dir === '' || src.startsWith(`${dir}/`);
      if (inside && dir.length > bestDepth) {
        best = config;
        bestDepth = dir.length;
      }
    }
  }
  return best;
}

/** The text between the brace at `open` and its match, or null when unbalanced. */
function braced(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Remove line and block comments, leaving strings (and URLs in them) intact. */
function stripComments(js: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < js.length; i++) {
    const c = js[i]!;
    const next = js[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = js.indexOf('\n', i);
      i = end < 0 ? js.length : end - 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = js.indexOf('*/', i + 2);
      i = end < 0 ? js.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}
