import { describe, expect, it } from 'vitest';
import { compilePreviewModule, scanPreviewModuleImports } from './preview-module.js';

const source = [
  'import { Engine } from "./engine";',
  'import type { Unit } from "./units";',
  'export * from "./tank.js";',
  'const units: Unit[] = [];',
  'export const engine = new Engine(units);',
].join('\n');

describe('compiling a project file for a preview', () => {
  it('keeps only the imports the running code needs, located in the output', () => {
    for (const format of ['esm', 'commonjs'] as const) {
      const { code, imports, errors } = compilePreviewModule(source, 'src/main.ts', format);
      expect(errors).toEqual([]);
      expect(imports.map(({ specifier }) => specifier)).toEqual(['./engine', './tank.js']);
      for (const { specifier, start, end } of imports)
        expect(code.slice(start, end)).toBe(specifier);
      expect(code).not.toContain('Unit[]');
    }
  });

  it('turns imports into require calls for a host that links files together', () => {
    const { code } = compilePreviewModule(source, 'src/main.ts', 'commonjs');
    expect(code).toContain('require("./engine")');
    expect(code).not.toMatch(/^import /m);
  });

  it('reports a syntax error with its place, but never a type error', () => {
    expect(compilePreviewModule('const x: number = "text";', 'a.ts', 'esm').errors).toEqual([]);
    const { errors } = compilePreviewModule('const x = ;', 'src/a.ts', 'esm');
    expect(errors[0]).toMatch(/^src\/a\.ts:1:11 /);
  });

  it('refuses top-level await where the module is linked into a function', () => {
    const awaited = 'const data = await fetchLevel();\nasync function later() { await data; }';
    expect(compilePreviewModule(awaited, 'level.ts', 'esm').errors).toEqual([]);
    expect(compilePreviewModule(awaited, 'level.ts', 'commonjs').errors).toEqual([
      'level.ts:1:14 uses await outside a function, which this preview cannot run. Move it into an async function.',
    ]);
  });
});

describe('finding the imports in a file served as written', () => {
  it('locates static, re-exported and literal dynamic imports in the source', () => {
    const code = [
      'import * as THREE from "https://esm.sh/three";',
      "export { a } from './a.js';",
      'const later = () => import(`https://esm.sh/chart.js`);',
      'const not = "import x from \'nope\'";',
      'import(name);',
    ].join('\n');
    const imports = scanPreviewModuleImports(code, 'main.js');
    expect(imports.map(({ specifier }) => specifier)).toEqual([
      'https://esm.sh/three',
      './a.js',
      'https://esm.sh/chart.js',
    ]);
    for (const { specifier, start, end } of imports) expect(code.slice(start, end)).toBe(specifier);
  });

  // The text scan behind `compilePreviewModule` reads this line as one long
  // string after the regex's quote and reports no imports at all.
  it('finds imports after a regex literal that holds a quote, on one minified line', () => {
    const code = 'const r=/"/g;import{a as b}from"three";export*from"./x.js";import("y")';
    expect(scanPreviewModuleImports(code, 'min.js').map(({ specifier }) => specifier)).toEqual([
      'three',
      './x.js',
      'y',
    ]);
  });
});

describe('type-only imports', () => {
  it('are not imports a browser makes', () => {
    const code =
      "import type { A } from 'a';\nexport type { B } from 'b';\nimport { type C, d } from 'c';";
    expect(scanPreviewModuleImports(code, 'x.ts').map(({ specifier }) => specifier)).toEqual(['c']);
  });
});

describe('which JSX runtime a module gets', () => {
  it('uses the automatic runtime of the library the module imports', () => {
    const react = compilePreviewModule(
      "import { useState } from 'react';\nexport const A = () => <b>{useState(1)[0]}</b>;",
      'a.jsx',
      'esm',
    );
    expect(react.imports.map((entry) => entry.specifier)).toContain('react/jsx-runtime');
    expect(react.code).not.toContain('React.createElement');

    const preact = compilePreviewModule(
      "import { render } from 'preact';\nrender(<b />, document.body);",
      'a.tsx',
      'esm',
    );
    expect(preact.imports.map((entry) => entry.specifier)).toContain('preact/jsx-runtime');
  });

  it("uses React's automatic runtime for a component module that imports nothing, as Vite does", () => {
    const component = compilePreviewModule('export const A = () => <b>x</b>;', 'a.jsx', 'esm');
    expect(component.imports.map((entry) => entry.specifier)).toEqual(['react/jsx-runtime']);
    expect(component.code).not.toContain('React.createElement');
  });

  it("uses the page's global React for a script, or a module that names the global", () => {
    // Babel's in-page JSX: no imports or exports, React from a script tag.
    const script = compilePreviewModule(
      "ReactDOM.createRoot(document.getElementById('root')).render(<b>x</b>);",
      'inline-1.jsx',
      'esm',
    );
    expect(script.code).toContain('React.createElement');
    expect(script.imports).toEqual([]);
    const global = compilePreviewModule(
      'export const A = () => { const [n] = React.useState(1); return <b>{n}</b>; };',
      'a.jsx',
      'esm',
    );
    expect(global.code).toContain('React.createElement');
    expect(global.imports).toEqual([]);
    // A property named React is not the global.
    const property = compilePreviewModule(
      'export const A = (props) => <b>{props.React}</b>;',
      'a.jsx',
      'esm',
    );
    expect(property.imports.map((entry) => entry.specifier)).toEqual(['react/jsx-runtime']);
  });
});
