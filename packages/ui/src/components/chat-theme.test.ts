import { describe, expect, it } from 'vitest';
import { GEZEL_CHAT_THEME_ID, GEZEL_LIGHT_SURFACE, gezelChatTheme } from './chat-theme.js';

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
