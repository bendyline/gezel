import { describe, expect, it } from 'vitest';
import { pickChatPlaceholder, taskLaunchPlaceholder } from './chat-placeholder.js';

describe('pickChatPlaceholder', () => {
  it('gives the front door one sentence naming the meester', () => {
    expect(pickChatPlaceholder({ role: 'meester', gezelName: 'Florian' })).toBe(
      'Tell Florian what you want to get done, or ask how things are going.',
    );
  });

  it('substitutes both the crew lead and the project', () => {
    const text = pickChatPlaceholder({
      role: 'voorman',
      gezelName: 'Leo',
      projectName: "Eliza's Pet Shop",
    });
    expect(text).toContain('Leo');
    expect(text).toContain("Eliza's Pet Shop");
  });

  it('falls back to "this project" for a crew lead when no project is supplied', () => {
    expect(pickChatPlaceholder({ role: 'voorman', gezelName: 'Leo' })).toContain('this project');
  });

  it('gives any other crew member its own sentence', () => {
    const text = pickChatPlaceholder({ role: 'other', gezelName: 'Ambrose' });
    expect(text).toContain('Ambrose');
    expect(text).not.toBe(pickChatPlaceholder({ role: 'meester', gezelName: 'Ambrose' }));
  });

  // One Home visit showed five different hints: each time the recipient's
  // details loaded the pool rolled again. A place keeps its sentence.
  it.each(['meester', 'voorman', 'other'] as const)(
    'says the same thing every time for %s',
    (role) => {
      const args = { role, gezelName: 'Malika', projectName: 'Bakery' };
      const first = pickChatPlaceholder(args);
      for (let i = 0; i < 20; i += 1) expect(pickChatPlaceholder(args)).toBe(first);
    },
  );

  // The same crew member read as "her" in one hint and "them" in the next,
  // depending on whether her details had loaded. Hints repeat the name.
  it.each(['meester', 'voorman', 'other'] as const)(
    'names %s rather than guessing a pronoun',
    (role) => {
      const text = pickChatPlaceholder({ role, gezelName: 'Malika', projectName: 'Bakery' });
      expect(text).not.toMatch(/\b(?:she|her|hers|he|him|his|they|them|their)\b/i);
    },
  );

  it('gives image generators directive copy', () => {
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Udom',
      fixedFunctionTool: 'generate_image',
    });
    expect(text).toContain('Udom');
    expect(text.toLowerCase()).toContain('image');
    expect(text).not.toContain('a question');
  });

  it('tells an image editor to attach a picture and say what to change', () => {
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Rembrandt',
      fixedFunctionTool: 'generate_image',
      fixedFunctionEdits: true,
    });
    expect(text).toContain('Rembrandt');
    expect(text).toMatch(/attach/i);
    expect(text).toMatch(/change/i);
  });

  it('tells a video gezel that only animates to attach a picture and say how it moves', () => {
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Vesna',
      fixedFunctionTool: 'generate_video',
      fixedFunctionEdits: true,
    });
    expect(text).toContain('Vesna');
    expect(text).toMatch(/attach/i);
    expect(text).toMatch(/move/i);
    expect(text).not.toMatch(/change/i);
  });

  it('gives video generators video-specific directive copy', () => {
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Vesna',
      fixedFunctionTool: 'generate_video',
    });
    expect(text).toContain('Vesna');
    expect(text.toLowerCase()).toContain('video');
  });

  it('falls back to generic generator copy for an unknown fixed-function tool', () => {
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Pieter',
      fixedFunctionTool: 'web_search',
    });
    expect(text).toContain('Pieter');
    expect(text).toContain('one tool');
  });

  // `gezelName` falls back to the lowercase "your meester" before the real
  // name loads; a hint that opens on the name must still open in capitals.
  describe('sentence casing', () => {
    it.each(['meester', 'voorman', 'other'] as const)('never opens lowercase for %s', (role) => {
      const text = pickChatPlaceholder({
        role,
        gezelName: 'your meester',
        projectName: 'the pet shop',
      });
      expect(text.slice(0, 1)).toBe(text.slice(0, 1).toUpperCase());
    });

    it('capitalizes a lowercase name that opens a generator hint', () => {
      const text = pickChatPlaceholder({
        role: 'other',
        gezelName: 'your meester',
        fixedFunctionTool: 'web_search',
      });
      expect(text.startsWith('Your meester forwards')).toBe(true);
    });

    // The generator copy contains `e.g. "log cabin…"`. A naive
    // capitalize-after-every-period would rewrite the quoted example.
    it('does not treat "e.g." as the end of a sentence', () => {
      const text = pickChatPlaceholder({
        role: 'other',
        gezelName: 'Vesna',
        fixedFunctionTool: 'generate_image',
      });
      expect(text).toContain('e.g. "log cabin under a rainbow."');
      expect(text).not.toContain('e.g. "Log cabin');
    });
  });
});

describe('taskLaunchPlaceholder', () => {
  it('names the attached task and the key that starts it', () => {
    expect(taskLaunchPlaceholder('Accessibility Audit')).toBe(
      'Enter any further instructions here for your Accessibility Audit. Click the ↑ icon to start.',
    );
  });
});
