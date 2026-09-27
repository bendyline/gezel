import { describe, expect, it } from 'vitest';
import {
  MINIMAL_FOOTPRINT_MAX_WINDOW,
  PROMPT_FOOTPRINT_POLICY,
  capAboutForFootprint,
  renderProjectBrief,
  resolvePromptFootprint,
} from './prompt-footprint.js';

describe('prompt footprints', () => {
  it('sizes the prompt from the window first, then from the device', () => {
    expect(resolvePromptFootprint({})).toBe('standard');
    expect(resolvePromptFootprint({ contextWindow: 32768 })).toBe('standard');
    expect(resolvePromptFootprint({ contextWindow: MINIMAL_FOOTPRINT_MAX_WINDOW })).toBe('minimal');
    expect(resolvePromptFootprint({ contextWindow: 4097, constrainedDevice: true })).toBe(
      'compact',
    );
    expect(resolvePromptFootprint({ contextWindow: 2048, constrainedDevice: true })).toBe(
      'minimal',
    );
    // An unknown or nonsense window says nothing about the model.
    expect(resolvePromptFootprint({ contextWindow: 0 })).toBe('standard');
  });

  it('lets an explicit choice win over the window', () => {
    expect(resolvePromptFootprint({ contextWindow: 131072, requested: 'minimal' })).toBe('minimal');
    expect(resolvePromptFootprint({ contextWindow: 2048, requested: 'standard' })).toBe('standard');
  });

  it('only ever shrinks from standard to minimal', () => {
    const { standard, compact, minimal } = PROMPT_FOOTPRINT_POLICY;
    expect(standard.aboutMaxChars).toBeUndefined();
    expect(standard.projectBriefMaxChars).toBeUndefined();
    expect(compact.aboutMaxChars!).toBeGreaterThan(minimal.aboutMaxChars!);
    expect(compact.projectBriefMaxChars!).toBeGreaterThan(minimal.projectBriefMaxChars!);
    expect([standard.textToolListing, compact.textToolListing]).toEqual(['full', 'compact']);
    expect([standard.nativeToolListing, minimal.nativeToolListing]).toEqual(['full', 'compact']);
  });

  it('cuts about.md at a sentence and says it did', () => {
    const about = `${'Tamsin keeps the ledger tidy. '.repeat(20)}She signs every entry.`;
    const capped = capAboutForFootprint(about, 200);
    expect(capped.length).toBeLessThan(about.length);
    expect(capped).toMatch(
      /tidy\.\n\n\(About condensed to fit this model's small context window\.\)$/,
    );
    expect(capAboutForFootprint(about, undefined)).toBe(about);
    expect(capAboutForFootprint('Short.', 200)).toBe('Short.');
  });

  it('keeps both halves of a project brief under one cap', () => {
    const brief = renderProjectBrief(
      {
        about: 'A community garden. '.repeat(30),
        missionObjectives: 'Plant beans in spring. '.repeat(30),
      },
      600,
    );
    expect(brief).toMatch(/^### About this project\nA community garden\./);
    expect(brief).toContain('### Mission objectives\nPlant beans in spring.');
    expect(brief.length).toBeLessThan(700);
    expect(renderProjectBrief({ about: '  ' }, 600)).toBe('');
    expect(renderProjectBrief({ missionObjectives: 'Ship it.' }, undefined)).toBe(
      '### Mission objectives\nShip it.',
    );
  });
});
