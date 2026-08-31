/**
 * Translate the content indexer's language taxonomy to Monaco language IDs.
 *
 * The index describes source formats (`tsx`, `jsx`, `c_sharp`); Monaco names
 * the tokenizers that render them (`typescript`, `javascript`, `csharp`). Keep
 * that distinction at this UI boundary instead of leaking editor terminology
 * into the persisted index.
 */
const INDEXED_LANGUAGE_TO_MONACO: Readonly<Record<string, string>> = {
  tsx: 'typescript',
  jsx: 'javascript',
  c: 'cpp',
  c_sharp: 'csharp',
  bash: 'shell',
  text: 'plaintext',
  toml: 'ini',
  properties: 'ini',
  yml: 'yaml',
};

export function monacoLanguageForIndexedLanguage(
  language: string | null | undefined,
): string | undefined {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return undefined;
  return INDEXED_LANGUAGE_TO_MONACO[normalized] ?? normalized;
}
