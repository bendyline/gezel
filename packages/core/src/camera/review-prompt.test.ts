import { describe, expect, it } from 'vitest';
import { reviewDue, shouldSaveFrame } from './policy.js';
import {
  buildCameraReviewRequest,
  isConfidentYes,
  lookoutConditionQuestion,
  parseCameraReviewAnswer,
  subjectQuestion,
} from './review-prompt.js';

describe('camera review prompt', () => {
  it('keys questions q1..qN and never shows lookout ids to the model', () => {
    const req = buildCameraReviewRequest([
      { id: 'lk-secret-1', question: 'Is a cat squatting on the floor?' },
      { id: 'lk-secret-2', question: 'Is a person at the door?' },
    ]);
    expect(req.user).toContain('q1: Is a cat squatting on the floor?');
    expect(req.user).toContain('q2: Is a person at the door?');
    expect(req.user).not.toContain('lk-secret');
    expect(JSON.stringify(req.schema)).not.toContain('lk-secret');
    expect(req.keys.get('q2')).toBe('lk-secret-2');
    expect((req.schema.required as string[]).includes('answers')).toBe(true);
  });

  it('asks no questions when no lookout needs vision', () => {
    const req = buildCameraReviewRequest([]);
    expect(req.user).not.toContain('q1');
    expect((req.schema.properties as Record<string, unknown>).answers).toBeUndefined();
  });

  it('maps answers back to lookout ids and drops malformed ones', () => {
    const keys = new Map([
      ['q1', 'a'],
      ['q2', 'b'],
      ['q3', 'c'],
    ]);
    const parsed = parseCameraReviewAnswer(
      {
        summary: '  A gray cat\nsquats  near the door. ',
        subjects: ['cat', 7, ''],
        notable: true,
        answers: {
          q1: { match: true, confidence: 'high' },
          q2: { match: 'yes' },
          q3: { match: true },
        },
      },
      keys,
    );
    expect(parsed?.summary).toBe('A gray cat squats near the door.');
    expect(parsed?.subjects).toEqual(['cat']);
    expect(parsed?.answers).toEqual({
      a: { match: true, confidence: 'high' },
      c: { match: true, confidence: 'low' },
    });
    expect(parseCameraReviewAnswer('nope', keys)).toBeNull();
  });

  it('counts a low-confidence match as no', () => {
    expect(isConfidentYes({ match: true, confidence: 'high' })).toBe(true);
    expect(isConfidentYes({ match: true, confidence: 'medium' })).toBe(true);
    expect(isConfidentYes({ match: true, confidence: 'low' })).toBe(false);
    expect(isConfidentYes({ match: false, confidence: 'high' })).toBe(false);
    expect(isConfidentYes(undefined)).toBe(false);
  });

  it('words subject questions plainly', () => {
    expect(subjectQuestion(['cat'])).toBe('Is there a cat in the picture?');
    expect(subjectQuestion(['cat', 'dog', 'person'])).toBe(
      'Is there a cat, a dog or a person in the picture?',
    );
    expect(lookoutConditionQuestion({ kind: 'motion' })).toBeNull();
  });
});

describe('camera storage and review policy', () => {
  it('interval saves on its cadence, motion only during an episode', () => {
    const base = { intervalSeconds: 10, now: 20_000, inEpisode: false };
    expect(shouldSaveFrame({ ...base, policy: 'interval', lastSavedAt: 10_100 })).toBe(true);
    expect(shouldSaveFrame({ ...base, policy: 'interval', lastSavedAt: 15_000 })).toBe(false);
    expect(shouldSaveFrame({ ...base, policy: 'motion', lastSavedAt: undefined })).toBe(false);
    expect(
      shouldSaveFrame({ ...base, policy: 'motion', inEpisode: true, lastSavedAt: undefined }),
    ).toBe(true);
    expect(shouldSaveFrame({ ...base, policy: 'interesting', lastSavedAt: undefined })).toBe(false);
    expect(shouldSaveFrame({ ...base, policy: 'latest-only', lastSavedAt: undefined })).toBe(false);
  });

  it('reviews after the settle delay, then on a cadence, up to a cap', () => {
    expect(reviewDue({ episodeStartedAt: 0, reviews: 0, lastReviewAt: undefined }, 500)).toBe(
      false,
    );
    expect(reviewDue({ episodeStartedAt: 0, reviews: 0, lastReviewAt: undefined }, 1_000)).toBe(
      true,
    );
    expect(reviewDue({ episodeStartedAt: 0, reviews: 1, lastReviewAt: 1_000 }, 10_000)).toBe(false);
    expect(reviewDue({ episodeStartedAt: 0, reviews: 1, lastReviewAt: 1_000 }, 16_000)).toBe(true);
    expect(reviewDue({ episodeStartedAt: 0, reviews: 8, lastReviewAt: 1_000 }, 99_000)).toBe(false);
  });
});
