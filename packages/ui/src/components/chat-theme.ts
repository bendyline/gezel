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

import { type Theme, resolveTheme } from '@bendyline/squisq/schemas';

export const GEZEL_CHAT_THEME_ID = 'gezellig';

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
