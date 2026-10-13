import { describe, expect, it } from 'vitest';
import {
  GEZEL_CHAT_THEME_ID,
  GEZEL_LIGHT_SURFACE,
  gezelChatTheme,
  gezelChatThemeForMode,
} from './chat-theme.js';

describe('gezelChatTheme', () => {
  it('keeps the gezellig identity without decorative reading-surface textures', () => {
    expect(gezelChatTheme.id).toBe(GEZEL_CHAT_THEME_ID);
    expect(gezelChatTheme.pageStyle?.tokens.pattern).toBe('none');
    expect(gezelChatTheme.persistentLayers).toBeUndefined();
  });

  it('uses the warm mushroom-beige reading surface', () => {
    expect(GEZEL_LIGHT_SURFACE.background).toBe('#f1e9e1');
    expect(GEZEL_LIGHT_SURFACE.backgroundLight).toBe('#e8dfd7');
  });
});

// WCAG relative luminance for the actual palette colors, not a token-name test.
function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

it.each(['light', 'dark'] as const)(
  'keeps default reading links above 4.5:1 on %s paper',
  (mode) => {
    const theme = gezelChatThemeForMode(mode);
    const ink = luminance(theme.colors.primary);
    const paper = mode === 'light' ? GEZEL_LIGHT_SURFACE : theme.colors;
    for (const background of [paper.background, paper.backgroundLight]) {
      const bg = luminance(background);
      expect((Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  },
);
