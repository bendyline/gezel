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

  it('throws when meta export is missing', () => {
    const src = `export const foo = 'bar';`;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(ScriptMetaError);
  });

  it('rejects a meta expression that uses a foreign call', () => {
    const src = `
      const other = (x) => x;
      export const meta = other({ name: 'bad', description: 'still ten chars' });
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow(/plain object or defineScript/);
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
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow();
  });

  it('rejects an expression kind it cannot evaluate', () => {
    const src = `
      export const meta = { name: 'bad', description: 1 + 2 };
    `;
    expect(() => parseScriptMeta(src, 'bad.ts')).toThrow();
  });
});
