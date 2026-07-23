import { describe, expect, it } from 'vitest';
import { GEZEL_CHAT_THEME_ID, gezelChatTheme } from './chat-theme.js';

describe('gezelChatTheme', () => {
  it('keeps the gezellig identity without decorative reading-surface textures', () => {
    expect(gezelChatTheme.id).toBe(GEZEL_CHAT_THEME_ID);
    expect(gezelChatTheme.pageStyle?.tokens.pattern).toBe('none');
    expect(gezelChatTheme.persistentLayers).toBeUndefined();
  });
});
