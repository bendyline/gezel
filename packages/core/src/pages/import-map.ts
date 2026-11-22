import type { PageLibraryLine } from '../schemas/page-library.js';
import { globalModulePath, writtenModuleRequests } from './globals.js';
import {
  type PageLibraryPins,
  pageLibraryFileUrl,
  pickPageLibraryLine,
  resolvePageLibraryUrl,
} from './resolver.js';

/**
 * The import map a page gets so its bare imports (`three`, `react-dom/client`)
 * load from the shelf. A page has exactly one: browsers that read only the
 * first map would otherwise ignore whichever came second, so a map the page
 * wrote itself is merged into this one rather than left beside it.
 */
export interface PageImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

function lineEntries(line: PageLibraryLine, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const requests: Record<string, string> = { ...line.module?.entries };
  for (const request of writtenModuleRequests(line)) {
    requests[request] = globalModulePath(request);
  }
  for (const name of line.packages) {
    for (const [request, path] of Object.entries(line.module ? requests : {})) {
      out[request === '.' ? name : name + request.slice(1)] = pageLibraryFileUrl(base, {
        line,
        path,
      });
    }
  }
  return out;
}

function packageNames(lines: readonly PageLibraryLine[]): string[] {
  return [...new Set(lines.flatMap((line) => (line.module ? line.packages : [])))].sort();
}

/**
 * `imports` answers the page with each library's default line. `scopes` makes
 * a line's own files resolve their imports against that same line and the
 * versions it requires: three's addons import `three`, and on a page that
 * loaded an older line by address they must get that line, not the default.
 */
export function buildPageImportMap(
  lines: readonly PageLibraryLine[],
  base: string,
  pins?: PageLibraryPins,
): PageImportMap {
  const imports: Record<string, string> = {};
  for (const name of packageNames(lines)) {
    const picked = pickPageLibraryLine(
      lines.filter((line) => line.packages.includes(name)),
      'module',
      undefined,
      pins,
    );
    if (!picked) continue;
    for (const [specifier, url] of Object.entries(lineEntries(picked.line, base))) {
      if (specifier === name || specifier.startsWith(`${name}/`)) imports[specifier] = url;
    }
  }
  const scopes: Record<string, Record<string, string>> = {};
  for (const line of lines) {
    if (!line.module) continue;
    const own = lineEntries(line, base);
    const required: Record<string, string> = {};
    for (const [name, version] of Object.entries(line.requires ?? {})) {
      const picked = pickPageLibraryLine(
        lines.filter((other) => other.packages.includes(name)),
        'module',
        version,
      );
      if (!picked) continue;
      for (const [specifier, url] of Object.entries(lineEntries(picked.line, base))) {
        if (specifier === name || specifier.startsWith(`${name}/`)) required[specifier] = url;
      }
    }
    const scope = { ...required, ...own };
    // A scope that says what `imports` already says adds nothing.
    if (Object.entries(scope).every(([specifier, url]) => imports[specifier] === url)) continue;
    scopes[`${base}${encodeURIComponent(line.library)}/${encodeURIComponent(line.version)}/`] =
      scope;
  }
  return { imports, scopes };
}

function isAbsoluteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value);
}

function rewriteAddresses(
  entries: unknown,
  lines: readonly PageLibraryLine[],
  base: string,
  notes: string[],
  pins?: PageLibraryPins,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!entries || typeof entries !== 'object') return out;
  for (const [specifier, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const file = isAbsoluteUrl(value) ? resolvePageLibraryUrl(lines, value, 'module', pins) : null;
    if (file?.note) notes.push(file.note);
    out[specifier] = file ? pageLibraryFileUrl(base, file) : value;
  }
  return out;
}

/**
 * The page's own import map with its CDN addresses turned into shelf
 * addresses, laid over the shelf's map. What the page wrote wins: a page that
 * maps `three` to a file of its own keeps it. A map that is not valid JSON is
 * dead to the browser already, so the shelf's map takes its place.
 */
export function mergeAuthoredImportMap(
  authored: string,
  ours: PageImportMap,
  lines: readonly PageLibraryLine[],
  base: string,
  pins?: PageLibraryPins,
): { map: PageImportMap; notes: string[] } {
  const notes: string[] = [];
  let parsed: { imports?: unknown; scopes?: unknown };
  try {
    const value: unknown = JSON.parse(authored);
    parsed = value && typeof value === 'object' ? (value as typeof parsed) : {};
  } catch {
    return { map: ours, notes: ["This page's import map is not valid JSON, so it was ignored."] };
  }
  const scopes: Record<string, Record<string, string>> = { ...ours.scopes };
  if (parsed.scopes && typeof parsed.scopes === 'object') {
    for (const [scope, entries] of Object.entries(parsed.scopes as Record<string, unknown>)) {
      scopes[scope] = {
        ...scopes[scope],
        ...rewriteAddresses(entries, lines, base, notes, pins),
      };
    }
  }
  return {
    map: {
      imports: { ...ours.imports, ...rewriteAddresses(parsed.imports, lines, base, notes, pins) },
      scopes,
    },
    notes,
  };
}

/** JSON that is safe inside a `<script>` element. */
export function importMapJson(map: PageImportMap): string {
  const body = Object.keys(map.scopes).length ? map : { imports: map.imports };
  return JSON.stringify(body).replace(/</g, '\\u003c');
}
