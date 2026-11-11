/**
 * Shared Squisq theme for gezel chat surfaces — bubble bodies in
 * [chat-bubbles.tsx](./chat-bubbles.tsx) and attachment previews in
 * [ChatReferences.tsx](./ChatReferences.tsx). One source of truth so
 * those two surfaces never visually drift apart.
 *
 * Squisq 1.3.0 dropped the `fontStack` + `registerTheme` helpers and
 * moved its theme library under `@bendyline/squisq/schemas`. We
 * resolve the chat theme by id from there instead of building one
 * inline; the prior `gezellig` + PT Serif customization is parked
 * until the editorial-typography work returns upstream. See the
 * commit that lands here for the dropped customization details.
 */

import { LIGHT_SURFACE, type SurfaceScheme } from '@bendyline/squisq';
import { type FontFamily, type Theme, resolveTheme } from '@bendyline/squisq/schemas';
import { GEZEL_DARK_SURFACE } from './transform/surfaces.js';

export const GEZEL_CHAT_THEME_ID = 'gezellig';

// Light-mode reading surface: the quiet cream of the shared Gezel paper
// family. It sits on the parchment hue with less color than the chrome, so
// it reads neither yellow nor pink beside it. `background` must stay
// matched to the light `--chat-bubble-bg` token in styles/foundation.css
// so the Squisq interior and its outer bubble remain one continuous surface.
// `backgroundLight` is the slightly deeper inset tone used for code blocks.
// Text colors carry over from `LIGHT_SURFACE`. Shared by chat bubbles and the
// Home intro's embedded Handboek page so gezel's reading surfaces never drift.
export const GEZEL_LIGHT_SURFACE: SurfaceScheme = {
  id: 'gezel-chat-light',
  background: '#eeeae1',
  backgroundLight: '#e5e0d6',
  text: LIGHT_SURFACE.text,
  textMuted: LIGHT_SURFACE.textMuted,
};

/**
 * The reading surface for a theme mode. Night always names one: Squisq's
 * gezellig preset is dark-first and carries its own walnut page (`#1f1a17`,
 * code blocks `#2b2420`), so a reader that left `surface` unset at night
 * painted a brown page inside the charcoal app. The dark values repeat
 * foundation.css's night panel and inset papers and its cream inks.
 */
export function gezelReadingSurfaceForMode(mode: 'light' | 'dark'): SurfaceScheme {
  return mode === 'light' ? GEZEL_LIGHT_SURFACE : GEZEL_DARK_SURFACE;
}

/**
 * Keep the gezellig palette and typography without its decorative page
 * textures. Squisq's built-in theme uses an SVG noise pattern in linear mode
 * and a persistent noise layer in presentation mode; chat and artifact
 * previews are reading surfaces, so those treatments show up as visual grit
 * behind otherwise plain prose.
 *
 * Adapt the resolved theme here instead of changing the upstream preset so
 * other Squisq surfaces can continue to use the complete gezellig design.
 */
function createGezelChatTheme(): Theme {
  const baseTheme = resolveTheme(GEZEL_CHAT_THEME_ID);
  const { persistentLayers: _persistentLayers, pageStyle, ...themeWithoutLayers } = baseTheme;

  return {
    ...themeWithoutLayers,
    colors: { ...baseTheme.colors, primary: '#ce966f' },
    ...(pageStyle
      ? {
          pageStyle: {
            ...pageStyle,
            tokens: { ...pageStyle.tokens, pattern: 'none' },
          },
        }
      : {}),
  };
}

export const gezelChatTheme: Theme = createGezelChatTheme();

const lightChatTheme: Theme = {
  ...gezelChatTheme,
  colors: { ...gezelChatTheme.colors, primary: '#924e2a' },
};

/** The default reading palette needs different link ink on light paper. */
export function gezelChatThemeForMode(mode: 'light' | 'dark'): Theme {
  return mode === 'light' ? lightChatTheme : gezelChatTheme;
}

/** The app's bundled UI sans (`--font-ui`), so no font is fetched. */
export const GEZEL_REPORT_FONT: FontFamily = {
  custom: { name: 'Hanken Grotesk', fallback: 'system-ui' },
};

/**
 * Reports, plans and notes are working documents, read for their facts:
 * gezellig's serif titles and numerals give a night-shift report the voice of
 * an essay. Same palette and page rhythm as chat, one neutral sans
 * throughout. Chat, the Handboek and albums keep the editorial serif.
 */
function withReportTypography(theme: Theme): Theme {
  return {
    ...theme,
    typography: {
      ...theme.typography,
      bodyFont: GEZEL_REPORT_FONT,
      titleFont: GEZEL_REPORT_FONT,
    },
  };
}

export const gezelReportTheme: Theme = withReportTypography(gezelChatTheme);

const lightReportTheme: Theme = withReportTypography(lightChatTheme);

export function gezelReportThemeForMode(mode: 'light' | 'dark'): Theme {
  return mode === 'light' ? lightReportTheme : gezelReportTheme;
}
