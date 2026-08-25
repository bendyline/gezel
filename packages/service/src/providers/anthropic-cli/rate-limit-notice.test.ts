import { describe, expect, it } from 'vitest';
import { formatRateLimitNotice } from './rate-limit-notice.js';

const NOW = new Date('2026-08-24T12:00:00').getTime();

function at(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

describe('formatRateLimitNotice', () => {
  it('says nothing on the happy path', () => {
    expect(
      formatRateLimitNotice(
        {
          status: 'allowed',
          rateLimitType: 'five_hour',
          resetsAt: at('2026-08-24T17:00:00'),
          isUsingOverage: false,
        },
        NOW,
        'en-US',
      ),
    ).toBeNull();
  });

  it('says nothing for an empty status', () => {
    expect(
      formatRateLimitNotice(
        { status: '', rateLimitType: 'five_hour', resetsAt: undefined, isUsingOverage: false },
        NOW,
        'en-US',
      ),
    ).toBeNull();
  });

  it('translates a near-limit warning into plain language', () => {
    const notice = formatRateLimitNotice(
      {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        resetsAt: at('2026-08-27T17:00:00'),
        isUsingOverage: false,
      },
      NOW,
      'en-US',
    );
    expect(notice?.text).toBe(
      "You're close to your weekly Claude usage limit. It resets Thursday at 5:00 PM.",
    );
  });

  it('states the consequence and a way forward when the window is used up', () => {
    const notice = formatRateLimitNotice(
      {
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: at('2026-08-24T17:00:00'),
        isUsingOverage: false,
      },
      NOW,
      'en-US',
    );
    expect(notice?.text).toBe(
      "You've used up your 5-hour Claude usage limit. Claude can't answer again until it resets today at 5:00 PM. Switch this gezel to another model to keep working in the meantime.",
    );
  });

  it('appends the overage note', () => {
    const notice = formatRateLimitNotice(
      {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        resetsAt: undefined,
        isUsingOverage: true,
      },
      NOW,
      'en-US',
    );
    expect(notice?.text).toBe(
      "You're close to your weekly Claude usage limit. Usage past the limit is billing to your account as overage.",
    );
  });

  describe('reset phrasing', () => {
    const cases: Array<[string, string]> = [
      ['2026-08-24T17:00:00', 'today at 5:00 PM'],
      ['2026-08-25T09:30:00', 'tomorrow at 9:30 AM'],
      ['2026-08-27T17:00:00', 'Thursday at 5:00 PM'],
      ['2026-09-03T17:00:00', 'on Sep 3 at 5:00 PM'],
    ];
    for (const [iso, expected] of cases) {
      it(`renders ${iso} as "${expected}"`, () => {
        const notice = formatRateLimitNotice(
          {
            status: 'allowed_warning',
            rateLimitType: 'seven_day',
            resetsAt: at(iso),
            isUsingOverage: false,
          },
          NOW,
          'en-US',
        );
        expect(notice?.text).toContain(expected);
      });
    }

    // A boundary just after midnight is "tomorrow", not "today" — the
    // comparison is calendar days, not elapsed hours.
    it('crosses midnight into tomorrow', () => {
      const notice = formatRateLimitNotice(
        {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          resetsAt: at('2026-08-25T00:30:00'),
          isUsingOverage: false,
        },
        new Date('2026-08-24T23:30:00').getTime(),
        'en-US',
      );
      expect(notice?.text).toContain('tomorrow at 12:30 AM');
    });

    it('omits a reset that has already passed', () => {
      const notice = formatRateLimitNotice(
        {
          status: 'allowed_warning',
          rateLimitType: 'seven_day',
          resetsAt: at('2026-08-24T11:00:00'),
          isUsingOverage: false,
        },
        NOW,
        'en-US',
      );
      expect(notice?.text).toBe("You're close to your weekly Claude usage limit.");
    });

    it('omits an unusable reset value', () => {
      const notice = formatRateLimitNotice(
        {
          status: 'allowed_warning',
          rateLimitType: 'seven_day',
          resetsAt: 0,
          isUsingOverage: false,
        },
        NOW,
        'en-US',
      );
      expect(notice?.text).toBe("You're close to your weekly Claude usage limit.");
    });
  });

  describe('window labels', () => {
    const cases: Array<[string | undefined, string]> = [
      ['seven_day', 'weekly'],
      ['five_hour', '5-hour'],
      ['3_hour', '3-hour'],
      ['30_day', '30-day'],
      ['7_day', 'weekly'],
      ['some_new_window', 'some new window'],
      [undefined, 'Claude subscription'],
    ];
    for (const [type, expected] of cases) {
      it(`labels ${String(type)} as "${expected}"`, () => {
        const notice = formatRateLimitNotice(
          {
            status: 'allowed_warning',
            rateLimitType: type,
            resetsAt: undefined,
            isUsingOverage: false,
          },
          NOW,
          'en-US',
        );
        expect(notice?.text).toContain(expected);
      });
    }
  });

  it('keeps an unmodelled status visible rather than paraphrasing it', () => {
    const notice = formatRateLimitNotice(
      {
        status: 'degraded_mode',
        rateLimitType: 'five_hour',
        resetsAt: undefined,
        isUsingOverage: false,
      },
      NOW,
      'en-US',
    );
    expect(notice?.text).toBe(
      'Claude reported an unfamiliar 5-hour usage-limit status: degraded_mode.',
    );
  });

  it('keys the same posture identically and a changed one differently', () => {
    const base = {
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      resetsAt: at('2026-08-27T17:00:00'),
      isUsingOverage: false,
    };
    const a = formatRateLimitNotice(base, NOW, 'en-US');
    const b = formatRateLimitNotice({ ...base }, NOW + 60_000, 'en-US');
    expect(a?.key).toBe(b?.key);
    expect(formatRateLimitNotice({ ...base, status: 'rejected' }, NOW, 'en-US')?.key).not.toBe(
      a?.key,
    );
    expect(formatRateLimitNotice({ ...base, isUsingOverage: true }, NOW, 'en-US')?.key).not.toBe(
      a?.key,
    );
  });
});
