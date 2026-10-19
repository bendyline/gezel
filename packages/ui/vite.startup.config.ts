import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const articles = ['welcome', 'the-crew', 'projects-and-threads', 'night-shift'].map((id) => ({
  id,
  markdown: readFileSync(resolve('../../docs/handboek/conceptual', `${id}.md`), 'utf8'),
}));

export default defineConfig({
  define: { __STARTUP_ARTICLES__: JSON.stringify(articles) },
  plugins: [
    {
      name: 'startup-page',
      generateBundle(_options, bundle) {
        const scripts = Object.values(bundle).filter((asset) => asset.type === 'chunk');
        const bytes = scripts.reduce((sum, asset) => sum + Buffer.byteLength(asset.code), 0);
        if (scripts.length !== 1 || bytes > 48_000)
          throw new Error(`Startup must stay one small script (got ${bytes} bytes)`);
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:">
<title>Gezel</title><link rel="stylesheet" href="./startup.css"><script defer src="./startup.js"></script></head><body></body></html>`,
        });
      },
    },
  ],
  build: {
    outDir: 'dist/startup',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    lib: {
      entry: 'src/startup/screen.ts',
      name: 'GezelStartup',
      formats: ['iife'],
      fileName: () => 'startup.js',
      cssFileName: 'startup',
    },
  },
});
