import { describe, expect, it } from 'vitest';
import { typescript } from './typescript-lazy.js';

describe('typescript, loaded on first use', () => {
  it('resolves the compiler package once and parses with it', () => {
    const ts = typescript();
    expect(typescript()).toBe(ts);
    const sf = ts.createSourceFile('x.ts', 'const a: number = 1;', ts.ScriptTarget.ES2022);
    expect(sf.statements).toHaveLength(1);
  });
});
