declare module 'virtual:gezel-kokoro-lexicon' {
  /** Fetchable URL of each gzipped pronunciation dictionary, by language. */
  export const kokoroLexiconUrls: Readonly<Record<'us' | 'gb', string>>;
}
