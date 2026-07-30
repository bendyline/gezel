import { describe, expect, it } from 'vitest';
import { pronounFormsForGender, pronounsForGender } from './names.js';

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
