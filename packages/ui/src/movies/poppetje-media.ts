import type { Poppetje } from '@bendyline/gezel';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Poppetje as PoppetjeFigure } from '../poppetje/index.js';
import { poppetjeMediaPath } from './media.js';

/** The crops a movie references; `icon` is too small a crop for a scene. */
type MovieFigureVariant = 'headshot' | 'full';

/**
 * Pre-render a gezel's poppetje as a standalone SVG document for the
 * movie pipeline. The mapper itself stays React-free (it only emits
 * `media/poppetje/<id>.<variant>.svg` refs); this is the one place the
 * real figure renderer meets the recording, so the eval movie tooling
 * and the site export can drop the files beside a transcript.
 *
 * Deliberately NOT re-exported from `./index.js` — that barrel must stay
 * importable without React.
 */
export interface RenderedPoppetje {
  /** Transcript-dir-relative path the mapper will reference. */
  path: string;
  svg: string;
}

export function renderPoppetjeSvg(
  gezelId: string,
  name: string,
  poppetje: Poppetje,
  variant: MovieFigureVariant = 'headshot',
): RenderedPoppetje {
  // `svgId` must be unique per figure: renderToStaticMarkup restarts
  // React's useId counter every call, so without it every figure's
  // url(#…) paint refs would collide onto one shared defs id.
  const markup = renderToStaticMarkup(
    createElement(PoppetjeFigure, {
      poppetje,
      variant,
      size: 240,
      svgId: `mv-${gezelId}-${variant}`,
      title: name,
    }),
  );
  // React omits xmlns (inline SVG doesn't need it), but a standalone SVG
  // file needs the namespace or an <img> renders it 0×0.
  const svg = markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  return { path: poppetjeMediaPath(gezelId, variant), svg };
}
