import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Third Vite build target: the Office task pane, served by gezeld at
 * `/office/*` on its Office listener (packages/service/src/office-host/).
 *
 *   pnpm --filter @bendyline/gezel-ui build:office
 *
 * Output, staged into the service's `dist/office/`:
 *   dist-office/{word,excel,powerpoint}/taskpane.html, commands.html
 *   dist-office/assets/*            hashed modules and CSS
 *   dist-office/icons/icon-*.png    ribbon icons the manifests name
 *   dist-office/history-guard.js    runs before office.js
 *
 * Deliberately small: the pane is Office.js glue (connection, document
 * tools, a header). The chat itself is the main UI's `?embedded=chat` page
 * in a same-origin iframe, so the pane never duplicates the app bundle.
 */
const root = fileURLToPath(new URL('./office-pages', import.meta.url));

export default defineConfig({
  root,
  base: '/office/',
  publicDir: fileURLToPath(new URL('./office-pages/public', import.meta.url)),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: fileURLToPath(new URL('./dist-office', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        word: `${root}/word/taskpane.html`,
        excel: `${root}/excel/taskpane.html`,
        powerpoint: `${root}/powerpoint/taskpane.html`,
        commands: `${root}/commands.html`,
      },
    },
  },
});
