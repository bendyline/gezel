import type { Plugin } from 'vite';

/**
 * The phone starts its local service before it imports the UI (api.ts reads
 * the host synchronously on import), so the UI's scripts used to be fetched
 * and compiled only after the service was up. This lists the UI entry's
 * static import closure as `modulepreload` links in index.html, so the
 * WebView fetches and compiles them while the service starts. Nothing runs
 * early: a preloaded module executes only when it is imported.
 */
export function preloadUiGraphPlugin(): Plugin {
  return {
    name: 'gezel-preload-ui-graph',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return [];
        const uiEntry = Object.values(bundle).find(
          (output) =>
            output.type === 'chunk' &&
            output.facadeModuleId?.replaceAll('\\', '/').endsWith('/ui/src/main.tsx'),
        );
        if (!uiEntry || uiEntry.type !== 'chunk') return [];
        const files = new Set<string>();
        const visit = (fileName: string) => {
          if (files.has(fileName)) return;
          const output = bundle[fileName];
          if (output?.type !== 'chunk') return;
          files.add(fileName);
          for (const imported of output.imports) visit(imported);
        };
        visit(uiEntry.fileName);
        return [...files].map((fileName) => ({
          tag: 'link',
          // `crossorigin` as Vite writes its own, so the preload and the import share one request.
          attrs: { rel: 'modulepreload', crossorigin: true, href: `./${fileName}` },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}
