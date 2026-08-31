import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { Theme } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { runWithManagedBrowser } from '../rendering/managed-browser.js';

/**
 * Open Graph cards for Handboek pages: one poster-shaped PNG per article,
 * rendered through squisq-cli's dashboard renderer on the service's managed
 * Chromium — the same primitive the ambient wallpaper uses
 * (see ../ambient/dashboard-render.ts).
 *
 * The recipe is deliberately fixed. A card is one `focus-1` cell holding a
 * `bigText` headline under a title band carrying the kicker, because a link
 * preview is read at thumbnail size: few words, very large, one accent.
 * Dashboard mosaics are the opposite of that and are not an option here.
 */

/** Every OG consumer wants 1200x630; nothing here is parameterized on size. */
export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

/**
 * The gezel.com Handboek palette, mirrored from `BASELINE_CSS` in
 * packages/cli/src/handboek-site-css.ts so a card sits in the same world as
 * the page it previews. Keep the two in step by hand — the stylesheet is a
 * string constant in another package and there is nothing to import.
 *
 * No `persistentLayers`: every built-in theme layers a `noise`
 * patternBackground, and noise is random pixel data across the whole canvas.
 * It tripled the encoded PNG (736KB against 213KB) for a texture invisible at
 * preview size.
 */
export const GEZEL_SITE_THEME: Theme = {
  schemaVersion: '1',
  id: 'gezel-site',
  name: 'Gezel Site',
  description: 'The gezel.com Handboek palette: parchment canvas, warm ink, terracotta accent.',
  colors: {
    primary: '#b0724c',
    secondary: '#667f62',
    background: '#eae5d6',
    backgroundLight: '#f3eddf',
    text: '#1c1c1c',
    textMuted: '#5a4f42',
    highlight: '#b0724c',
    warning: '#996142',
  },
  typography: {
    bodyFont: { stackId: 'source-serif' },
    titleFont: { stackId: 'playfair' },
    titleWeight: 'bold',
    lineHeight: 1.35,
  },
  style: { textShadow: false, overlayOpacity: 0.2, animationSpeed: 1, borderRadius: 4 },
  renderStyle: {
    name: 'gezel-site',
    defaultTextAnimation: 'fadeIn',
    ambientMotion: false,
    defaultTransition: { type: 'fade', duration: 1 },
  },
  colorSchemes: {
    orange: { bg: '#f3eddf', text: '#1c1c1c', accent: '#b0724c' },
    green: { bg: '#f3eddf', text: '#1c1c1c', accent: '#667f62' },
  },
};

export interface OgCardSpec {
  /** The title band's one small line, e.g. `gezel · What's new · 1.26237`. */
  kicker: string;
  /** The only large text on the card. Keep it under ~80 characters. */
  headline: string;
}

/**
 * Render one card and return the PNG bytes.
 *
 * Throws `ChromiumNotReadyError` when the managed browser has not been
 * downloaded yet; callers rendering in bulk should probe once up front rather
 * than letting every card fail in turn.
 */
export async function renderOgCard(home: string, spec: OgCardSpec): Promise<Uint8Array> {
  const markdown = buildCardMarkdown(spec);
  const doc = {
    ...markdownToDoc(parseMarkdown(markdown)),
    customThemes: [GEZEL_SITE_THEME],
    themeId: GEZEL_SITE_THEME.id,
  };
  const { renderDocToDashboardPng } = await import('@bendyline/squisq-cli/api');
  const result = await runWithManagedBrowser(home, () =>
    renderDocToDashboardPng(doc, emptyContainer(markdown), {
      width: OG_CARD_WIDTH,
      height: OG_CARD_HEIGHT,
      layout: 'focus-1',
      style: 'basic',
      title: true,
    }),
  );
  return result.bytes;
}

/**
 * A one-block squisq document: frontmatter title for the band, one
 * `{[bigText]}` heading for the headline.
 *
 * Both fields are model- or author-supplied, so neither may be pasted in raw.
 * The title is emitted as a JSON string — valid YAML's double-quoted scalar —
 * and the headline is stripped of the characters that would otherwise close
 * the heading or open a second template annotation.
 */
export function buildCardMarkdown(spec: OgCardSpec): string {
  const kicker = collapse(spec.kicker);
  const headline = collapse(stripMarkup(spec.headline));
  if (!headline) throw new Error('OG card headline is empty after sanitizing.');
  return `---\ntitle: ${JSON.stringify(kicker)}\n---\n\n# ${headline} {[bigText]}\n`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Drop the characters that would let a headline escape its heading — the
 * template-annotation delimiters and a heading marker. Written as plain
 * replacements rather than a character class because the class needs escaped
 * brackets and this is not worth a regex to misread.
 */
function stripMarkup(value: string): string {
  return value
    .replaceAll('{', '')
    .replaceAll('}', '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replaceAll('#', '');
}

/** The card carries no media, so the container never has anything to serve. */
function emptyContainer(markdown: string): ContentContainer {
  const readOnly = async (): Promise<never> => {
    throw new Error('The OG card container is read-only.');
  };
  return {
    readFile: async () => null,
    writeFile: readOnly,
    removeFile: readOnly,
    listFiles: async () => [],
    exists: async () => false,
    getDocumentPath: async () => 'og-card.md',
    readDocument: async () => markdown,
    writeDocument: readOnly,
  };
}

/**
 * Whether the managed Chromium a card render needs is on disk yet.
 *
 * A bulk caller probes once and skips the whole pass on false. Without that,
 * a machine that has never launched the app fails identically several hundred
 * times, and the real message — that the browser is still downloading — is
 * buried under the repetition.
 */
export async function isOgRendererReady(home: string): Promise<boolean> {
  const { playwrightBrowsersDir } = await import('@bendyline/gezel/paths');
  const { resolveManagedChromiumBinary } = await import('../rendering/managed-chromium.js');
  return Boolean(await resolveManagedChromiumBinary(playwrightBrowsersDir(home)));
}
