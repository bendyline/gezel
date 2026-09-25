import { describe, expect, it } from 'vitest';
import { compilePortableScript } from './compile.js';
import { scaffoldScript } from './source.js';

const source = `import { defineScript, gezel } from '@bendyline/gezel-sdk';
export const meta = defineScript({ name: 'saveLocal', description: 'Write a local verification artifact', requires: ['artifacts.write'], outputs: { ok: { type: 'boolean', description: 'Saved' } } } as const);
const value: string = 'offline compiler and QuickJS';
await gezel.artifacts.write('authored.txt', value);
gezel.output({ ok: true });`;

describe('portable trusted TypeScript compiler', () => {
  it('compiles the shared SDK with literal metadata and erases types', () => {
    const result = compilePortableScript(source, 'saveLocal');
    expect(result.meta?.requires).toEqual(['artifacts.write']);
    expect(result.diagnostics).toEqual([]);
    expect(result.javascript).toContain('gezel.artifacts.write');
    expect(result.javascript).not.toContain(': string');
  });
  it.each([
    `import fs from 'node:fs';`,
    `import 'some-package';`,
    'await import(gezel.input.module);',
    `require('fs');`,
  ])('refuses external or computed modules: %s', (code) => {
    const result = compilePortableScript(`${source}\n${code}`, 'saveLocal');
    expect(result.javascript).toBeUndefined();
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });
  it('never evaluates metadata expressions and rejects syntax/name mismatches', () => {
    const malicious = source.replace(
      "name: 'saveLocal'",
      "name: (() => { throw new Error('executed'); })()",
    );
    expect(compilePortableScript(malicious, 'saveLocal').javascript).toBeUndefined();
    expect(compilePortableScript(source, 'different').javascript).toBeUndefined();
    expect(
      compilePortableScript(`${source}\nconst broken = ;`, 'saveLocal').javascript,
    ).toBeUndefined();
  });
  it.each(['blank', 'check-files', 'post-message'] as const)(
    'compiles the existing desktop %s template unchanged',
    (template) => {
      const result = compilePortableScript(
        scaffoldScript('saveLocal', 'An offline shared script', template),
        'saveLocal',
      );
      expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
      expect(result.javascript).toBeTruthy();
    },
  );
});
