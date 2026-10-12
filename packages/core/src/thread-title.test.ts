import { describe, expect, it } from 'vitest';
import {
  THREAD_TITLE_MAX_LENGTH,
  deriveThreadTitle,
  deriveThreadTitleFromMessages,
} from './thread-title.js';

describe('deriveThreadTitle', () => {
  // Keyword extraction titled a first request "Plan trip Lisbon next spring
  // four week" (2026-10-11).
  it('keeps the person’s sentence, cut at a clause when it runs long', () => {
    expect(
      deriveThreadTitle('Plan a trip to Lisbon next spring for the four of us, about a week.'),
    ).toBe('Plan a trip to Lisbon next spring for the four of us');
  });

  it('drops the conversational lead-in, and ends a cut on a word rather than glue', () => {
    expect(
      deriveThreadTitle(
        'Could you please help me fix the authentication timeout when users sign in from mobile?',
      ),
    ).toBe('Fix the authentication timeout when users sign…');
  });

  it('cuts a long sentence with no useful clause at a word, and says so', () => {
    const title = deriveThreadTitle(
      'For thread titles, can we do something here after one or more turns to autosummarize a thread title with a static algorithm?',
    );
    expect(title).toBe('For thread titles, can we do something here after one…');
    expect(title.length).toBeLessThanOrEqual(THREAD_TITLE_MAX_LENGTH);
  });

  it('names a hidden project-page reaction by its page', () => {
    expect(
      deriveThreadTitle('[Checkers page]: Your opponent played c3-d4. Board now: red on c3.'),
    ).toBe('Checkers: Your opponent played c3-d4');
  });

  it('flattens mentions and markdown links without keeping their wire syntax', () => {
    expect(
      deriveThreadTitle(
        'Please ask @[Ada](gezel:ada) to review the [release plan](https://example.test/plan) for API v2.',
      ),
    ).toBe('Ask @Ada to review the release plan for API v2');
  });

  it('keeps a greeting or an all-framing request as written', () => {
    expect(deriveThreadTitle('Hi there!')).toBe('Hi there');
    expect(deriveThreadTitle('Can you help?')).toBe('Can you help');
  });

  it('never exceeds the title limit or cuts a word in half', () => {
    const title = deriveThreadTitle(
      'Investigate extraordinarily-long-authentication-regression-token deployment observability compatibility',
    );
    expect(title.length).toBeLessThanOrEqual(THREAD_TITLE_MAX_LENGTH);
    expect(title).toBe('Investigate…');
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
    ).toBe('Checkers: Your opponent played c3-d4');
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
    ).toBe('Review the release checklist');
  });
});
