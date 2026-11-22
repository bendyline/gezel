import type { PageLibraryForm, PageLibraryLine } from '../schemas/page-library.js';
import { globalModulePath } from './globals.js';

/**
 * Which shelf file a page means by a library spelling: a bare import
 * (`three/addons/controls/OrbitControls.js`) or a CDN address
 * (`https://unpkg.com/three@0.160.0/build/three.module.js`). Every spelling
 * of one file must come out as the same line and path. The browser keys a
 * module by the URL it was asked for, so two answers for one file would run
 * the library twice on a page.
 */

/**
 * The line a project settled on for each library and form, recorded the first
 * time a page used it without naming a version. A project keeps its version
 * when the default moves, as long as the shelf still carries it.
 */
export type PageLibraryPins = Record<string, Partial<Record<PageLibraryForm, string>>>;

export interface PageLibraryFile {
  line: PageLibraryLine;
  /** Path inside the package. Ends in `/` when the spelling named a folder. */
  path: string;
  /** Set when the version asked for is not on the shelf and another answered. */
  note?: string;
}

type Triple = readonly [number, number, number];
interface VersionRange {
  from: Triple;
  before: Triple;
}

const UNBOUNDED: Triple = [
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER,
];

function compareTriples(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function parseTriple(text: string): Triple | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/**
 * The versions a spelling asks for, or null when it names none (`latest`,
 * `*`, nothing). `18` is all of 18; `^0.160.0` stays inside 0.160, as npm
 * reads a caret below 1.0. three's revisions are spelled `r128` on cdnjs.
 */
export function requestedVersionRange(version: string | undefined): VersionRange | null {
  let text = (version ?? '').trim().toLowerCase();
  if (!text || text === 'latest' || text === 'next' || text === '*' || text === 'x') return null;
  const revision = /^r(\d+)$/.exec(text);
  if (revision) text = `0.${revision[1]}`;
  const caret = text.startsWith('^');
  const tilde = text.startsWith('~');
  text = text.replace(/^(?:[\^~=v]|>=)+/, '');
  const match = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = match[2] && /^\d+$/.test(match[2]) ? Number(match[2]) : null;
  const patch = match[3] && /^\d+$/.test(match[3]) ? Number(match[3]) : null;
  const from: Triple = [major, minor ?? 0, patch ?? 0];
  if (minor === null) return { from, before: [major + 1, 0, 0] };
  if (caret && major > 0) return { from, before: [major + 1, 0, 0] };
  if (patch === null || tilde || caret) return { from, before: [major, minor + 1, 0] };
  return { from, before: [major, minor, patch + 1] };
}

function lineRange(line: PageLibraryLine): VersionRange {
  return {
    from: parseTriple(line.answers.from) ?? [0, 0, 0],
    before: (line.answers.before ? parseTriple(line.answers.before) : null) ?? UNBOUNDED,
  };
}

function newestFirst(a: PageLibraryLine, b: PageLibraryLine): number {
  return compareTriples(parseTriple(b.version) ?? [0, 0, 0], parseTriple(a.version) ?? [0, 0, 0]);
}

/**
 * The line that answers a request for one library in one form. A version the
 * shelf does not carry falls to the form's default line and says so: a page
 * that asked for three 0.150 runs on 0.185 with a line in the console, where
 * refusing it would leave nothing on the page at all.
 */
export function pickPageLibraryLine(
  candidates: readonly PageLibraryLine[],
  form: PageLibraryForm,
  version?: string,
  pins?: PageLibraryPins,
): { line: PageLibraryLine; note?: string } | null {
  const lines = candidates.filter((line) => line[form] !== undefined).sort(newestFirst);
  if (!lines.length) return null;
  const fallback = lines.find((line) => line[form]?.default) ?? lines[0]!;
  const asked = requestedVersionRange(version);
  if (!asked) {
    const pinned = pins?.[lines[0]!.library]?.[form];
    return { line: lines.find((line) => line.version === pinned) ?? fallback };
  }
  const match = lines.find((line) => {
    const range = lineRange(line);
    return (
      compareTriples(asked.from, range.before) < 0 && compareTriples(range.from, asked.before) < 0
    );
  });
  if (match) return { line: match };
  return {
    line: fallback,
    note: `${fallback.name} ${version} is not available here; this page runs on ${fallback.version}.`,
  };
}

function isIncluded(line: PageLibraryLine, path: string): boolean {
  return line.include.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : entry === path,
  );
}

/** The file a `./sub/path` request names in one form of a line, or null. */
function entryFile(line: PageLibraryLine, form: PageLibraryForm, request: string): string | null {
  const entries = line[form]?.entries;
  if (!entries) return null;
  // A module the shelf writes over a plain-script global (React 18).
  if (form === 'module' && (line.globals?.[request] || line.commonjs?.[request]))
    return globalModulePath(request);
  const exact = entries[request];
  if (exact !== undefined && !request.endsWith('/')) return exact;
  let best: string | null = null;
  for (const key of Object.keys(entries)) {
    if (!key.endsWith('/') || !request.startsWith(key)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? null : entries[best]! + request.slice(best.length);
}

function packageLines(lines: readonly PageLibraryLine[], name: string): PageLibraryLine[] {
  return lines.filter((line) => line.packages.includes(name));
}

/** `three/addons/x.js` is the package `three` asked for `./addons/x.js`. */
export function splitPackageSpecifier(specifier: string): { name: string; request: string } | null {
  if (!specifier || /^[./]/.test(specifier) || /^[a-z][a-z\d+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split('/');
  const scoped = parts[0]!.startsWith('@');
  if (scoped && parts.length < 2) return null;
  const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0]!;
  const rest = parts.slice(scoped ? 2 : 1).join('/');
  return { name, request: rest ? `./${rest}` : '.' };
}

/** The shelf file a bare import names, or null when the shelf does not carry it. */
export function resolvePageLibrarySpecifier(
  lines: readonly PageLibraryLine[],
  specifier: string,
  version?: string,
  pins?: PageLibraryPins,
): PageLibraryFile | null {
  const split = splitPackageSpecifier(specifier);
  if (!split) return null;
  const picked = pickPageLibraryLine(packageLines(lines, split.name), 'module', version, pins);
  if (!picked) return null;
  const path = entryFile(picked.line, 'module', split.request);
  return path === null ? null : { line: picked.line, path, note: picked.note };
}

/**
 * The shelf file a bare import inside a library file means: the line's own
 * package resolves within that line, anything else through its `requires`,
 * as the page's import map scopes it.
 */
export function resolveLibraryImport(
  lines: readonly PageLibraryLine[],
  from: PageLibraryLine,
  specifier: string,
): PageLibraryFile | null {
  const split = splitPackageSpecifier(specifier);
  if (!split) return null;
  if (from.packages.includes(split.name)) return resolvePageLibrarySpecifier([from], specifier);
  const picked = pickPageLibraryLine(
    packageLines(lines, split.name),
    'module',
    from.requires?.[split.name],
  );
  return picked ? resolvePageLibrarySpecifier([picked.line], specifier) : null;
}

/** The file a library file's own relative import names, in the same line. */
export function resolveLibraryRelative(
  file: Pick<PageLibraryFile, 'line' | 'path'>,
  specifier: string,
): PageLibraryFile | null {
  const parts = file.path.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length ? { line: file.line, path: parts.join('/') } : null;
}

/** Whether a bare import names a package some line on the shelf answers for. */
export function isPageLibrarySpecifier(
  lines: readonly PageLibraryLine[],
  specifier: string,
): boolean {
  const split = splitPackageSpecifier(specifier);
  return split !== null && packageLines(lines, split.name).some((line) => line.module);
}

export interface CdnRequest {
  /** npm name, for hosts that serve npm packages. */
  package?: string;
  /** cdnjs's own library name. */
  cdnjs?: string;
  version?: string;
  /** Path after the package; empty when the URL names the package alone. */
  path: string;
}

/** `[@scope/]name[@version]` followed by a path. */
function splitPackagePath(text: string): CdnRequest | null {
  const parts = text.split('/').filter((part, index, all) => part || index === all.length - 1);
  if (!parts[0]) return null;
  const scoped = parts[0].startsWith('@');
  if (scoped && !parts[1]) return null;
  const head = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
  const at = head.lastIndexOf('@');
  const name = at > 0 ? head.slice(0, at) : head;
  const version = at > 0 ? head.slice(at + 1) : undefined;
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return null;
  return {
    package: name.toLowerCase(),
    ...(version ? { version } : {}),
    path: parts.slice(scoped ? 2 : 1).join('/'),
  };
}

/**
 * Reads a CDN address the way that CDN does. Only the hosts models actually
 * write are known; anything else is not a library spelling and is left alone.
 */
export function parseCdnUrl(url: string): CdnRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith('//') ? `https:${url}` : url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  switch (host) {
    case 'unpkg.com':
    case 'esm.run':
    case 'cdn.skypack.dev': {
      // Skypack's pinned form: /-/three@v0.132.2-<hash>/dist=…/three.js
      const pinned = /^-\/((?:@[^/]+\/)?[^@/]+)@v?(\d[\w.]*?)-[A-Za-z0-9]{16,}\//.exec(path);
      if (pinned) return { package: pinned[1]!.toLowerCase(), version: pinned[2], path: '' };
      return splitPackagePath(path);
    }
    case 'cdn.jsdelivr.net': {
      if (!path.startsWith('npm/')) return null;
      const request = splitPackagePath(path.slice(4));
      // `+esm` asks jsDelivr for the package as one ES module.
      return request && request.path === '+esm' ? { ...request, path: '' } : request;
    }
    case 'esm.sh':
    case 'cdn.esm.sh':
      // A build number, `stable`, and `*` (externalize dependencies) may lead.
      return splitPackagePath(path.replace(/^(?:v\d+|stable)\//, '').replace(/^\*/, ''));
    case 'ga.jspm.io':
      return path.startsWith('npm:') ? splitPackagePath(path.slice(4)) : null;
    case 'cdnjs.cloudflare.com': {
      const match = /^ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
      return match ? { cdnjs: match[1]!.toLowerCase(), version: match[2], path: match[3]! } : null;
    }
    default:
      return null;
  }
}

const CDN_HOSTS =
  /(?:unpkg\.com|cdn\.jsdelivr\.net|esm\.sh|esm\.run|cdn\.skypack\.dev|ga\.jspm\.io|cdnjs\.cloudflare\.com)\//i;

/**
 * A cheap test for whether text could hold a library address at all, so a
 * file that names no CDN is served without being parsed.
 */
export function mentionsPageLibraryAddress(
  text: string,
  lines: readonly PageLibraryLine[],
): boolean {
  if (CDN_HOSTS.test(text)) return true;
  return lines.some((line) =>
    line.urls?.some((entry) => text.includes(entry.url.replace(/^https?:/i, ''))),
  );
}

function sameAddress(a: string, b: string): boolean {
  const strip = (text: string) =>
    text
      .replace(/^(?:https?:)?\/\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return strip(a) === strip(b);
}

/**
 * The shelf file a CDN address names, in the form the page loads it in, or
 * null when it is not a library the shelf carries.
 */
export function resolvePageLibraryUrl(
  lines: readonly PageLibraryLine[],
  url: string,
  form: PageLibraryForm,
  pins?: PageLibraryPins,
): PageLibraryFile | null {
  for (const line of lines) {
    const listed = line.urls?.find((entry) => entry.form === form && sameAddress(entry.url, url));
    if (listed) return { line, path: listed.path };
  }
  const request = parseCdnUrl(url);
  if (!request) return null;
  const candidates = request.cdnjs
    ? lines.filter((line) => line.cdnjs?.name.toLowerCase() === request.cdnjs)
    : packageLines(lines, request.package!);
  const picked = pickPageLibraryLine(candidates, form, request.version, pins);
  if (!picked) return null;
  const { line } = picked;
  let path = request.path;
  if (request.cdnjs) path = line.cdnjs?.files?.[path] ?? path;
  path = line.paths?.[path] ?? path;
  const named = path
    ? (entryFile(line, form, `./${path}`) ?? (isIncluded(line, path) ? path : null))
    : entryFile(line, form, '.');
  // A folder, as an import map's `three/addons/` value names one.
  const folder =
    named === null && path.endsWith('/') && line.include.some((entry) => entry.startsWith(path))
      ? path
      : named;
  return folder === null ? null : { line, path: folder, note: picked.note };
}

/** The one address a shelf file is served at under `base` (which ends in `/`). */
export function pageLibraryFileUrl(
  base: string,
  file: Pick<PageLibraryFile, 'line' | 'path'>,
): string {
  const path = file.path.split('/').map(encodeURIComponent).join('/');
  return `${base}${encodeURIComponent(file.line.library)}/${encodeURIComponent(file.line.version)}/${path}`;
}
