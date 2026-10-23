import { describe, expect, it } from 'vitest';
import { echoScore, matchEarlierLead } from './echo.js';

const lead = (message: string, category = 'bug', line?: number) => ({
  severity: 'minor' as const,
  category,
  message,
  ...(line !== undefined ? { line } : {}),
});

describe('telling a reworded lead from a different one', () => {
  it('links a rewording of the same lead', () => {
    expect(
      echoScore(
        lead(
          'The loop in `saveRows` stops one item early, so the last row is never saved.',
          'bug',
          40,
        ),
        lead('`saveRows` loop stops one item early and never saves the last row.', 'bug', 42),
      ),
    ).not.toBeNull();
  });

  it('keeps leads about different names apart, however alike the words', () => {
    expect(
      echoScore(
        lead('Unhandled rejection in `fetchUser`.'),
        lead('Unhandled rejection in `saveUser`.'),
      ),
    ).toBeNull();
    expect(
      echoScore(
        lead('Unhandled rejection in fetchUser.'),
        lead('Unhandled rejection in saveUser.'),
      ),
    ).toBeNull();
  });

  it('keeps leads apart across categories and distant lines', () => {
    expect(
      echoScore(
        lead('Missing null check on input.', 'bug'),
        lead('Missing null check on input.', 'smell'),
      ),
    ).toBeNull();
    expect(
      echoScore(
        lead('Missing null check on input.', 'bug', 10),
        lead('Missing null check on input.', 'bug', 90),
      ),
    ).toBeNull();
  });

  it('treats "error handling" and "error_handling" as one category', () => {
    expect(
      echoScore(
        lead('No catch around the parse.', 'error handling'),
        lead('No catch around the parse.', 'error_handling'),
      ),
    ).not.toBeNull();
  });

  it('picks the closest earlier lead', () => {
    const earlier = [
      { ...lead('The config file is read without checking it exists.'), ref: 'BW-1' },
      { ...lead('The config file is read twice on startup without caching.'), ref: 'BW-2' },
    ];
    expect(
      matchEarlierLead(lead('Reads the config file twice at startup, no caching.'), earlier)?.ref,
    ).toBe('BW-2');
    expect(matchEarlierLead(lead('Something unrelated about rendering.'), earlier)).toBeNull();
  });
});
