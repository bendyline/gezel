import type { PageLibraryLine } from '../schemas/page-library.js';
import type { ModuleImport } from './html-rewrite.js';
import { resolveLibraryRelative } from './resolver.js';

/** What a phone build carries of one line, by package path. */
export interface PhoneLibraryFiles {
  /** Loaded with `import`: the build precompiles them, so a phone never transpiles a library. */
  modules: string[];
  /** Used as written: plain-script builds, CommonJS files, stylesheets, the notice. */
  texts: string[];
}

/** A request's file in one form: an entry, or a file inside a folder entry. */
function requestFile(entries: Record<string, string>, request: string): string | null {
  const exact = entries[request];
  if (exact !== undefined) return exact.endsWith('/') ? null : exact;
  for (const [key, folder] of Object.entries(entries)) {
    if (key.endsWith('/') && request.startsWith(key) && request.length > key.length)
      return folder + request.slice(key.length);
  }
  return null;
}

/**
 * The files of a line a phone build carries (docs/page-libraries.md). A phone
 * cannot download libraries, so the app bundles them: only lines marked for
 * phones, only the requests they name (`phoneRequests`, else every file
 * request; a request may name one file inside a folder request, such as
 * `./addons/controls/OrbitControls.js`), and the files those import, never a
 * whole folder.
 */
export async function phoneLibraryFiles(
  line: PageLibraryLine,
  read: (path: string) => Promise<string | null>,
  scanImports: (code: string, path: string) => ModuleImport[],
): Promise<PhoneLibraryFiles> {
  if (!line.hosts.includes('phone')) return { modules: [], texts: [] };
  const requests = (entries: Record<string, string>) =>
    line.phoneRequests ?? Object.keys(entries).filter((request) => !request.endsWith('/'));
  const pick = (entries: Record<string, string> | undefined) =>
    entries
      ? requests(entries)
          .map((request) => requestFile(entries, request))
          .filter((path): path is string => path !== null)
      : [];
  const wanted = (request: string) => !line.phoneRequests || line.phoneRequests.includes(request);
  const globals = Object.entries(line.globals ?? {})
    .filter(([request]) => wanted(request))
    .map(([, spec]) => spec.file);
  // A CommonJS file is linked as published, so it travels as text.
  const commonjs = Object.entries(line.commonjs ?? {})
    .filter(([request]) => wanted(request))
    .map(([, spec]) => spec.file);
  const textRoots = [
    ...pick(line.classic?.entries),
    ...pick(line.style?.entries),
    ...globals,
    ...commonjs,
    ...(line.notice ? [line.notice] : []),
  ];
  const texts = new Set<string>();
  for (const path of textRoots) if ((await read(path)) !== null) texts.add(path);

  const modules = new Set<string>();
  const queue = pick(line.module?.entries);
  while (queue.length) {
    const path = queue.shift()!;
    if (modules.has(path)) continue;
    const code = await read(path);
    if (code === null) continue;
    modules.add(path);
    for (const found of scanImports(code, path)) {
      if (!/^\.\.?\//.test(found.specifier)) continue;
      const next = resolveLibraryRelative({ line, path }, found.specifier);
      if (next) queue.push(next.path);
    }
  }
  return { modules: [...modules].sort(), texts: [...texts].sort() };
}
