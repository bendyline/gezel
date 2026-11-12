/**
 * Preload the faces the shell paints with. A font is otherwise requested only
 * once the stylesheet that names it has been parsed and text needing it has
 * been laid out, and with `font-display: swap` the first frame draws in the
 * fallback face, then reflows when the real one lands.
 *
 * The faces are named by their source file (`hanken-grotesk-400`); the plugin
 * finds the hashed asset Vite emitted for each. A name that matches nothing
 * fails the build, so a renamed font cannot silently drop its preload.
 */
import type { Plugin } from 'vite';

export function fontPreloadPlugin(faces: readonly string[]): Plugin {
  return {
    name: 'gezel-font-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        const files = Object.keys(ctx.bundle);
        return faces.map((face) => {
          const pattern = new RegExp(`(?:^|/)${face}-[\\w-]+\\.woff2$`);
          const file = files.find((name) => pattern.test(name));
          if (!file) throw new Error(`font preload: no emitted asset for ${face}`);
          return {
            tag: 'link',
            attrs: {
              rel: 'preload',
              href: `/${file}`,
              as: 'font',
              type: 'font/woff2',
              crossorigin: '',
            },
            injectTo: 'head' as const,
          };
        });
      },
    },
  };
}
