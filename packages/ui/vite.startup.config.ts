import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [
    {
      name: 'startup-page',
      generateBundle(_options, bundle) {
        const scripts = Object.values(bundle).filter(
          (asset) => asset.type === 'chunk' && asset.isEntry,
        );
        const initial = new Set<string>();
        const visit = (file: string) => {
          if (initial.has(file)) return;
          initial.add(file);
          const asset = bundle[file];
          if (asset?.type === 'chunk') asset.imports.forEach(visit);
        };
        for (const asset of scripts) visit(asset.fileName);
        let bytes = 0;
        for (const file of initial) {
          const asset = bundle[file];
          if (asset?.type !== 'chunk') continue;
          bytes += Buffer.byteLength(asset.code);
          if (
            Object.keys(asset.modules).some(
              (id) => id.includes('/squisq') || id.includes('\\squisq'),
            )
          )
            throw new Error('Squisq must remain outside the initial startup script graph');
        }
        if (scripts.length !== 1 || bytes > 400_000)
          throw new Error(`Startup must stay one small script (got ${bytes} bytes)`);
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:">
<title>Gezel</title><link rel="stylesheet" href="./screen.css"><script type="module" src="./startup.js"></script></head><body></body></html>`,
        });
      },
    },
  ],
  build: {
    outDir: 'dist/startup',
    emptyOutDir: true,
    cssCodeSplit: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve('src/startup/screen.ts'),
      output: {
        entryFileNames: 'startup.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? '[name][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
