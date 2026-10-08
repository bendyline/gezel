import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../prompt/instructions.js';
import { estimateTokens } from '../retrieval-budget.js';
import {
  CHARACTER_QUIRKS,
  CHARACTER_SOCIABILITY_MAX,
  CHARACTER_STYLES,
  CHARACTER_TEMPERAMENTS,
  GezelCharacterSchema,
} from '../schemas/character.js';
import {
  QUIRK_EFFECTS,
  STYLE_EFFECTS,
  TEMPERAMENT_EFFECTS,
  characterLengthFactor,
  renderCharacterBlock,
  resolveSocialMode,
  seedCharacter,
  sociabilityEffect,
  withCharacterChatCap,
} from './index.js';

describe('character vocabulary', () => {
  it('gives every value an effect of its own', () => {
    const lines = [
      ...CHARACTER_TEMPERAMENTS.map((value) => TEMPERAMENT_EFFECTS[value].line),
      ...CHARACTER_QUIRKS.map((value) => QUIRK_EFFECTS[value].line),
      ...CHARACTER_STYLES.map((value) => STYLE_EFFECTS[value].line),
      ...[0, 1, 2, 3, 4].map((value) => sociabilityEffect(value).line),
    ];
    for (const line of lines) expect(line.length).toBeGreaterThan(5);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('keeps every combination’s block within 60 tokens', () => {
    let largest = 0;
    for (const temperament of CHARACTER_TEMPERAMENTS)
      for (const quirk of CHARACTER_QUIRKS)
        for (const style of CHARACTER_STYLES)
          for (let sociability = 0; sociability <= CHARACTER_SOCIABILITY_MAX; sociability++)
            largest = Math.max(
              largest,
              estimateTokens(renderCharacterBlock({ temperament, quirk, style, sociability })),
            );
    expect(largest).toBeLessThanOrEqual(60);
  });

  it('seeds the same character for the same id, valid and spread across the vocabulary', () => {
    expect(seedCharacter('wren')).toEqual(seedCharacter('wren'));
    const seeded = Array.from({ length: 600 }, (_, i) => seedCharacter(`gezel-${i}`));
    for (const character of seeded)
      expect(GezelCharacterSchema.parse(character)).toEqual(character);
    expect(new Set(seeded.map((c) => c.temperament)).size).toBe(CHARACTER_TEMPERAMENTS.length);
    expect(new Set(seeded.map((c) => c.quirk)).size).toBe(CHARACTER_QUIRKS.length);
    expect(new Set(seeded.map((c) => c.style)).size).toBe(CHARACTER_STYLES.length);
    expect(new Set(seeded.map((c) => c.sociability)).size).toBe(CHARACTER_SOCIABILITY_MAX + 1);
  });

  it('scales reply length only for the values that say they do', () => {
    expect(
      characterLengthFactor({
        temperament: 'calm',
        quirk: 'frugal',
        style: 'plain',
        sociability: 2,
      }),
    ).toBeCloseTo(0.56);
    expect(
      characterLengthFactor({ temperament: 'warm', quirk: 'tidy', style: 'plain', sociability: 2 }),
    ).toBe(1);
  });
});

describe('the character in the prompt', () => {
  const base = {
    name: 'Wren',
    role: 'Tutor',
    about: 'You teach Spanish.',
    traits: ['Keeps examples short.'],
  };
  const character = seedCharacter('wren');

  it('is absent unless the host passes it (social mode off)', () => {
    expect(buildInstructions(base).full).not.toContain('### Character');
  });

  it('sits after traits in the stable band, and stays in the minimal prompt', () => {
    const built = buildInstructions({ ...base, character, layeredPrefixCache: true });
    expect(built.layers?.gezel).toContain('### Character');
    expect(built.full.indexOf('### Character')).toBeGreaterThan(built.full.indexOf('### Traits'));
    expect(built.full).toContain(QUIRK_EFFECTS[character.quirk].line);
    expect(built.sections.find((s) => s.name === 'character')?.band).toBe('stable');
    expect(buildInstructions({ ...base, character, minimalContext: true }).full).toContain(
      '### Character',
    );
  });

  it('caps a turn tool’s chat line by sociability, and leaves it alone without a character', () => {
    const policy = { toolNames: ['make_move'], maxClosingChars: 600 };
    const plain = { temperament: 'warm', quirk: 'tidy', style: 'plain' } as const;
    expect(withCharacterChatCap(policy, undefined)).toBe(policy);
    expect(withCharacterChatCap(policy, { ...plain, sociability: 0 }).maxClosingChars).toBe(60);
    expect(withCharacterChatCap(policy, { ...plain, sociability: 4 }).maxClosingChars).toBe(440);
    // A calm, frugal gezel says less at the same sociability.
    expect(
      withCharacterChatCap(policy, {
        temperament: 'calm',
        quirk: 'frugal',
        style: 'plain',
        sociability: 4,
      }).maxClosingChars,
    ).toBe(246);
  });

  it('defaults social mode on for phones and off for the desktop', () => {
    expect(resolveSocialMode({}, 'phone')).toBe(true);
    expect(resolveSocialMode({}, 'desktop')).toBe(false);
    expect(resolveSocialMode({ social: true }, 'desktop')).toBe(true);
  });
});
