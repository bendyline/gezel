import { describe, expect, it } from 'vitest';
import { monacoLanguageForIndexedLanguage } from './monaco-language.js';

describe('monacoLanguageForIndexedLanguage', () => {
  it.each([
    ['tsx', 'typescript'],
    ['jsx', 'javascript'],
    ['c', 'cpp'],
    ['c_sharp', 'csharp'],
    ['bash', 'shell'],
    ['text', 'plaintext'],
    ['toml', 'ini'],
    ['properties', 'ini'],
    ['yml', 'yaml'],
  ])('translates the indexer language %s to %s', (indexed, monaco) => {
    expect(monacoLanguageForIndexedLanguage(indexed)).toBe(monaco);
  });

  it('preserves matching and future language identifiers', () => {
    expect(monacoLanguageForIndexedLanguage('typescript')).toBe('typescript');
    expect(monacoLanguageForIndexedLanguage('  PYTHON ')).toBe('python');
    expect(monacoLanguageForIndexedLanguage('future-language')).toBe('future-language');
  });

  it('leaves language inference to the filename when the index has no language', () => {
    expect(monacoLanguageForIndexedLanguage(null)).toBeUndefined();
    expect(monacoLanguageForIndexedLanguage(undefined)).toBeUndefined();
    expect(monacoLanguageForIndexedLanguage('   ')).toBeUndefined();
  });
});
