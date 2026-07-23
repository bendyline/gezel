import { describe, expect, it, vi } from 'vitest';
import { pickChatPlaceholder } from './chat-placeholder.js';

describe('pickChatPlaceholder', () => {
  it('substitutes the gezel name for meester variants', () => {
    // Force the "role pool" branch (skip the quirky 15%).
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const text = pickChatPlaceholder({ role: 'meester', gezelName: 'Florian' });
    expect(text).toContain('Florian');
    spy.mockRestore();
  });

  it('substitutes both gezel and project for voorman variants', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const text = pickChatPlaceholder({
      role: 'voorman',
      gezelName: 'Leo',
      projectName: "Eliza's Pet Shop",
    });
    expect(text).toContain('Leo');
    expect(text).toContain("Eliza's Pet Shop");
    spy.mockRestore();
  });

  it('falls back to "this project" for voorman when no project is supplied', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const text = pickChatPlaceholder({ role: 'voorman', gezelName: 'Leo' });
    expect(text).toContain('this project');
    spy.mockRestore();
  });

  it('uses the worker pool for "other" role', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const text = pickChatPlaceholder({ role: 'other', gezelName: 'Ambrose' });
    expect(text).toContain('Ambrose');
    expect(text).not.toContain('project ideas'); // meester copy stays put
    spy.mockRestore();
  });

  it('occasionally serves the quirky universal pool', () => {
    // Force the "quirky" branch (random < 0.15) and a specific pick.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const text = pickChatPlaceholder({ role: 'other', gezelName: 'Tess' });
    expect(text).toContain('Tess');
    spy.mockRestore();
  });

  it('gives image generators directive copy and skips the quirky pool', () => {
    // Even with random in the quirky band, a fixed-function tool wins.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Udom',
      fixedFunctionTool: 'generate_image',
    });
    expect(text).toContain('Udom');
    expect(text.toLowerCase()).toContain('image');
    // No "ask them anything"-style conversational copy.
    expect(text).not.toContain('Fire away');
    spy.mockRestore();
  });

  it('gives video generators video-specific directive copy', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Vesna',
      fixedFunctionTool: 'generate_video',
    });
    expect(text).toContain('Vesna');
    expect(text.toLowerCase()).toContain('video');
    spy.mockRestore();
  });

  it('falls back to generic generator copy for an unknown fixed-function tool', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Pieter',
      fixedFunctionTool: 'web_search',
    });
    expect(text).toContain('Pieter');
    expect(text).toContain('one tool');
    spy.mockRestore();
  });
});
