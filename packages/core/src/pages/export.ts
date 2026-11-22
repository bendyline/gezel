import {
  type PreviewModule,
  bundlePreviewModules,
  isPreviewCompiledPath,
  previewImportSpecifier,
  resolvePreviewImport,
} from '../preview/modules.js';
import type { PageLibraryLine } from '../schemas/page-library.js';
import {
  commonJsModuleSource,
  commonJsModuleSpec,
  globalModuleCommonJs,
  globalModuleSource,
  globalModuleSpec,
} from './globals.js';
import {
  type HtmlElementPart,
  type ModuleImport,
  locateScriptsAndLinks,
  rewritePageLibraries,
} from './html-rewrite.js';
import { type PageImportMap, buildPageImportMap, mergeAuthoredImportMap } from './import-map.js';
import { compileInlineJsx } from './jsx.js';
import {
  type PageLibraryFile,
  type PageLibraryPins,
  resolveLibraryImport,
  resolveLibraryRelative,
  resolvePageLibrarySpecifier,
  resolvePageLibraryUrl,
} from './resolver.js';

/**
 * A page with its libraries, taken out of Gezel (docs/page-libraries.md):
 *
 * - **folder**: the page's folder as a static host would serve it, its
 *   TypeScript compiled to JavaScript, the library files it reaches under
 *   `lib/`, an import map pointing at them, and `LICENSES.txt`. Browsers
 *   refuse ES modules from `file://`, so a folder needs a web server.
 * - **single**: one HTML file that opens by double-click: every module
 *   linked into one plain script, stylesheets, scripts and assets inlined.
 *   A file a script loads by a name it builds while running is not found.
 *
 * Both read a bare import the way the browser will: through the page's own
 * import map merged into the shelf's, so a copy runs what the preview ran.
 * Pure: the host hands in the files, the compiler and the library bytes.
 */

export interface PageExportCompiled {
  code: string;
  imports: ModuleImport[];
  errors: string[];
}

export interface PageExportSource {
  /** The page, relative to the project root, with `/` separators. */
  entry: string;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  /** Every file under a folder, relative to the project root, filtered and capped by the host. */
  listFiles(folder: string): Promise<string[]>;
  /** Installed lines only: an export needs their bytes. */
  lines: readonly PageLibraryLine[];
  pins?: PageLibraryPins;
  readLibrary(line: PageLibraryLine, path: string): Promise<Uint8Array | null>;
  compile(source: string, path: string, format: 'esm' | 'commonjs'): PageExportCompiled;
  /** The imports in a file served as written. */
  scanImports(code: string, path: string): ModuleImport[];
  /** The text of a line's license notice, for `LICENSES.txt`. */
  readNotice?(line: PageLibraryLine): Promise<string | null>;
}

export interface PageExportFile {
  /** Relative to the export's root. */
  path: string;
  data: Uint8Array | string;
}

export interface PageExportResult {
  files: PageExportFile[];
  /** What a person should know about the copy: a library left out, a file not embedded. */
  notes: string[];
}

const DECODER = new TextDecoder();
const MAX_SINGLE_FILE_CHARS = 64 * 1024 * 1024;
/** The folder an export keeps its libraries in, from the page's folder. */
const LIB = 'lib/';

function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
}

function isAbsoluteUrl(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value.trim());
}

/** The path a file at `from` names `to` by; both relative to one root. */
export function relativeTo(from: string, to: string): string {
  const fromParts = folderOf(from).split('/').filter(Boolean);
  const toParts = to.split('/');
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length - 1 &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }
  const up = fromParts.length - shared;
  const rest = toParts.slice(shared).join('/');
  return up ? `${'../'.repeat(up)}${rest}` : `./${rest}`;
}

function libPath(file: Pick<PageLibraryFile, 'line' | 'path'>): string {
  return `${LIB}${file.line.library}/${file.line.version}/${file.path}`;
}

function lineKey(line: PageLibraryLine): string {
  return `${line.library}@${line.version}`;
}

/** A compiled file's name in an export: `main.ts` is served as `main.js`. */
function exportedName(path: string): string {
  return isPreviewCompiledPath(path) ? path.replace(/\.(?:[cm]?tsx?|jsx)$/i, '.js') : path;
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  json: 'application/json',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

function dataUrl(path: string, bytes: Uint8Array): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${MIME[ext] ?? 'application/octet-stream'};base64,${btoa(binary)}`;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function attribute(part: HtmlElementPart, name: string) {
  return part.attributes.find((entry) => entry.name === name);
}

function scriptType(part: HtmlElementPart): string {
  return attribute(part, 'type')?.value.trim().toLowerCase() ?? '';
}

/** A script the preview runs as a module: declared so, or a source it compiles. */
function isModuleScript(part: HtmlElementPart): boolean {
  const src = attribute(part, 'src')?.value;
  return (
    scriptType(part) === 'module' || Boolean(src && isPreviewCompiledPath(src.split(/[?#]/, 1)[0]!))
  );
}

/**
 * The project file a page's `src`, `href` or import names. A bare `main.ts`
 * is a file beside the page, and a root-absolute `/src/main.ts` means the
 * page's own folder, as the preview reads both.
 */
function pageFile(entry: string, reference: string): string | null {
  const clean = reference.split(/[?#]/, 1)[0]!;
  if (!clean || isAbsoluteUrl(clean)) return null;
  if (clean.startsWith('/')) return `${folderOf(entry)}${clean.replace(/^\/+/, '')}`;
  const target = resolvePreviewImport(clean.startsWith('.') ? clean : `./${clean}`, entry);
  return target.kind === 'file' ? (target.candidates[0] ?? null) : null;
}

async function firstExisting(
  source: PageExportSource,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await source.readText(candidate)) !== null) return candidate;
  }
  return null;
}

/** The page's import map as the export serves it: its own, merged into the shelf's. */
function pageImportMap(
  source: PageExportSource,
  parts: readonly HtmlElementPart[],
  html: string,
  base: string,
): { map: PageImportMap; authored: boolean } {
  const ours = buildPageImportMap(source.lines, base, source.pins);
  const own = parts.find((part) => part.tag === 'script' && scriptType(part) === 'importmap');
  if (own?.bodyStart === undefined) return { map: ours, authored: false };
  const merged = mergeAuthoredImportMap(
    html.slice(own.bodyStart, own.bodyEnd),
    ours,
    source.lines,
    base,
    source.pins,
  );
  return { map: merged.map, authored: true };
}

type MappedImport =
  | { kind: 'library'; file: PageLibraryFile }
  | { kind: 'file'; path: string }
  | null;

/**
 * What a bare import means under an import map: its exact key, else the
 * longest key ending in `/` that prefixes it, as the browser reads one.
 */
function resolveMapped(
  source: PageExportSource,
  map: PageImportMap,
  base: string,
  specifier: string,
): MappedImport {
  let target = map.imports[specifier];
  if (target === undefined) {
    let best: string | undefined;
    for (const key of Object.keys(map.imports)) {
      if (key.endsWith('/') && specifier.startsWith(key) && (!best || key.length > best.length))
        best = key;
    }
    if (best) target = map.imports[best] + specifier.slice(best.length);
  }
  if (target === undefined) return null;
  if (target.startsWith(base)) {
    const [library, version, ...rest] = target
      .slice(base.length)
      .split('/')
      .map(decodeURIComponent);
    const line = source.lines.find(
      (entry) => entry.library === library && entry.version === version,
    );
    return line && rest.length ? { kind: 'library', file: { line, path: rest.join('/') } } : null;
  }
  if (isAbsoluteUrl(target)) return null;
  const path = pageFile(source.entry, target);
  return path ? { kind: 'file', path } : null;
}

/** A library file's bytes, or the module the shelf writes there (over a global, or around CommonJS). */
async function libraryBytes(
  source: PageExportSource,
  file: PageLibraryFile,
): Promise<Uint8Array | null> {
  const written = globalModuleSource(file.line, file.path);
  if (written !== null) return new TextEncoder().encode(written);
  const commonjs = commonJsModuleSpec(file.line, file.path);
  if (commonjs) {
    const code = await source.readLibrary(file.line, commonjs.spec.file);
    const wrapped = code && commonJsModuleSource(file.line, file.path, DECODER.decode(code));
    return wrapped ? new TextEncoder().encode(wrapped) : null;
  }
  return source.readLibrary(file.line, file.path);
}

/** The page's HTML with its JSX scripts compiled, as the preview serves it. */
async function pageHtml(source: PageExportSource): Promise<string> {
  return compileInlineJsx((await source.readText(source.entry)) ?? '', (code, path) =>
    source.compile(code, path, 'esm'),
  );
}

async function licenses(
  source: PageExportSource,
  lines: Iterable<PageLibraryLine>,
): Promise<string> {
  const parts = ['Libraries in this copy of the page, and their licenses.', ''];
  for (const line of lines) {
    parts.push(`${line.name} ${line.version} (${line.source.package}): ${line.license}`);
    const notice = (await source.readNotice?.(line)) ?? null;
    if (notice) parts.push('', notice.trim());
    parts.push('', '---', '');
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

/** The page's folder as a static host would serve it, with its libraries beside it. */
export async function exportPageFolder(source: PageExportSource): Promise<PageExportResult> {
  const folder = folderOf(source.entry);
  const notes: string[] = [];
  const files: PageExportFile[] = [];
  const roots: PageLibraryFile[] = [];
  const inside = (path: string) => path.slice(folder.length);
  const html = await pageHtml(source);
  const parts = locateScriptsAndLinks(html);
  // The import map lives in the page, so its addresses are relative to it.
  const base = `./${LIB}`;
  const { map } = pageImportMap(source, parts, html, base);

  /** A module's imports: library roots collected, its own imports pointed at what the copy holds. */
  const exportModule = async (
    code: string,
    imports: readonly ModuleImport[],
    from: string,
    compiled: boolean,
  ): Promise<string> => {
    const edits: Edit[] = [];
    for (const found of imports) {
      const target = resolvePreviewImport(found.specifier, from);
      if (target.kind === 'file') {
        if (!compiled) continue;
        const file = await firstExisting(source, target.candidates);
        if (file) {
          const text = previewImportSpecifier(from, exportedName(file));
          edits.push({ start: found.start, end: found.end, text });
        }
      } else if (target.kind === 'package') {
        const mapped = resolveMapped(source, map, base, found.specifier);
        if (mapped?.kind === 'library') roots.push(mapped.file);
      } else if (target.kind === 'url') {
        const file = resolvePageLibraryUrl(source.lines, found.specifier, 'module', source.pins);
        if (file) {
          roots.push(file);
          // Relative to the module, which is where the browser resolves it from.
          const text = relativeTo(
            `${folder}${exportedName(inside(from))}`,
            `${folder}${libPath(file)}`,
          );
          edits.push({ start: found.start, end: found.end, text });
        }
      }
    }
    return applyEdits(code, edits);
  };

  for (const path of await source.listFiles(folder)) {
    if (!path.startsWith(folder) || path === source.entry) continue;
    if (isPreviewCompiledPath(path) || /\.m?js$/i.test(path)) {
      const text = await source.readText(path);
      if (text === null) continue;
      const compiled = isPreviewCompiledPath(path);
      const result = compiled
        ? source.compile(text, path, 'esm')
        : { code: text, imports: source.scanImports(text, path), errors: [] };
      if (result.errors.length) {
        notes.push(`${path} did not compile: ${result.errors[0]}`);
        continue;
      }
      const code = await exportModule(result.code, result.imports, path, compiled);
      files.push({ path: exportedName(inside(path)), data: code });
      continue;
    }
    const bytes = await source.readBytes(path);
    if (bytes) files.push({ path: inside(path), data: bytes });
  }

  // The page: what it loads by address and in inline modules is found first,
  // then its tags are pointed at the copy.
  for (const part of parts) {
    const address = attribute(part, part.tag === 'script' ? 'src' : 'href');
    if (address && isAbsoluteUrl(address.value)) {
      const form = part.tag === 'link' ? 'style' : isModuleScript(part) ? 'module' : 'classic';
      const file = resolvePageLibraryUrl(source.lines, address.value.trim(), form, source.pins);
      if (file) roots.push(file);
    } else if (
      part.tag === 'script' &&
      isModuleScript(part) &&
      part.bodyStart !== undefined &&
      !address
    ) {
      await exportModule(
        '',
        source.scanImports(html.slice(part.bodyStart, part.bodyEnd), source.entry),
        source.entry,
        false,
      );
    }
  }
  const rewritten = rewritePageLibraries(
    html,
    {
      lines: source.lines,
      base,
      ...(source.pins ? { pins: source.pins } : {}),
      scanImports: (code) => source.scanImports(code, source.entry),
    },
    parts,
  );
  notes.push(...rewritten.notes);
  // A compiled source is served under its `.js` name, and only runs as a module.
  const tagEdits: Edit[] = [];
  for (const part of locateScriptsAndLinks(rewritten.html)) {
    const src = attribute(part, 'src');
    if (part.tag !== 'script' || !src || !isPreviewCompiledPath(src.value.split(/[?#]/, 1)[0]!))
      continue;
    const file = pageFile(source.entry, src.value);
    if (file) {
      tagEdits.push({ start: src.valueStart, end: src.valueEnd, text: exportedName(inside(file)) });
    }
    if (scriptType(part) !== 'module') {
      const at = src.start;
      const type = attribute(part, 'type');
      if (type) tagEdits.push({ start: type.start, end: type.end, text: 'type="module"' });
      else tagEdits.push({ start: at, end: at, text: 'type="module" ' });
    }
  }
  let page = applyEdits(rewritten.html, tagEdits);
  if (rewritten.importMap) {
    const head = /<head[^>]*>/i.exec(page);
    const at = head ? head.index + head[0].length : 0;
    page = `${page.slice(0, at)}${rewritten.importMap}${page.slice(at)}`;
  }
  files.push({ path: inside(source.entry), data: page });

  // Library files the page reaches, and what those reach.
  const reached = new Map<string, PageLibraryFile>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift()!;
    if (file.path.endsWith('/') || reached.has(libPath(file))) continue;
    reached.set(libPath(file), file);
    if (!/\.m?js$/i.test(file.path)) continue;
    const bytes = await libraryBytes(source, file);
    if (!bytes) continue;
    for (const found of source.scanImports(DECODER.decode(bytes), file.path)) {
      const next = /^\.\.?\//.test(found.specifier)
        ? resolveLibraryRelative(file, found.specifier)
        : resolveLibraryImport(source.lines, file.line, found.specifier);
      if (next) queue.push(next);
    }
  }
  const used = new Map<string, PageLibraryLine>();
  for (const [path, file] of reached) {
    const bytes = await libraryBytes(source, file);
    if (!bytes) {
      notes.push(`${file.line.name} ${file.line.version}: ${file.path} is not on this computer.`);
      continue;
    }
    files.push({ path, data: bytes });
    used.set(lineKey(file.line), file.line);
  }
  if (used.size) files.push({ path: 'LICENSES.txt', data: await licenses(source, used.values()) });
  return { files, notes: [...new Set(notes)] };
}

/** One HTML file holding the page, its modules, its libraries and its assets. */
export async function exportPageSingleFile(source: PageExportSource): Promise<PageExportResult> {
  const notes: string[] = [];
  const html = await pageHtml(source);
  const parts = locateScriptsAndLinks(html);
  const base = LIB;
  /** Plain-script builds a written module hands on, to run before the linked modules. */
  const preludes = new Map<string, PageLibraryFile>();
  const { map } = pageImportMap(source, parts, html, base);
  const edits: Edit[] = [];
  const modules = new Map<string, PreviewModule>();
  const entries: string[] = [];
  const used = new Map<string, PageLibraryLine>();
  let inline = 0;

  const libraryText = async (file: PageLibraryFile): Promise<string | null> => {
    const bytes = await source.readLibrary(file.line, file.path);
    if (!bytes) return null;
    used.set(lineKey(file.line), file.line);
    return DECODER.decode(bytes);
  };

  /** A written module's build, and the builds it needs first, in the order they must run. */
  const addPrelude = (file: PageLibraryFile): void => {
    const found = globalModuleSpec(file.line, file.path);
    if (!found) return;
    for (const name of found.spec.after ?? []) {
      const before = resolveLibraryImport(source.lines, file.line, name);
      if (before) addPrelude(before);
    }
    const build: PageLibraryFile = { line: file.line, path: found.spec.file };
    if (!preludes.has(libPath(build))) preludes.set(libPath(build), build);
  };

  const linkLibrary = async (file: PageLibraryFile): Promise<string | null> => {
    const key = libPath(file);
    if (modules.has(key)) return key;
    const adapter = globalModuleCommonJs(file.line, file.path);
    if (adapter !== null) {
      addPrelude(file);
      used.set(lineKey(file.line), file.line);
      modules.set(key, { path: key, code: adapter, requires: {} });
      return key;
    }
    // A CommonJS file is already what the linker runs: link it as published.
    const commonjs = commonJsModuleSpec(file.line, file.path);
    if (commonjs) {
      const code = await libraryText({ line: file.line, path: commonjs.spec.file });
      if (code === null) return null;
      const requires: Record<string, string> = {};
      modules.set(key, { path: key, code, requires });
      for (const name of commonjs.spec.imports) {
        const next = resolveLibraryImport(source.lines, file.line, name);
        const target = next ? await linkLibrary(next) : null;
        if (!target) throw new Error(`${file.line.name} needs ${name}, which is not on the shelf`);
        requires[name] = target;
      }
      return key;
    }
    const text = await libraryText(file);
    if (text === null) return null;
    await link(key, text, file);
    return key;
  };

  const linkFile = async (path: string): Promise<string | null> => {
    if (modules.has(path)) return path;
    const text = await source.readText(path);
    if (text === null) return null;
    await link(path, text);
    return path;
  };

  /** Compile one module for the linker and link what it imports. */
  async function link(path: string, text: string, library?: PageLibraryFile): Promise<void> {
    const compiled = source.compile(text, library ? 'library.js' : path, 'commonjs');
    if (compiled.errors.length) throw new Error(`${path}: ${compiled.errors[0]}`);
    const requires: Record<string, string> = {};
    modules.set(path, { path, code: compiled.code, requires });
    for (const { specifier } of compiled.imports) {
      let target: string | null = null;
      if (library) {
        const next = /^\.\.?\//.test(specifier)
          ? resolveLibraryRelative(library, specifier)
          : resolveLibraryImport(source.lines, library.line, specifier);
        if (next) target = await linkLibrary(next);
      } else {
        const named = resolvePreviewImport(specifier, path);
        if (named.kind === 'file') {
          const file = await firstExisting(source, named.candidates);
          if (file) target = await linkFile(file);
        } else if (named.kind === 'package') {
          const mapped = resolveMapped(source, map, base, specifier);
          if (mapped?.kind === 'library') target = await linkLibrary(mapped.file);
          else if (mapped?.kind === 'file') target = await linkFile(mapped.path);
        } else if (named.kind === 'url') {
          const file = resolvePageLibraryUrl(source.lines, specifier, 'module', source.pins);
          if (file) target = await linkLibrary(file);
        }
      }
      if (target) requires[specifier] = target;
      else notes.push(`${path} imports ${specifier}, which this copy does not hold.`);
    }
  }

  const asset = async (reference: string, from: string): Promise<string | null> => {
    const path = pageFile(from, reference);
    const bytes = path ? await source.readBytes(path) : null;
    return bytes && path ? dataUrl(path, bytes) : null;
  };

  const inlineCss = async (css: string, from: string): Promise<string> => {
    const edits: Edit[] = [];
    for (const match of css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
      const url = await asset(match[2]!, from);
      if (url)
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          text: `url("${url}")`,
        });
    }
    return applyEdits(css, edits);
  };

  for (const part of parts) {
    if (part.tag === 'link') {
      const href = attribute(part, 'href');
      const rel = (attribute(part, 'rel')?.value ?? '').toLowerCase().split(/\s+/);
      if (!href) continue;
      if (rel.includes('stylesheet')) {
        let css: string | null = null;
        if (isAbsoluteUrl(href.value)) {
          const file = resolvePageLibraryUrl(source.lines, href.value.trim(), 'style', source.pins);
          css = file ? await libraryText(file) : null;
          if (css === null)
            notes.push(`${href.value} is not in this copy; it loads from the internet.`);
        } else {
          const local = pageFile(source.entry, href.value);
          css = local ? await source.readText(local) : null;
          if (css !== null && local) css = await inlineCss(css, local);
        }
        if (css !== null) {
          const style = `<style>${css.replace(/<\/(style)/gi, '<\\/$1')}</style>`;
          edits.push({ start: part.start, end: part.end, text: style });
        }
      } else if (rel.includes('icon')) {
        const url = await asset(href.value, source.entry);
        if (url) edits.push({ start: href.valueStart, end: href.valueEnd, text: url });
      } else if (rel.includes('modulepreload') || rel.includes('preload')) {
        edits.push({ start: part.start, end: part.end, text: '' });
      }
      continue;
    }
    const src = attribute(part, 'src');
    if (scriptType(part) === 'importmap') {
      edits.push({ start: part.start, end: part.end, text: '' });
      continue;
    }
    if (isModuleScript(part)) {
      if (src && isAbsoluteUrl(src.value)) {
        const file = resolvePageLibraryUrl(source.lines, src.value.trim(), 'module', source.pins);
        const key = file ? await linkLibrary(file) : null;
        if (key) entries.push(key);
        else notes.push(`${src.value} is not in this copy; it loads from the internet.`);
      } else if (src) {
        const named = pageFile(source.entry, src.value);
        const file = named ? await firstExisting(source, [named]) : null;
        const key = file ? await linkFile(file) : null;
        if (key) entries.push(key);
        else notes.push(`${src.value} is not in this copy.`);
      } else if (part.bodyStart !== undefined) {
        inline += 1;
        const path = `${folderOf(source.entry)}inline-module-${inline}.js`;
        await link(path, html.slice(part.bodyStart, part.bodyEnd));
        entries.push(path);
      }
      edits.push({ start: part.start, end: part.end, text: '' });
      continue;
    }
    if (!src || part.bodyStart === undefined) continue;
    let code: string | null = null;
    if (isAbsoluteUrl(src.value)) {
      const file = resolvePageLibraryUrl(source.lines, src.value.trim(), 'classic', source.pins);
      code = file ? await libraryText(file) : null;
      if (code === null)
        notes.push(`${src.value} is not in this copy; it loads from the internet.`);
    } else {
      const local = pageFile(source.entry, src.value);
      code = local ? await source.readText(local) : null;
    }
    if (code !== null) {
      edits.push({
        start: part.start,
        end: part.end,
        text: `<script>${escapeInlineScript(code)}</script>`,
      });
    }
  }

  // Assets the markup names, outside the tags handled above.
  const handled = (index: number) => parts.some((part) => index >= part.start && index < part.end);
  for (const match of html.matchAll(/\s(src|poster|href)\s*=\s*(["'])([^"']+)\2/gi)) {
    if (handled(match.index)) continue;
    const tagStart = html.lastIndexOf('<', match.index);
    const tag = /^<([a-z][a-z0-9-]*)/i
      .exec(html.slice(tagStart, tagStart + 24))?.[1]
      ?.toLowerCase();
    if (!tag || tag === 'a' || tag === 'base' || tag === 'form' || tag === 'iframe') continue;
    const url = await asset(match[3]!, source.entry);
    if (!url) continue;
    const valueStart = match.index + match[0].indexOf(match[2]!) + 1;
    edits.push({ start: valueStart, end: valueStart + match[3]!.length, text: url });
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = match[1]!;
    const inlined = await inlineCss(css, source.entry);
    if (inlined !== css) {
      const bodyStart = match.index + match[0].indexOf(css);
      edits.push({ start: bodyStart, end: bodyStart + css.length, text: inlined });
    }
  }

  let page = applyEdits(html, edits);
  if (entries.length) {
    const linked = bundlePreviewModules([...modules.values()], entries);
    let builds = '';
    for (const build of preludes.values()) {
      const text = await libraryText(build);
      if (text === null)
        notes.push(`${build.line.name} ${build.line.version} is not on this computer.`);
      else builds += `<script>${escapeInlineScript(text)}</script>`;
    }
    const script = `${builds}<script>${escapeInlineScript(linked)}</script>`;
    // Module scripts run after the document is parsed, so the linked script
    // goes last: run where the first module tag sat, in <head>, it found no
    // page to render into (React's "target container is not a DOM element").
    const bodyEnd = page.search(/<\/body>/i);
    const insertAt = bodyEnd >= 0 ? bodyEnd : page.length;
    page = `${page.slice(0, insertAt)}${script}${page.slice(insertAt)}`;
  }
  if (used.size) {
    const credits = (await licenses(source, used.values())).replace(/--/g, '- -');
    const open = /<html\b[^>]*>/i.exec(page);
    const at = open ? open.index + open[0].length : 0;
    page = `${page.slice(0, at)}\n<!--\n${credits}-->\n${page.slice(at)}`;
  }
  if (page.length > MAX_SINGLE_FILE_CHARS) {
    throw new Error('This page and its files are too large for one file; export it as a folder.');
  }
  return {
    files: [{ path: source.entry.slice(folderOf(source.entry).length), data: page }],
    notes: [...new Set(notes)],
  };
}
