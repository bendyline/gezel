import type { HandboekFigure } from '@bendyline/gezel';
import type { MediaEntry, MediaProvider } from '@bendyline/squisq';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import gezelMarkUrl from '../../assets/gezel-mark.png';
import { Poppetje, type PoppetjeVariant } from '../../poppetje/index.js';

/**
 * Media provider for Handboek articles. Expanded article markdown
 * references gezel figures as relative images
 * (`poppetje/{gezelId}.{variant}.svg`); the article payload carries the
 * matching poppetje structs in `figures[]`, so resolution is a pure
 * client-side render — the Poppetje component to an SVG string, then a
 * blob URL — with no extra fetches.
 *
 * The provider is read-only (articles are documentation, not an editing
 * surface): uploads and deletions are inert.
 */
const FIGURE_RE = /^poppetje\/(.+)\.(full|headshot|icon)\.svg$/;

/**
 * Brand images referenced by curated articles as `../assets/<name>`
 * (file-relative, so the markdown reads on GitHub and passes the repo
 * link checker) — the same paths the static-site export serves by
 * copying the content tree's `assets/` folder. In-app they resolve to
 * the already-bundled originals so no HTTP round-trip (or new service
 * route) is needed. Keyed content-root-relative; leading `../` segments
 * are stripped before lookup, mirroring the exporter's rewrite.
 */
const BUNDLED_ASSETS: Record<string, string> = {
  'assets/gezel-mark.png': gezelMarkUrl,
};

export function createHandboekMediaProvider(figures: HandboekFigure[]): MediaProvider {
  const byPath = new Map(figures.map((f) => [f.path, f]));
  const blobUrlCache = new Map<string, string>();

  return {
    async addMedia(): Promise<string> {
      throw new Error('handboek articles are read-only');
    },

    async resolveUrl(relPath: string): Promise<string> {
      const bundled = BUNDLED_ASSETS[relPath.replace(/^(\.\.?\/)+/, '')];
      if (bundled) return bundled;
      const cached = blobUrlCache.get(relPath);
      if (cached) return cached;
      const m = FIGURE_RE.exec(relPath);
      if (!m) return relPath;
      const figure = byPath.get(relPath);
      if (!figure) return relPath;
      const variant = m[2] as PoppetjeVariant;
      // `svgId` must be unique per figure: renderToStaticMarkup restarts
      // React's useId counter every call, so without it every figure's
      // url(#…) paint refs would collide onto one shared defs id.
      const markup = renderToStaticMarkup(
        createElement(Poppetje, {
          poppetje: figure.poppetje,
          variant,
          size: 160,
          svgId: `hb-${figure.gezelId}-${variant}`,
          title: figure.name,
        }),
      );
      // React omits xmlns (inline SVG doesn't need it), but a blob URL
      // loads as a standalone SVG document — without the namespace the
      // browser parses generic XML and the <img> stays 0×0 broken.
      const svg = markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      blobUrlCache.set(relPath, url);
      return url;
    },

    async listMedia(): Promise<MediaEntry[]> {
      return [];
    },

    async removeMedia(): Promise<void> {},

    dispose(): void {
      for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
      blobUrlCache.clear();
    },
  };
}
