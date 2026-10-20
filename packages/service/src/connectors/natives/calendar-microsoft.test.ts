import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { FakeGraphCalendar } from '../testing/fake-graph-calendar.js';
import { status } from '../testing/fake-http.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import type { ConnectorBindingRef } from '../types.js';
import {
  MicrosoftCalendarAdapter,
  microsoftCalendarScope,
  trustedGraphUrl,
} from './calendar-microsoft.js';
import { ReconnectRequiredError } from './oauth-session.js';

const DAY = 86_400_000;
const REQUIRED_KEYS = ['title', 'date', 'all_day', 'status', 'calendar', 'provider', 'event_id'];

function at(startMs: number, minutes = 30): { start: string; end: string } {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + minutes * 60_000).toISOString(),
  };
}

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'calendar-microsoft:test', type: 'calendar-microsoft', config };
}

interface World {
  env: ConnectorTestEnv;
  fake: FakeGraphCalendar;
  b: ConnectorBindingRef;
  main: string;
  birthdays: string;
  adapter(opts?: { now?: () => number }): MicrosoftCalendarAdapter;
}

async function world(config: Record<string, unknown> = {}, fakeOpts = {}): Promise<World> {
  const env = await createConnectorTestEnv();
  const fake = new FakeGraphCalendar(fakeOpts);
  const main = fake.addCalendar({ name: 'Calendar', isDefaultCalendar: true });
  const birthdays = fake.addCalendar({ name: 'Birthdays' });
  const b = binding(config);
  await env.storeCredential(b, fake.credential());
  return {
    env,
    fake,
    b,
    main,
    birthdays,
    adapter: (opts) => new MicrosoftCalendarAdapter(b, env.deps({ fetch: fake.http.fetch }), opts),
  };
}

function deltaRequests(fake: FakeGraphCalendar) {
  return fake.http.calls.filter((c) => c.url.pathname.endsWith('/calendarView/delta'));
}

function scopeCursor(cursor: unknown, scope: string): Record<string, unknown> | undefined {
  return (cursor as { scopes: Record<string, Record<string, unknown>> }).scopes[scope];
}

describeConnectorConformance('calendar-microsoft', {
  async create() {
    const w = await world();
    const now = Date.now();
    const seed = (cal: string, day: number, subject: string) =>
      w.fake.addEvent(cal, {
        subject,
        body: { contentType: 'html', content: `<p>Notes for <b>${subject}</b></p>` },
        ...at(now + day * DAY),
      });
    seed(w.main, 1, 'Standup');
    seed(w.main, 2, 'Design review');
    seed(w.main, 3, '1:1 with Grace');
    seed(w.birthdays, 1, "Charles's birthday");
    seed(w.birthdays, 4, "Mary's birthday");
    let added = 0;
    const first = () => w.fake.events(w.main)[0]!;
    return {
      env: w.env,
      seeded: 5,
      requiredKeys: REQUIRED_KEYS,
      adapter: async () => w.adapter(),
      unrouted: () => w.fake.http.unrouted,
      hooks: {
        add(n = 1) {
          for (let i = 0; i < n; i++) {
            added++;
            w.fake.addEvent(w.main, { subject: `Added ${added}`, ...at(now + (10 + added) * DAY) });
          }
        },
        update() {
          w.fake.updateEvent(w.main, first().id, {
            subject: 'Standup (moved room)',
            location: 'Room 4',
          });
        },
        remove() {
          w.fake.deleteEvent(w.main, first().id);
        },
        move() {
          w.fake.updateEvent(w.main, first().id, at(now + 45 * DAY));
        },
        expireCursor() {
          w.fake.expireDeltaTokens();
        },
        throttleNextList() {
          w.fake.http.failNext({ url: /calendarView\/delta/ }, () =>
            status(
              429,
              { error: { code: 'TooManyRequests', message: 'Too many requests' } },
              {
                'retry-after': '1',
              },
            ),
          );
        },
        async revokeAuth() {
          w.fake.tokens.rejectRefresh = true;
          w.fake.revokeAccessTokens();
          await w.env.storeCredential(
            w.b,
            w.fake.credential({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
          );
        },
        addHostile() {
          w.fake.addEvent(w.main, {
            subject: HOSTILE_NAME,
            location: HOSTILE_NAME,
            body: { contentType: 'html', content: `<div><p>${INJECTION_PAYLOAD}</p></div>` },
            ...at(now + 5 * DAY),
          });
        },
      },
    };
  },
});

describe('MicrosoftCalendarAdapter', () => {
  let w: World | null = null;
  afterEach(async () => {
    expect(w?.fake.http.unrouted ?? []).toEqual([]);
    await w?.env.dispose();
    w = null;
  });

  async function pass(adapter: MicrosoftCalendarAdapter, cursor: unknown, backfillLimit = 500) {
    return syncWithAdapter(adapter, {
      storageDir: w!.env.artifactsDir,
      quarantineDir: w!.env.quarantineDir,
      corpusDir: 'data/outlook',
      backfillLimit,
      cursor,
    });
  }

  it('pages a delta round through nextLinks and keeps only the final deltaLink', async () => {
    w = await world({ calendars: ['Calendar'] });
    const now = Date.now();
    for (let i = 0; i < 250; i++)
      w.fake.addEvent(w.main, { subject: `Slot ${i}`, ...at(now + i * 3_600_000) });
    const scope = microsoftCalendarScope(w.main);

    const first = await pass(w.adapter(), undefined);
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(250);
    const cursor = scopeCursor(first.cursor, scope)!;
    expect(cursor.delta).toMatch(/\$deltatoken=/);
    expect(cursor.next).toBeUndefined();

    const calls = deltaRequests(w.fake);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.searchParams.get('startDateTime')).toBeTruthy();
    expect(calls[0]!.url.searchParams.get('endDateTime')).toBeTruthy();
    expect(calls[0]!.url.searchParams.has('$select')).toBe(false);
    expect(calls[1]!.url.searchParams.get('$skiptoken')).toBeTruthy();
    for (const c of calls) expect(c.headers.get('prefer')).toBe('odata.maxpagesize=100');

    const second = await pass(w.adapter(), first.cursor);
    expect(second.written).toBe(0);
    expect(deltaRequests(w.fake)[3]!.url.searchParams.get('$deltatoken')).toBeTruthy();
  });

  it('honors a small engine batch by returning partial rounds that resume at the nextLink', async () => {
    w = await world({ calendars: ['Calendar'] });
    const now = Date.now();
    for (let i = 0; i < 23; i++)
      w.fake.addEvent(w.main, { subject: `Slot ${i}`, ...at(now + i * DAY) });
    const adapter = w.adapter();
    await adapter.ensureAuth();
    const scope = (await adapter.listScopes())[0]!;
    const seen: string[] = [];
    let cursor: unknown;
    for (let round = 0; round < 20; round++) {
      const batch = await adapter.listChangesSince(scope, cursor, { limit: 5 });
      expect(batch.records.length).toBeLessThanOrEqual(5);
      seen.push(...batch.records.map((r) => r.id));
      cursor = batch.cursor;
      if (!batch.partial) break;
    }
    expect(new Set(seen).size).toBe(23);
    expect(seen).toHaveLength(23);
    expect(cursor).toMatchObject({ delta: expect.stringContaining('$deltatoken=') });
  });

  it('turns @removed and cancelled meetings into tombstones', async () => {
    w = await world({ calendars: ['Calendar'] });
    const now = Date.now();
    const keep = w.fake.addEvent(w.main, { subject: 'Keep', ...at(now + DAY) });
    const deleted = w.fake.addEvent(w.main, { subject: 'Deleted', ...at(now + 2 * DAY) });
    const cancelled = w.fake.addEvent(w.main, { subject: 'Cancelled', ...at(now + 3 * DAY) });
    const first = await pass(w.adapter(), undefined);
    expect(first.written).toBe(3);

    w.fake.deleteEvent(w.main, deleted.id);
    w.fake.cancelMeeting(w.main, cancelled.id);
    const scope = microsoftCalendarScope(w.main);
    const adapter = w.adapter();
    await adapter.ensureAuth();
    await adapter.listScopes();
    const batch = await adapter.listChangesSince(scope, scopeCursor(first.cursor, scope));
    expect(batch.records).toEqual([]);
    expect(batch.removed?.sort()).toEqual(
      [`${w.main}:${deleted.id}`, `${w.main}:${cancelled.id}`].sort(),
    );

    const second = await pass(w.adapter(), first.cursor);
    expect(second.pruned).toBe(2);
    const left = await readCorpus(w.env.artifactsDir, 'data/outlook');
    expect(left.map((r) => r.frontmatter.event_id)).toEqual([keep.id]);
  });

  it('tombstones an event rescheduled outside the round range', async () => {
    const t0 = Date.UTC(2026, 9, 19, 15, 0, 0);
    w = await world({ calendars: ['Calendar'], futureDays: 30 });
    const e = w.fake.addEvent(w.main, { subject: 'Moves out', ...at(t0 + 5 * DAY) });
    const now = () => t0;
    const first = await pass(w.adapter({ now }), undefined);
    expect(first.written).toBe(1);
    w.fake.updateEvent(w.main, e.id, at(t0 + 90 * DAY));
    const second = await pass(w.adapter({ now }), first.cursor);
    expect(second.pruned).toBe(1);
    expect(await readCorpus(w.env.artifactsDir, 'data/outlook')).toEqual([]);
  });

  it('starts a fresh round in the same pass when the delta state expired (410)', async () => {
    w = await world({ calendars: ['Calendar'] });
    const now = Date.now();
    w.fake.addEvent(w.main, { subject: 'Kickoff', ...at(now + DAY) });
    const first = await pass(w.adapter(), undefined);
    w.fake.expireDeltaTokens();
    w.fake.addEvent(w.main, { subject: 'Follow-up', ...at(now + 2 * DAY) });
    const before = deltaRequests(w.fake).length;
    const second = await pass(w.adapter(), first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(1);
    const after = deltaRequests(w.fake).slice(before);
    expect(after[0]!.url.searchParams.get('$deltatoken')).toBeTruthy();
    expect(after[1]!.url.searchParams.get('startDateTime')).toBeTruthy();
  });

  it('slides the window by starting a new round once a completed one is a week stale', async () => {
    const t0 = Date.UTC(2026, 9, 19, 15, 0, 0);
    w = await world({ calendars: ['Calendar'], futureDays: 60 });
    w.fake.addEvent(w.main, { subject: 'Soon', ...at(t0 + DAY) });
    let clock = t0;
    const now = () => clock;
    const first = await pass(w.adapter({ now }), undefined);
    clock = t0 + 8 * DAY;
    w.fake.addEvent(w.main, { subject: 'Newly in range', ...at(t0 + 66 * DAY) });
    const before = deltaRequests(w.fake).length;
    const second = await pass(w.adapter({ now }), first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(1);
    const after = deltaRequests(w.fake).slice(before);
    expect(after[0]!.url.searchParams.get('$deltatoken')).toBeTruthy();
    expect(after[1]!.url.searchParams.get('endDateTime')).toBe('2026-12-27T00:00:00Z');
  });

  it('refuses a pagination link off the Graph origin and never sends the token there', async () => {
    w = await world(
      { calendars: ['Calendar'] },
      { linkOrigin: 'https://graph.microsoft.com.evil.example' },
    );
    const now = Date.now();
    w.fake.defaultPageSize = 2;
    for (let i = 0; i < 5; i++) w.fake.addEvent(w.main, { subject: `E${i}`, ...at(now + i * DAY) });
    const adapter = w.adapter();
    await adapter.ensureAuth();
    const scope = (await adapter.listScopes())[0]!;
    await expect(adapter.listChangesSince(scope, undefined, { limit: 1 })).rejects.toThrow(
      /untrusted Microsoft Graph pagination URL/,
    );
    expect(
      w.fake.http.calls.every((c) => c.url.origin !== 'https://graph.microsoft.com.evil.example'),
    ).toBe(true);
    expect(() => trustedGraphUrl('https://graph.microsoft.com/v1.0/users/x/events')).toThrow();
    expect(() => trustedGraphUrl('http://graph.microsoft.com/v1.0/me/events')).toThrow();
    expect(
      trustedGraphUrl('https://graph.microsoft.com/v1.0/me/calendars/a/calendarView/delta'),
    ).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\//);
  });

  it('gives calendars that share a long id prefix their own stable folders', async () => {
    w = await world();
    const now = Date.now();
    expect(w.main.slice(0, 48)).toBe(w.birthdays.slice(0, 48));
    w.fake.addEvent(w.main, { subject: 'Standup', ...at(now + DAY) });
    w.fake.addEvent(w.birthdays, { subject: "Ada's birthday", ...at(now + DAY) });
    const r = await pass(w.adapter(), undefined);
    expect(r.scopes).toEqual([microsoftCalendarScope(w.main), microsoftCalendarScope(w.birthdays)]);
    const records = await readCorpus(w.env.artifactsDir, 'data/outlook');
    const folders = new Set(records.map((x) => x.path.split('/')[0]));
    expect(folders.size).toBe(2);
    expect(records.map((x) => x.frontmatter.calendar).sort()).toEqual(['Birthdays', 'Calendar']);
  });

  it('selects configured calendars by name or id, and says so when none match', async () => {
    w = await world({ calendars: ['birthdays'] });
    const adapter = w.adapter();
    await adapter.ensureAuth();
    expect(await adapter.listScopes()).toEqual([microsoftCalendarScope(w.birthdays)]);

    const byId = new MicrosoftCalendarAdapter(
      binding({ calendars: [w.main] }),
      w.env.deps({ fetch: w.fake.http.fetch }),
    );
    expect(await byId.listScopes()).toEqual([microsoftCalendarScope(w.main)]);

    const none = new MicrosoftCalendarAdapter(
      binding({ calendars: ['Holidays'] }),
      w.env.deps({ fetch: w.fake.http.fetch }),
    );
    await expect(none.listScopes()).rejects.toThrow(
      /None of the configured calendars \(Holidays\)/,
    );
  });

  it('reports a throttled first page as backpressure and keeps the cursor', async () => {
    w = await world({ calendars: ['Calendar'] });
    w.fake.addEvent(w.main, { subject: 'One', ...at(Date.now() + DAY) });
    const first = await pass(w.adapter(), undefined);
    w.fake.http.failNext({ url: /calendarView\/delta/ }, () =>
      status(503, { error: { code: 'ServiceUnavailable', message: 'Service Unavailable' } }),
    );
    const throttled = await pass(w.adapter(), first.cursor);
    expect(throttled.rateLimited).toBe(true);
    expect(throttled.error).toBeUndefined();
    expect(throttled.cursor).toEqual(first.cursor);
  });

  it('keeps the pages that landed when a later page is throttled', async () => {
    w = await world({ calendars: ['Calendar'] });
    const now = Date.now();
    for (let i = 0; i < 150; i++)
      w.fake.addEvent(w.main, { subject: `E${i}`, ...at(now + i * 3_600_000) });
    const adapter = w.adapter();
    await adapter.ensureAuth();
    const scope = (await adapter.listScopes())[0]!;
    w.fake.http.failNext({ url: /\$skiptoken=/ }, () =>
      status(429, { error: { code: 'TooManyRequests', message: 'Too many requests' } }),
    );
    const batch = await adapter.listChangesSince(scope, undefined, { limit: 500 });
    expect(batch.rateLimited).toBe(true);
    expect(batch.records).toHaveLength(100);
    expect(batch.cursor).toMatchObject({ next: expect.stringContaining('$skiptoken=') });
  });

  it('a revoked refresh token fails with an actionable reconnect error', async () => {
    w = await world({ calendars: ['Calendar'] });
    w.fake.tokens.rejectRefresh = true;
    await w.env.storeCredential(
      w.b,
      w.fake.credential({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await expect(w.adapter().ensureAuth()).rejects.toBeInstanceOf(ReconnectRequiredError);
    const r = await pass(w.adapter(), undefined);
    expect(r.error).toMatch(/Microsoft sign-in .* Re-link the account/);
  });

  it('persists the rotated refresh token Microsoft issues on refresh', async () => {
    w = await world({ calendars: ['Calendar'] });
    w.fake.addEvent(w.main, { subject: 'One', ...at(Date.now() + DAY) });
    const seeded = w.fake.credential({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await w.env.storeCredential(w.b, seeded);
    const r = await pass(w.adapter(), undefined);
    expect(r.error).toBeUndefined();
    const stored = await w.env.readCredential<{ refreshToken: string; accessToken: string }>(w.b);
    expect(stored?.refreshToken).not.toBe(seeded.refreshToken);
    expect(stored?.accessToken).toMatch(/^access-/);
    // The rotated-away token is dead; only the persisted one can refresh next time.
    await w.env.storeCredential(w.b, {
      ...stored,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const again = await pass(w.adapter(), undefined);
    expect(again.error).toBeUndefined();
    expect(w.fake.tokens.grants).toHaveLength(2);
  });

  it('normalizes Graph times to UTC instants and maps the Windows zone to IANA', async () => {
    w = await world({ calendars: ['Calendar'] });
    w.fake.addEvent(w.main, {
      subject: 'Evening call',
      start: '2026-10-21T02:30:00.000Z',
      end: '2026-10-21T03:00:00.000Z',
      originalStartTimeZone: 'Pacific Standard Time',
    });
    w.fake.addEvent(w.main, {
      subject: 'Company holiday',
      start: '2026-11-26',
      end: '2026-11-27',
      isAllDay: true,
    });
    await pass(w.adapter({ now: () => Date.UTC(2026, 9, 19) }), undefined);
    const records = await readCorpus(w.env.artifactsDir, 'data/outlook');
    const call = records.find((r) => r.frontmatter.title === 'Evening call')!;
    expect(call.frontmatter).toMatchObject({
      date: '2026-10-21T02:30:00.000Z',
      end: '2026-10-21T03:00:00.000Z',
      all_day: 'false',
      timezone: 'America/Los_Angeles',
    });
    // 7:30pm in Los Angeles on the 20th: bucketed by the local day.
    expect(call.path).toMatch(/\/2026-10\/\d{3}--2026-10-20--evening-call--/);
    const holiday = records.find((r) => r.frontmatter.title === 'Company holiday')!;
    expect(holiday.frontmatter).toMatchObject({
      date: '2026-11-26',
      end: '2026-11-27',
      all_day: 'true',
    });
  });
});
