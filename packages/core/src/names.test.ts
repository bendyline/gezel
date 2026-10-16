import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  femaleNames,
  gezelNamesInUse,
  pickRandomNameWithGender,
  pickUnusedGezelName,
  pickUnusedSuggestedName,
  pronounFormsForGender,
  pronounsForGender,
} from './names.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gezel pronouns', () => {
  it.each([
    ['male', 'he/him', 'he', 'him', 'his', 'himself', 'is', 'has'],
    ['female', 'she/her', 'she', 'her', 'her', 'herself', 'is', 'has'],
    ['non-binary', 'they/them', 'they', 'them', 'their', 'themselves', 'are', 'have'],
  ] as const)(
    'maps %s to complete grammatical forms',
    (gender, label, subject, object, possessiveAdjective, reflexive, presentBe, presentHave) => {
      expect(pronounsForGender(gender)).toBe(label);
      expect(pronounFormsForGender(gender)).toMatchObject({
        subject,
        object,
        possessiveAdjective,
        reflexive,
        presentBe,
        presentHave,
      });
    },
  );

  it('uses neutral forms for a legacy gezel without an assigned gender', () => {
    expect(pronounFormsForGender(undefined)).toEqual(pronounFormsForGender('non-binary'));
  });
});

describe('random gezel names', () => {
  it('sets the gender to non-binary within the 4% roll', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.039);

    expect(pickRandomNameWithGender().gender).toBe('non-binary');
  });

  it('keeps the name-derived gender at the 4% boundary', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.04);

    expect(pickRandomNameWithGender().gender).toBe('female');
  });
});

describe('unused gezel names', () => {
  /** One `pickRandomNameWithGender` draw of `femaleNames[index]`, no NB flip. */
  const drawFemale = (index: number) => [0.25, (index + 0.5) / femaleNames.length, 0.5];

  it('counts ids and the ids names would slug to as taken', () => {
    expect(gezelNamesInUse([{ id: 'yujin-2', name: 'Yujin Park' }])).toEqual(
      new Set(['yujin-2', 'yujin-park']),
    );
  });

  it('draws again when the name is already on the crew', () => {
    const random = vi.spyOn(Math, 'random');
    for (const value of [...drawFemale(0), ...drawFemale(1)]) random.mockReturnValueOnce(value);
    const inUse = gezelNamesInUse([{ id: 'boekwachter', name: femaleNames[0]! }]);

    expect(pickUnusedGezelName(inUse).name).toBe(femaleNames[1]);
  });

  it('prefers a template suggestion nobody has yet', () => {
    const inUse = gezelNamesInUse([{ id: 'picasso', name: 'Picasso' }]);

    expect(pickUnusedSuggestedName(['Picasso', 'Vermeer'], inUse).name).toBe('Vermeer');
  });

  it('falls back to an unused random name once every suggestion is taken', () => {
    const inUse = gezelNamesInUse([
      { id: 'picasso', name: 'Picasso' },
      { id: 'vermeer', name: 'Vermeer' },
    ]);

    expect(['Picasso', 'Vermeer']).not.toContain(
      pickUnusedSuggestedName(['Picasso', 'Vermeer'], inUse).name,
    );
  });
});
