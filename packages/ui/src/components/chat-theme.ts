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
import { type Theme, resolveTheme } from '@bendyline/squisq/schemas';

export const GEZEL_CHAT_THEME_ID = 'gezellig';

// Light-mode reading surface: 75% of the way from Squisq's stark `#ffffff`
// `LIGHT_SURFACE.background` toward the gezel app's `--panel` canvas
// (`#f3eddf`). A pure midpoint still read too stark against the cream
// chrome — pushed further toward canvas so the prose sits on warm paper.
// `backgroundLight` follows the same 75/25 lerp against
// `LIGHT_SURFACE.backgroundLight` (`#f5f5f5`) so inset code-block tints
// stay subtly distinct from the surface. Text colors carry over from
// `LIGHT_SURFACE`. Shared by chat bubbles and the Home intro's embedded
// Handboek page so gezel's light reading surfaces never drift apart.
export const GEZEL_LIGHT_SURFACE: SurfaceScheme = {
  id: 'gezel-chat-light',
  background: '#f6f1e7',
  backgroundLight: '#f4efe5',
  text: LIGHT_SURFACE.text,
  textMuted: LIGHT_SURFACE.textMuted,
};

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
