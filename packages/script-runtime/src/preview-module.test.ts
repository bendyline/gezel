import { describe, expect, it } from 'vitest';
import { compilePreviewModule } from './preview-module.js';

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
