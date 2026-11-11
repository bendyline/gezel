import { describe, expect, it } from 'vitest';
import {
  GEZEL_CHAT_THEME_ID,
  GEZEL_LIGHT_SURFACE,
  GEZEL_REPORT_FONT,
  gezelChatTheme,
  gezelChatThemeForMode,
  gezelReportThemeForMode,
} from './chat-theme.js';

describe('gezelChatTheme', () => {
  it('keeps the gezellig identity without decorative reading-surface textures', () => {
    expect(gezelChatTheme.id).toBe(GEZEL_CHAT_THEME_ID);
    expect(gezelChatTheme.pageStyle?.tokens.pattern).toBe('none');
    expect(gezelChatTheme.persistentLayers).toBeUndefined();
  });

  it('uses the quiet cream reading surface', () => {
    expect(GEZEL_LIGHT_SURFACE.background).toBe('#eeeae1');
    expect(GEZEL_LIGHT_SURFACE.backgroundLight).toBe('#e5e0d6');
  });
});

describe.each(['light', 'dark'] as const)('gezelReportThemeForMode(%s)', (mode) => {
  it('sets reports in the app sans and leaves chat in the serif', () => {
    const report = gezelReportThemeForMode(mode);
    const chat = gezelChatThemeForMode(mode);
    expect(report.typography.titleFont).toEqual(GEZEL_REPORT_FONT);
    expect(report.typography.bodyFont).toEqual(GEZEL_REPORT_FONT);
    expect(chat.typography.titleFont).not.toEqual(GEZEL_REPORT_FONT);
    expect(report.colors).toEqual(chat.colors);
    expect(report.pageStyle).toEqual(chat.pageStyle);
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
