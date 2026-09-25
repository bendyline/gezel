export default {
  resolve: {
    alias: {
      '@bendyline/gezel/mobile-providers': new URL(
        '../core/src/schemas/mobile-provider.ts',
        import.meta.url,
      ).pathname,
      '@bendyline/gezel/schemas': new URL('../core/src/schemas/index.ts', import.meta.url).pathname,
      '@bendyline/gezel/poppetje': new URL('../core/src/poppetje/index.ts', import.meta.url)
        .pathname,
      '@bendyline/gezel/kokoro': new URL('../core/src/kokoro/index.ts', import.meta.url).pathname,
      // The Vite build emits the dictionaries as assets; tests supply the same
      // shape from a data: URL so the fetch-and-inflate path still runs.
      'virtual:gezel-kokoro-lexicon': new URL('./test/kokoro-lexicon-stub.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
};
