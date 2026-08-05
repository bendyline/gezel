import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickRandomNameWithGender, pronounFormsForGender, pronounsForGender } from './names.js';

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
