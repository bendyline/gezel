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

  it.each([
    ['male', 0.6, 'need him'],
    ['female', 0.6, 'need her'],
    ['non-binary', 0.6, 'need them'],
    [undefined, 0.6, 'need them'],
    ['female', 0.3, 'hand her'],
    ['female', 0.9, 'she has shipped'],
  ] as const)('uses %s pronouns in worker copy', (gezelGender, poolPick, expected) => {
    const spy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.2).mockReturnValueOnce(poolPick);
    const text = pickChatPlaceholder({
      role: 'other',
      gezelName: 'Lyudmyla',
      gezelGender,
    });
    expect(text).toContain(expected);
    spy.mockRestore();
  });

  it('uses assigned possessive and subject pronouns in voorman copy', () => {
    const possessiveSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.5);
    expect(
      pickChatPlaceholder({
        role: 'voorman',
        gezelName: 'Lyudmyla',
        gezelGender: 'female',
        projectName: 'Launch',
      }),
    ).toContain('approve her latest move');
    possessiveSpy.mockRestore();

    const subjectSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.2).mockReturnValueOnce(0.7);
    expect(
      pickChatPlaceholder({
        role: 'voorman',
        gezelName: 'Owen',
        gezelGender: 'male',
        projectName: 'Launch',
      }),
    ).toContain('he will either know');
    subjectSpy.mockRestore();
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

  // Substituted values are not reliably capitalized: `gezelName` falls back to
  // the lowercase "your meester" before the real name loads, and every pronoun
  // form is lowercase. Templates that drop one straight after a sentence break
  // used to render "…idea? your meester will help…" on the front door.
  describe('sentence casing', () => {
    /** Every sentence opener in the string, ignoring known abbreviations. */
    function sentenceOpeners(text: string): string[] {
      return [
        text.slice(0, 1),
        ...[...text.matchAll(/(?:^|([^\s]*[.?!]["')\]]?)\s+)(\S)/gu)]
          .filter(
            (m) => !m[1] || !/\b(?:e\.g|i\.e|etc|vs|approx|no|fig|Mr|Mrs|Ms|Dr|St)\.$/i.test(m[1]),
          )
          .map((m) => m[2] ?? ''),
      ].filter(Boolean);
    }

    /** Walk every variant of a pool by pinning the index-picking random. */
    function eachVariant(pick: (poolPick: number) => string, poolSize = 8): string[] {
      const out: string[] = [];
      for (let i = 0; i < poolSize; i += 1) out.push(pick((i + 0.5) / poolSize));
      return out;
    }

    // The exact reported defect.
    it('capitalizes a lowercase name that lands after a question mark', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.2).mockReturnValueOnce(0.65);
      const text = pickChatPlaceholder({ role: 'meester', gezelName: 'your meester' });
      spy.mockRestore();
      expect(text).toContain('Got a half-baked idea? Your meester will help');
      expect(text).not.toContain('? your meester');
    });

    it.each(['meester', 'voorman', 'other'] as const)(
      'never opens a sentence lowercase for %s, whatever the pool serves',
      (role) => {
        const texts = eachVariant((poolPick) => {
          const spy = vi
            .spyOn(Math, 'random')
            .mockReturnValueOnce(0.2)
            .mockReturnValueOnce(poolPick);
          const t = pickChatPlaceholder({
            role,
            gezelName: 'your meester',
            gezelGender: 'female',
            projectName: 'the pet shop',
          });
          spy.mockRestore();
          return t;
        });
        for (const text of texts) {
          for (const opener of sentenceOpeners(text)) {
            expect(opener, `lowercase sentence opener in: ${text}`).toBe(opener.toUpperCase());
          }
        }
      },
    );

    it('leaves the quirky pool sentence-cased too', () => {
      const texts = eachVariant((poolPick) => {
        const spy = vi
          .spyOn(Math, 'random')
          .mockReturnValueOnce(0.01)
          .mockReturnValueOnce(poolPick);
        const t = pickChatPlaceholder({ role: 'other', gezelName: 'your meester' });
        spy.mockRestore();
        return t;
      });
      for (const text of texts) {
        for (const opener of sentenceOpeners(text)) {
          expect(opener, `lowercase sentence opener in: ${text}`).toBe(opener.toUpperCase());
        }
      }
    });

    // The generator copy contains `e.g. "log cabin…"`. A naive
    // capitalize-after-every-period would rewrite the quoted example.
    it('does not treat "e.g." as the end of a sentence', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.2);
      const text = pickChatPlaceholder({
        role: 'other',
        gezelName: 'Vesna',
        fixedFunctionTool: 'generate_image',
      });
      spy.mockRestore();
      expect(text).toContain('e.g. "log cabin under a rainbow."');
      expect(text).not.toContain('e.g. "Log cabin');
    });
  });
});
