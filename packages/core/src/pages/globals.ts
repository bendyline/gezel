import type { PageLibraryLine } from '../schemas/page-library.js';

/**
 * Modules made from a plain-script build's global (docs/page-libraries.md).
 * React 18 publishes only plain-script builds, which set `window.React`; a
 * page that writes `import { useState } from 'react'` needs a module. The
 * shelf answers with a few lines it writes itself: load the build, export
 * what it set. The bytes of the build stay as published.
 */

/** Where these modules sit inside a line's address space; no package ships a `_gezel/` folder. */
export const GLOBAL_MODULE_FOLDER = '_gezel/';

type GlobalSpec = NonNullable<PageLibraryLine['globals']>[string];

/** The address of the module for a request: `.` → `_gezel/index.js`, `./client` → `_gezel/client.js`. */
export function globalModulePath(request: string): string {
  const name = request === '.' ? 'index' : request.slice(2).replace(/\//g, '__');
  return `${GLOBAL_MODULE_FOLDER}${name}.js`;
}

type CommonJsSpec = NonNullable<PageLibraryLine['commonjs']>[string];

/** Every request a line answers with a module the shelf writes. */
export function writtenModuleRequests(line: PageLibraryLine): string[] {
  return [...new Set([...Object.keys(line.globals ?? {}), ...Object.keys(line.commonjs ?? {})])];
}

/** The request and its spec behind a written module's path, or null. */
export function globalModuleSpec(
  line: PageLibraryLine,
  path: string,
): { request: string; spec: GlobalSpec } | null {
  if (!path.startsWith(GLOBAL_MODULE_FOLDER)) return null;
  for (const [request, spec] of Object.entries(line.globals ?? {})) {
    if (globalModulePath(request) === path) return { request, spec };
  }
  return null;
}

/** `../` enough times to climb out of the module folder. */
function fromModuleFolder(file: string): string {
  return `../${file}`;
}

function jsxRuntimeBody(global: string): string {
  const R = `globalThis[${JSON.stringify(global)}]`;
  return `const R = ${R};
export const Fragment = R.Fragment;
function element(type, props, key, spread) {
  const { children, ...rest } = props || {};
  if (key !== undefined) rest.key = key;
  if (children === undefined) return R.createElement(type, rest);
  return spread && Array.isArray(children)
    ? R.createElement(type, rest, ...children)
    : R.createElement(type, rest, children);
}
export function jsx(type, props, key) { return element(type, props, key, false); }
export function jsxs(type, props, key) { return element(type, props, key, true); }
export const jsxDEV = jsx;`;
}

/** The ES module the shelf serves at a written module's path, or null when the line names none there. */
export function globalModuleSource(line: PageLibraryLine, path: string): string | null {
  const found = globalModuleSpec(line, path);
  if (!found) return null;
  const { spec } = found;
  const lines = [
    `// Written by Gezel from ${line.name} ${line.version}'s ${spec.file} (docs/page-libraries.md).`,
    ...(spec.after ?? []).map((name) => `import ${JSON.stringify(name)};`),
    `import ${JSON.stringify(fromModuleFolder(spec.file))};`,
  ];
  if (spec.jsxRuntime) {
    lines.push(jsxRuntimeBody(spec.global));
  } else {
    lines.push(`const g = globalThis[${JSON.stringify(spec.global)}];`, 'export default g;');
    if (spec.exports.length) lines.push(`export const { ${spec.exports.join(', ')} } = g;`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The same module for a host that links files into one plain script (the
 * single-file export, the phones). Its build runs first as a plain script,
 * so this only hands the global on.
 */
export function globalModuleCommonJs(line: PageLibraryLine, path: string): string | null {
  const found = globalModuleSpec(line, path);
  if (!found) return null;
  const { spec } = found;
  if (spec.jsxRuntime) {
    return jsxRuntimeBody(spec.global)
      .replace(/^export const /gm, 'const ')
      .replace(/^export function /gm, 'function ')
      .concat('\nmodule.exports = { Fragment, jsx, jsxs, jsxDEV };\n');
  }
  return `module.exports = globalThis[${JSON.stringify(spec.global)}];\n`;
}

/** The request and its CommonJS spec behind a written module's path, or null. */
export function commonJsModuleSpec(
  line: PageLibraryLine,
  path: string,
): { request: string; spec: CommonJsSpec } | null {
  if (!path.startsWith(GLOBAL_MODULE_FOLDER)) return null;
  for (const [request, spec] of Object.entries(line.commonjs ?? {})) {
    if (line.globals?.[request]) continue;
    if (globalModulePath(request) === path) return { request, spec };
  }
  return null;
}

/** Names the wrapper keeps for itself; an export by one of them is left out. */
const WRAPPER_NAMES = new Set(['default', '__gezelModule', '__gezelRequire', '__gezelExports']);

/**
 * The ES module the shelf serves for a CommonJS file: the file runs inside a
 * function, byte for byte, with `require` answered by the line's declared
 * imports. `code` is the file's text, which the caller has hash-checked.
 */
export function commonJsModuleSource(
  line: PageLibraryLine,
  path: string,
  code: string,
): string | null {
  const found = commonJsModuleSpec(line, path);
  if (!found) return null;
  const { spec } = found;
  const imports = spec.imports.map((name, index) => ({ name, local: `__gezelImport${index}` }));
  const names = spec.exports.filter((name) => !WRAPPER_NAMES.has(name));
  return [
    `// Written by Gezel from ${line.name} ${line.version}'s ${spec.file} (docs/page-libraries.md).`,
    ...imports.map(({ name, local }) => `import * as ${local} from ${JSON.stringify(name)};`),
    'const __gezelRequire = (id) => {',
    ...imports.map(
      ({ name, local }) =>
        `  if (id === ${JSON.stringify(name)}) return ${local}.default ?? ${local};`,
    ),
    '  throw new Error(`Cannot find module ${id}`);',
    '};',
    'const __gezelModule = { exports: {} };',
    '(function (exports, module, require) {',
    code,
    '}).call(__gezelModule.exports, __gezelModule.exports, __gezelModule, __gezelRequire);',
    'const __gezelExports = __gezelModule.exports;',
    'export default __gezelExports;',
    ...(names.length ? [`export const { ${names.join(', ')} } = __gezelExports;`] : []),
    '',
  ].join('\n');
}
