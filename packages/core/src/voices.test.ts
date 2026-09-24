import { describe, expect, it } from 'vitest';
import {
  KOKORO_VOICES,
  findKokoroVoice,
  isValidKokoroVoice,
  pickKokoroVoiceForGender,
} from './voices.js';

describe('Kokoro voice catalog', () => {
  it('keys every voice by a unique id whose prefix encodes language and gender', () => {
    const ids = KOKORO_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const voice of KOKORO_VOICES) {
      const [lang, gender] = voice.id;
      expect(lang === 'a' ? 'en-US' : 'en-GB', voice.id).toBe(voice.language);
      expect(gender === 'f' ? 'female' : 'male', voice.id).toBe(voice.gender);
    }
  });

  it('looks voices up by id', () => {
    expect(findKokoroVoice('af_heart')).toMatchObject({ name: 'Heart', grade: 'A' });
    expect(findKokoroVoice('zz_nobody')).toBeUndefined();
    expect(isValidKokoroVoice('bm_george')).toBe(true);
    expect(isValidKokoroVoice('zz_nobody')).toBe(false);
  });
});

describe('pickKokoroVoiceForGender', () => {
  it('is deterministic for a given seed', () => {
    for (const seed of [0, 1, 42, 0xffffffff]) {
      expect(pickKokoroVoiceForGender('female', { seed })).toBe(
        pickKokoroVoiceForGender('female', { seed }),
      );
    }
  });

  it('draws only from the matching gender pool', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      expect(findKokoroVoice(pickKokoroVoiceForGender('male', { seed }))?.gender).toBe('male');
      expect(findKokoroVoice(pickKokoroVoiceForGender('female', { seed }))?.gender).toBe('female');
    }
  });

  it('draws from the whole catalog for non-binary or unknown gender', () => {
    const genders = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      genders.add(findKokoroVoice(pickKokoroVoiceForGender('non-binary', { seed }))!.gender);
      expect(isValidKokoroVoice(pickKokoroVoiceForGender(undefined, { seed }))).toBe(true);
    }
    expect(genders).toEqual(new Set(['male', 'female']));
  });

  it('leans toward higher-graded voices', () => {
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 2_000; seed += 1) {
      const id = pickKokoroVoiceForGender('female', { seed });
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.get('af_heart') ?? 0).toBeGreaterThan(counts.get('af_river') ?? 0);
  });

  it('falls back to Math.random without a seed', () => {
    expect(isValidKokoroVoice(pickKokoroVoiceForGender('male'))).toBe(true);
  });
});
