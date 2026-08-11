import { describe, expect, it } from 'vitest';
import {
  THREAD_TITLE_MAX_LENGTH,
  deriveThreadTitle,
  deriveThreadTitleFromMessages,
} from './thread-title.js';

describe('deriveThreadTitle', () => {
  it('drops conversational framing and keeps the distinguishing topic words', () => {
    expect(
      deriveThreadTitle(
        'Could you please help me fix the authentication timeout when users sign in from mobile?',
      ),
    ).toBe('Fix authentication timeout users sign mobile');
  });

  it('lets repeated subject words and specific terms win in a long starter', () => {
    expect(
      deriveThreadTitle(
        'For thread titles, can we do something here after one or more turns to autosummarize a thread title with a static algorithm that plucks valuable words from the thread starter?',
      ),
    ).toBe('Thread titles autosummarize static algorithm valuable');
  });

  it('turns a hidden project-page reaction into a useful game title', () => {
    expect(
      deriveThreadTitle('[Checkers page]: Your opponent played c3-d4. Board now: red on c3.'),
    ).toBe('Checkers opponent played c3-d4');
  });

  it('flattens mentions and markdown links without keeping their wire syntax', () => {
    expect(
      deriveThreadTitle(
        'Please ask @[Ada](gezel:ada) to review the [release plan](https://example.test/plan) for API v2.',
      ),
    ).toBe('Ask @Ada review release plan API v2');
  });

  it('falls back to recognizable source text when every word is conversational', () => {
    expect(deriveThreadTitle('Hi there!')).toBe('Hi there');
  });

  it('never exceeds the title limit or cuts the selected words in half', () => {
    const title = deriveThreadTitle(
      'Investigate extraordinarily-long-authentication-regression-token deployment observability compatibility',
    );
    expect(title.length).toBeLessThanOrEqual(THREAD_TITLE_MAX_LENGTH);
    expect(title.endsWith('extraordinarily-long-authentication-reg')).toBe(false);
  });
});

describe('deriveThreadTitleFromMessages', () => {
  const at = '2026-08-11T12:00:00.000Z';

  it('uses a hidden reaction starter once a real assistant turn exists', () => {
    expect(
      deriveThreadTitleFromMessages(
        [
          {
            role: 'user',
            content: '[Checkers page]: Your opponent played c3-d4.',
            at,
            hidden: true,
          },
          { role: 'assistant', content: 'I play d6-c5.', at },
        ],
        { requireCompletedTurn: true },
      ),
    ).toBe('Checkers opponent played c3-d4');
  });

  it('does not rename an empty or passive-CC-only thread in list views', () => {
    expect(deriveThreadTitleFromMessages([], { requireCompletedTurn: true })).toBeNull();
    expect(
      deriveThreadTitleFromMessages([{ role: 'user', content: '@Ada can you take this?', at }], {
        requireCompletedTurn: true,
      }),
    ).toBeNull();
  });

  it('can name a just-started direct turn before its reply arrives', () => {
    expect(
      deriveThreadTitleFromMessages([
        { role: 'user', content: 'Please review the release checklist', at },
      ]),
    ).toBe('Review release checklist');
  });
});
