import { describe, expect, it } from 'vitest';
import { ScriptMetaError, parseScriptMeta } from './meta.js';

describe('parseScriptMeta', () => {
  it('parses a minimal script file', () => {
    const src = `
      import { defineScript } from '@bendyline/gezel-sdk';
      export const meta = defineScript({
        name: 'hello',
        description: 'says hello',
      });
    `;
    const meta = parseScriptMeta(src, 'hello.ts');
    expect(meta.name).toBe('hello');
  });

  it('parses a meta wrapped in "as const"', () => {
    const src = `
      export const meta = {
        name: 'noop',
        description: 'ten chars.',
      } as const;
    `;
    const meta = parseScriptMeta(src, 'noop.ts');
    expect(meta.name).toBe('noop');
  });

  it('unwraps satisfies and parentheses around the literal', () => {
    const src = `
      export const meta = (defineScript(({
        name: 'wrapped',
        description: 'wrapped several ways',
      }) satisfies object));
    `;
    expect(parseScriptMeta(src, 'wrapped.ts').name).toBe('wrapped');
  });

  it('parses full inputs + outputs with defineScript wrapper', () => {
    const src = `
      import { defineScript } from '@bendyline/gezel-sdk';
      export const meta = defineScript({
        name: 'fetch-rates',
        description: 'pulls rates for a base currency',
        inputs: {
          base: { type: 'string', description: 'ISO code', required: true, pattern: '^[A-Z]{3}$' },
          source: {
            type: 'choice',
            description: 'provider',
            options: [{ value: 'ecb' }, { value: 'fed' }],
            default: 'ecb',
          },
        },
        outputs: {
          ok: { type: 'boolean', description: 'success flag' },
        },
        requires: ['network', 'artifacts.write'],
      });
    `;
    const meta = parseScriptMeta(src, 'fetch-rates.ts');
    expect(meta.inputs?.base?.type).toBe('string');
    expect(meta.outputs?.ok?.type).toBe('boolean');
    expect(meta.requires).toEqual(['network', 'artifacts.write']);
  });

  it('evaluates every literal kind the extractor accepts', () => {
    const src = `
      export const meta = {
        'name': \`literals\`,
        description: 'covers every literal kind',
        kind: ('action' as const),
        inputs: {
          count: { type: 'number', description: 'n', required: false, min: -5, max: 10, integer: true },
          flag: { type: 'boolean', description: 'b', default: false },
          blob: { type: 'json', description: 'j', default: null },
          1: { type: 'string', description: 'numeric key' },
        },
      };
    `;
    const meta = parseScriptMeta(src, 'literals.ts');
    expect(meta.name).toBe('literals');
    expect(meta.kind).toBe('action');
    expect(meta.inputs?.count).toMatchObject({ required: false, min: -5, max: 10, integer: true });
    expect(meta.inputs?.flag).toMatchObject({ default: false });
    expect(meta.inputs?.blob).toMatchObject({ default: null });
    expect(meta.inputs?.['1']?.type).toBe('string');
  });

  it('skips non-exported and non-meta declarations when looking for meta', () => {
    const src = `
      function helper() {}
      const meta = { name: 'shadow', description: 'not exported at all' };
      export const { a } = { a: 1 };
      export const other = 1, meta2 = 2;
      export const meta = { name: 'real', description: 'the exported one' };
    `;
    expect(parseScriptMeta(src, 'real.ts').name).toBe('real');
  });

  it('throws when meta export is missing', () => {
    const src = `export const foo = 'bar';`;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(ScriptMetaError);
  });

  it('throws when meta is declared without an initializer', () => {
    expect(() => parseScriptMeta('export let meta;', 'bad.ts')).toThrow(/does not export/);
  });

  it('carries the script path on the error', () => {
    try {
      parseScriptMeta('const x = 1;', 'scripts/where.ts');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ScriptMetaError);
      expect((err as ScriptMetaError).scriptPath).toBe('scripts/where.ts');
      expect((err as ScriptMetaError).name).toBe('ScriptMetaError');
    }
  });

  it('rejects a meta that is not an object literal', () => {
    expect(() => parseScriptMeta(`export const meta = 'nope';`, 'bad.ts')).toThrow(
      /must be an object literal.*StringLiteral/,
    );
  });

  it('reports schema violations with the offending path', () => {
    const src = `export const meta = { name: '1bad', description: 'short' };`;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/meta did not validate:[\s\S]*name:/);
  });

  it('rejects a meta expression that uses a foreign call', () => {
    const src = `
      const other = (x) => x;
      export const meta = other({ name: 'bad', description: 'still ten chars' });
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/plain object or defineScript/);
  });

  it('names a non-identifier callee by its syntax kind', () => {
    const src = `export const meta = sdk.defineScript({ name: 'bad', description: 'ten chars.' });`;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/PropertyAccessExpression/);
  });

  it('rejects computed keys', () => {
    const src = `
      export const meta = {
        ['nam' + 'e']: 'bad',
        description: 'still ten chars',
      };
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/computed property keys/);
  });

  it('rejects spread elements', () => {
    const src = `
      const extra = {};
      export const meta = { ...extra, name: 'bad', description: 'still ten' };
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/only "key: value" properties/);
  });

  it('rejects shorthand properties', () => {
    const src = `
      const name = 'bad';
      export const meta = { name, description: 'still ten chars' };
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/ShorthandPropertyAssignment/);
  });

  it('rejects array spread', () => {
    const src = `
      const caps = ['network'];
      export const meta = { name: 'bad', description: 'still ten chars', requires: [...caps] };
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/spread is not supported/);
  });

  it('rejects unary minus on anything but a number', () => {
    const src = `export const meta = { name: 'bad', description: 'still ten', x: -'1' };`;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/unary minus/);
  });

  it('rejects an expression kind it cannot evaluate', () => {
    const src = `
      export const meta = { name: 'bad', description: 1 + 2 };
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/unsupported expression kind/);
  });
});
