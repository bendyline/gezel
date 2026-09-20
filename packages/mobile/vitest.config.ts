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
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
};
