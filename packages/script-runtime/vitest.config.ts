import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@bendyline\/gezel$/,
        replacement: new URL('../core/src/browser.ts', import.meta.url).pathname,
      },
    ],
  },
});
