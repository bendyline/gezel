/**
 * Modules in workspace previews, shared by the desktop's preview server and
 * the phones' offline snapshots so both read an import the same way. A model
 * writes TypeScript the way its build tools would accept it: `./tank` and
 * `./tank.js` both name `tank.ts`, and `./tanks` names `tanks/index.ts`.
 * Neither host has those tools, so the preview resolves the import itself.
 */

/** Source a browser cannot run until it is compiled. Declaration files are types only. */
export function isPreviewCompiledPath(path: string): boolean {
  return /\.(?:[cm]?tsx?|jsx)$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path);
}

/** A file an import links as code, compiled or not. */
export function isPreviewModulePath(path: string): boolean {
  return isPreviewCompiledPath(path) || /\.[cm]?js$/i.test(path);
}

export type PreviewImport =
  /** Files to try, in order; the first that exists is the one imported. */
  | { kind: 'file'; candidates: string[] }
  /** An npm package. A preview has no package manager to install it from. */
  | { kind: 'package'; name: string }
  | { kind: 'url' }
  /** Climbs above the preview's root. */
  | { kind: 'outside' };

const MODULE_EXTENSIONS = ['ts', 'tsx', 'js', 'mjs', 'jsx'];

/**
 * How `specifier`, imported by the module at `from`, names a file. Paths are
 * relative to the preview root, with `/` separators and no leading slash.
 */
export function resolvePreviewImport(specifier: string, from: string): PreviewImport {
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier) || specifier.startsWith('//')) return { kind: 'url' };
  const rooted = specifier.startsWith('/');
  if (!rooted && specifier !== '.' && specifier !== '..' && !/^\.\.?\//.test(specifier)) {
    const [scope, name] = specifier.split('/');
    return { kind: 'package', name: scope?.startsWith('@') && name ? `${scope}/${name}` : scope! };
  }
  const parts = rooted ? [] : from.split('/').slice(0, -1);
  const segments = specifier.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return { kind: 'outside' };
      parts.pop();
    } else parts.push(segment);
  }
  const path = parts.join('/');
  const last = segments.at(-1);
  // `./tanks/`, `.` and `..` name a folder, so only its index can be meant.
  if (!path || !last || last === '.' || last === '..')
    return { kind: 'file', candidates: indexCandidates(path) };
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  const stem = extension ? path.slice(0, -(extension.length + 1)) : path;
  // TypeScript's own convention: import the file by the name it compiles to.
  if (extension === 'js') return { kind: 'file', candidates: [path, `${stem}.ts`, `${stem}.tsx`] };
  if (extension === 'mjs') return { kind: 'file', candidates: [path, `${stem}.mts`] };
  if (extension === 'cjs') return { kind: 'file', candidates: [path, `${stem}.cts`] };
  if (extension === 'jsx') return { kind: 'file', candidates: [path, `${stem}.tsx`] };
  if (extension && /^(?:[cm]?tsx?|json|css)$/.test(extension))
    return { kind: 'file', candidates: [path] };
  // No extension, or one that is part of the name (`./Tank.types`): the
  // exact file first, for an asset like `./tank.png`, then the module forms.
  return {
    kind: 'file',
    candidates: [
      ...(extension ? [path] : []),
      ...MODULE_EXTENSIONS.map((ext) => `${path}.${ext}`),
      `${path}.json`,
      ...indexCandidates(path),
    ],
  };
}

function indexCandidates(folder: string): string[] {
  const prefix = folder ? `${folder}/` : '';
  return ['ts', 'tsx', 'js'].map((ext) => `${prefix}index.${ext}`);
}

/** `to` as an import written in `from`, for a host that rewrites imports to the files they found. */
export function previewImportSpecifier(from: string, to: string): string {
  const base = from.split('/').slice(0, -1);
  const target = to.split('/');
  let shared = 0;
  while (shared < base.length && shared < target.length - 1 && base[shared] === target[shared])
    shared++;
  const up = base.length - shared;
  const rest = target.slice(shared).join('/');
  return up ? `${'../'.repeat(up)}${rest}` : `./${rest}`;
}

/** What a preview says about an import it cannot follow, naming the file that made it. */
export function previewImportProblem(
  from: string,
  specifier: string,
  found: PreviewImport,
): string {
  if (found.kind === 'package')
    return `${from} imports the npm package "${found.name}". A preview runs only files in the project, so add the library's file to the project and import it by path.`;
  if (found.kind === 'url')
    return `${from} imports ${specifier}. A preview runs only files in the project, not code from the web.`;
  if (found.kind === 'outside')
    return `${from} imports ${specifier}, which is outside the folder being previewed.`;
  return `${from} imports ${specifier}, which isn't in the project.`;
}

export interface PreviewModule {
  path: string;
  /** CommonJS: reads `require`, `module` and `exports`. */
  code: string;
  /** Each specifier the code requires, mapped to the module path it names. */
  requires: Record<string, string>;
}

/**
 * Links compiled modules into one classic script, for a host that cannot
 * serve them as separate files: the phones' previews are a single snapshot
 * page whose scripts are data URLs, and a data URL has nothing to resolve a
 * relative import against. Each module runs once, on first require, as it
 * would in a module graph. An entry that throws is reported and the next
 * still runs, as separate module scripts would.
 */
export function bundlePreviewModules(
  modules: readonly PreviewModule[],
  entries: readonly string[],
): string {
  const definitions = modules
    .map(
      (module) =>
        `${JSON.stringify(module.path)}:[function(require,module,exports){\n${module.code}\n},${JSON.stringify(module.requires)}]`,
    )
    .join(',\n');
  const run = entries
    .map(
      (entry) =>
        `try{load(${JSON.stringify(entry)});}catch(error){setTimeout(function(){throw error;});}`,
    )
    .join('\n');
  return `(function(){
var definitions={${definitions}};
var cache={};
function load(path){
var cached=cache[path];
if(cached)return cached.exports;
var definition=definitions[path];
var module={exports:{}};
cache[path]=module;
definition[0].call(module.exports,function(specifier){
var target=definition[1][specifier];
if(target===undefined)throw new Error(path+' imports '+specifier+', which this preview could not find.');
return load(target);
},module,module.exports);
return module.exports;
}
${run}
})();`;
}
