import { resolvePreviewImport } from '../preview/modules.js';
import type { PageLibraryForm, PageLibraryLine } from '../schemas/page-library.js';
import { type ModuleImport, locateScriptsAndLinks } from './html-rewrite.js';
import { isBabelStandaloneUrl, isInlineJsxScript } from './jsx.js';
import {
  type PageLibraryPins,
  isPageLibrarySpecifier,
  parseCdnUrl,
  pickPageLibraryLine,
  resolvePageLibrarySpecifier,
  resolvePageLibraryUrl,
  splitPackageSpecifier,
} from './resolver.js';

/**
 * Which libraries a page needs, read from its files before it runs: the
 * page's tags and import map, its inline modules, and every project module
 * they import. The answer decides what to download before a page check and
 * what `validate` reports as unavailable, so it reads a page the way the
 * preview serves it.
 */

export interface PageLibraryUse {
  line: PageLibraryLine;
  form: PageLibraryForm;
  /** The spelling as written. */
  spelling: string;
  /** The file it was written in, relative to the preview root. */
  from: string;
  /** Whether the spelling named a version; one that did not is what a project pin settles. */
  versioned: boolean;
  note?: string;
}

export interface PageLibraryUnknown {
  spelling: string;
  from: string;
  kind: 'package' | 'url';
}

export interface CollectedPageLibraries {
  uses: PageLibraryUse[];
  /** Library spellings nothing on the shelf or in the catalog answers. */
  unknown: PageLibraryUnknown[];
  /** Every line the page needs, its `requires` included, each once. */
  lines: PageLibraryLine[];
}

export interface CollectPageLibrariesOptions {
  /** The page, relative to the preview root, with `/` separators. */
  entry: string;
  /** A file's text, or null when it is missing or not readable. */
  read: (path: string) => Promise<string | null>;
  /** The lines that may answer: what is installed and what may be downloaded. */
  lines: readonly PageLibraryLine[];
  pins?: PageLibraryPins;
  /** The imports in module code, located in its source. */
  scanImports: (code: string, path: string) => ModuleImport[];
  /** Project modules read at most. */
  maxFiles?: number;
}

const MODULE_SOURCE = /\.(?:[cm]?[jt]sx?)$/i;

function isAbsoluteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

/**
 * The project file a page's `src` or import-map value names. A bare `main.ts`
 * is a file beside the page, and a root-absolute `/src/main.ts` (as Vite
 * writes it) means the page's own folder, as the preview reads both.
 */
function localPath(entry: string, reference: string): string | null {
  const clean = reference.split(/[?#]/, 1)[0]!;
  if (clean.startsWith('/')) {
    const folder = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
    return `${folder}${clean.replace(/^\/+/, '')}`;
  }
  const target = resolvePreviewImport(clean.startsWith('.') ? clean : `./${clean}`, entry);
  return target.kind === 'file' ? (target.candidates[0] ?? null) : null;
}

function lineKey(line: PageLibraryLine): string {
  return `${line.library}@${line.version}`;
}

export async function collectPageLibraries(
  opts: CollectPageLibrariesOptions,
): Promise<CollectedPageLibraries> {
  const uses: PageLibraryUse[] = [];
  const unknown: PageLibraryUnknown[] = [];
  const seenUnknown = new Set<string>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const maxFiles = opts.maxFiles ?? 64;
  /** Names the page's own import map sends to files of its own. */
  const authoredLocal = new Map<string, string>();
  /** Names the page's own import map answers at all. */
  const authoredNames = new Set<string>();

  const addUnknown = (spelling: string, from: string, kind: PageLibraryUnknown['kind']) => {
    const key = `${kind}:${spelling}`;
    if (seenUnknown.has(key)) return;
    seenUnknown.add(key);
    unknown.push({ spelling, from, kind });
  };

  const useUrl = (url: string, form: PageLibraryForm, from: string): void => {
    const file = resolvePageLibraryUrl(opts.lines, url.trim(), form, opts.pins);
    if (file) {
      const request = parseCdnUrl(url.trim());
      uses.push({
        line: file.line,
        form,
        spelling: url,
        from,
        // A whole address a line lists names one release, as a version would.
        versioned: request ? request.version !== undefined : true,
        ...(file.note ? { note: file.note } : {}),
      });
    } else if (parseCdnUrl(url.trim())) {
      addUnknown(url, from, 'url');
    }
  };

  const enqueue = (path: string | null): void => {
    if (!path || queued.has(path) || queued.size >= maxFiles) return;
    queued.add(path);
    queue.push(path);
  };

  const useImport = async (specifier: string, from: string): Promise<void> => {
    if (isAbsoluteUrl(specifier)) {
      useUrl(specifier, 'module', from);
      return;
    }
    const split = splitPackageSpecifier(specifier);
    if (!split) {
      const target = resolvePreviewImport(specifier, from);
      if (target.kind !== 'file') return;
      for (const candidate of target.candidates) {
        if (queued.has(candidate) || (await opts.read(candidate)) !== null) {
          enqueue(candidate);
          return;
        }
      }
      return;
    }
    const mapped = authoredLocal.get(specifier) ?? authoredLocal.get(split.name);
    if (mapped) {
      enqueue(mapped);
      return;
    }
    if (authoredNames.has(specifier) || authoredNames.has(split.name)) return;
    const file = resolvePageLibrarySpecifier(opts.lines, specifier, undefined, opts.pins);
    if (file) {
      uses.push({ line: file.line, form: 'module', spelling: specifier, from, versioned: false });
    } else if (!isPageLibrarySpecifier(opts.lines, specifier)) {
      addUnknown(split.name, from, 'package');
    } else {
      addUnknown(specifier, from, 'package');
    }
  };

  const html = await opts.read(opts.entry);
  if (html !== null) {
    for (const part of locateScriptsAndLinks(html)) {
      const attribute = (name: string) =>
        part.attributes.find((entry) => entry.name === name)?.value;
      const type = attribute('type')?.trim().toLowerCase() ?? '';
      if (part.tag === 'link') {
        const href = attribute('href');
        const rel = (attribute('rel') ?? '').toLowerCase().split(/\s+/);
        if (!href) continue;
        if (rel.includes('stylesheet') && isAbsoluteUrl(href)) useUrl(href, 'style', opts.entry);
        else if (rel.includes('modulepreload')) {
          if (isAbsoluteUrl(href)) useUrl(href, 'module', opts.entry);
        }
        continue;
      }
      const src = attribute('src');
      // Babel's in-browser compiler: the page's JSX is compiled where it is served instead.
      if (src && isBabelStandaloneUrl(src)) continue;
      if (src) {
        const module = type === 'module';
        if (isAbsoluteUrl(src)) {
          if (module || !type || /javascript|ecmascript/.test(type))
            useUrl(src, module ? 'module' : 'classic', opts.entry);
        } else if (module || MODULE_SOURCE.test(src.split(/[?#]/, 1)[0]!)) {
          enqueue(localPath(opts.entry, src));
        }
        continue;
      }
      if (part.bodyStart === undefined || part.bodyEnd === undefined) continue;
      const body = html.slice(part.bodyStart, part.bodyEnd);
      if (type === 'importmap') {
        let parsed: { imports?: unknown } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          continue;
        }
        if (!parsed.imports || typeof parsed.imports !== 'object') continue;
        for (const [name, value] of Object.entries(parsed.imports as Record<string, unknown>)) {
          if (typeof value !== 'string') continue;
          authoredNames.add(name.replace(/\/$/, ''));
          if (isAbsoluteUrl(value)) useUrl(value, 'module', opts.entry);
          else if (!name.endsWith('/')) {
            const local = localPath(opts.entry, value);
            if (local) authoredLocal.set(name, local);
          }
        }
      } else if (type === 'module' || isInlineJsxScript(part)) {
        for (const found of opts.scanImports(body, opts.entry)) {
          await useImport(found.specifier, opts.entry);
        }
      }
    }
  }

  while (queue.length) {
    const path = queue.shift()!;
    if (!MODULE_SOURCE.test(path)) continue;
    const source = await opts.read(path);
    if (source === null) continue;
    for (const found of opts.scanImports(source, path)) await useImport(found.specifier, path);
  }

  // A line's own files import the lines it requires.
  const needed = new Map<string, PageLibraryLine>();
  const pending = uses.map((use) => use.line);
  while (pending.length) {
    const line = pending.shift()!;
    if (needed.has(lineKey(line))) continue;
    needed.set(lineKey(line), line);
    for (const [name, version] of Object.entries(line.requires ?? {})) {
      const picked = pickPageLibraryLine(
        opts.lines.filter((other) => other.packages.includes(name)),
        'module',
        version,
      );
      if (picked) pending.push(picked.line);
    }
  }
  return { uses, unknown, lines: [...needed.values()] };
}

/** Pins to record for uses that named no version and have none yet. */
export function pinsForUses(
  uses: readonly PageLibraryUse[],
  existing: PageLibraryPins = {},
): PageLibraryPins | null {
  let changed = false;
  const next: PageLibraryPins = structuredClone(existing);
  for (const use of uses) {
    if (use.versioned) continue;
    const current = next[use.line.library] ?? {};
    if (current[use.form]) continue;
    next[use.line.library] = { ...current, [use.form]: use.line.version };
    changed = true;
  }
  return changed ? next : null;
}
