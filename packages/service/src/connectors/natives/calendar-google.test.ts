import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { NATIVE_ADAPTERS } from '../registry.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import {
  FakeGoogleCalendar,
  type FakeGoogleEventTime,
  GOOGLE_CALENDAR_API,
} from '../testing/fake-google-calendar.js';
import { status } from '../testing/fake-http.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import type { ConnectorBindingRef } from '../types.js';
import { GoogleCalendarAdapter, registerCalendarAdapters } from './calendar-google.js';
import { ReconnectRequiredError } from './oauth-session.js';

const DAY = 86_400_000;
const PRIMARY = 'ada@example.com';
const TEAM = 'c_5f1e0a4b9d2c@group.calendar.google.com';
const REQUIRED_KEYS = ['title', 'date', 'all_day', 'status', 'calendar', 'provider', 'event_id'];

function timed(
  startMs: number,
  minutes = 30,
): { start: FakeGoogleEventTime; end: FakeGoogleEventTime } {
  return {
    start: { dateTime: new Date(startMs).toISOString(), timeZone: 'America/Los_Angeles' },
    end: {
      dateTime: new Date(startMs + minutes * 60_000).toISOString(),
      timeZone: 'America/Los_Angeles',
    },
  };
}

function binding(config: Record<string, unknown> = {}): ConnectorBindingRef {
  return { id: 'calendar-google:test', type: 'calendar-google', config };
}

interface World {
  env: ConnectorTestEnv;
  fake: FakeGoogleCalendar;
  b: ConnectorBindingRef;
  adapter(opts?: { now?: () => number }): GoogleCalendarAdapter;
}

async function world(config: Record<string, unknown> = {}): Promise<World> {
  const env = await createConnectorTestEnv();
  const fake = new FakeGoogleCalendar();
  fake.addCalendar(PRIMARY, {
    summary: 'Ada Lovelace',
    timeZone: 'America/Los_Angeles',
    primary: true,
  });
  fake.addCalendar(TEAM, { summary: 'Analytical Engine team', timeZone: 'Europe/London' });
  const b = binding(config);
  await env.storeCredential(b, fake.credential());
  return {
    env,
    fake,
    b,
    adapter: (opts) => new GoogleCalendarAdapter(b, env.deps({ fetch: fake.http.fetch }), opts),
  };
}

function eventRequests(fake: FakeGoogleCalendar, calendarId = PRIMARY): URLSearchParams[] {
  return fake.http
    .requests('GET', `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`)
    .map((r) => r.url.searchParams);
}

function scopeCursor(cursor: unknown, scope: string): Record<string, unknown> | undefined {
  return (cursor as { scopes: Record<string, Record<string, unknown>> }).scopes[scope];
}

describeConnectorConformance('calendar-google', {
  async create() {
    const w = await world();
    const now = Date.now();
    const seed = (cal: string, day: number, summary: string) =>
      w.fake.addEvent(cal, {
        summary,
        description: `Notes for ${summary}`,
        ...timed(now + day * DAY),
      });
    seed(PRIMARY, 1, 'Standup');
    seed(PRIMARY, 2, 'Design review');
    seed(PRIMARY, 3, '1:1 with Grace');
    seed(TEAM, 1, 'Team lunch');
    seed(TEAM, 4, 'Retro');
    let added = 0;
    const first = () => w.fake.events(PRIMARY)[0]!;
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
            w.fake.addEvent(PRIMARY, {
              summary: `Added ${added}`,
              ...timed(now + (10 + added) * DAY),
            });
          }
        },
        update() {
          const e = first();
          w.fake.updateEvent(PRIMARY, e.id, {
            summary: `${e.summary} (room change)`,
            location: 'Room 4',
          });
        },
        remove() {
          w.fake.cancelEvent(PRIMARY, first().id);
        },
        move() {
          w.fake.updateEvent(PRIMARY, first().id, timed(now + 45 * DAY));
        },
        expireCursor() {
          w.fake.expireSyncTokens();
        },
        throttleNextList() {
          w.fake.http.failNext(
            { url: `${GOOGLE_CALENDAR_API}/calendars/` },
            status(
              429,
              { error: { code: 429, message: 'Rate Limit Exceeded' } },
              { 'retry-after': '1' },
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
          w.fake.addEvent(PRIMARY, {
            summary: HOSTILE_NAME,
            location: HOSTILE_NAME,
            description: INJECTION_PAYLOAD,
            ...timed(now + 5 * DAY),
          });
        },
      },
    };
  },
});

describe('GoogleCalendarAdapter', () => {
  let w: World | null = null;
  afterEach(async () => {
    expect(w?.fake.http.unrouted ?? []).toEqual([]);
    await w?.env.dispose();
    w = null;
  });

  async function pass(adapter: GoogleCalendarAdapter, cursor: unknown, backfillLimit = 500) {
    return syncWithAdapter(adapter, {
      storageDir: w!.env.artifactsDir,
      quarantineDir: w!.env.quarantineDir,
      corpusDir: 'data/calendar',
      backfillLimit,
      cursor,
    });
  }

  it('pages a listing past 250 events and stores the sync token from the last page only', async () => {
    w = await world({ calendars: [PRIMARY] });
    const now = Date.now();
    for (let i = 0; i < 600; i++) {
      w.fake.addEvent(PRIMARY, { summary: `Slot ${i}`, ...timed(now + i * 3_600_000) });
    }
    const first = await pass(w.adapter(), undefined);
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(600);
    expect(scopeCursor(first.cursor, PRIMARY)).toMatchObject({ syncToken: expect.any(String) });
    expect(scopeCursor(first.cursor, PRIMARY)?.pageToken).toBeUndefined();

    const listing = eventRequests(w.fake);
    expect(listing).toHaveLength(3);
    for (const q of listing) {
      expect(q.get('syncToken')).toBeNull();
      expect(q.get('timeMin')).toBeTruthy();
      expect(q.get('timeMax')).toBeTruthy();
      expect(q.get('singleEvents')).toBe('true');
      expect(q.get('showDeleted')).toBe('true');
    }
    expect(listing[0]!.get('pageToken')).toBeNull();
    expect(listing[1]!.get('pageToken')).toBeTruthy();

    const second = await pass(w.adapter(), first.cursor);
    expect(second.written).toBe(0);
    const incremental = eventRequests(w.fake).slice(3);
    expect(incremental).toHaveLength(1);
    expect(incremental[0]!.get('syncToken')).toBeTruthy();
    expect(incremental[0]!.get('timeMin')).toBeNull();
    expect(incremental[0]!.get('timeMax')).toBeNull();
    expect(await readCorpus(w.env.artifactsDir, 'data/calendar')).toHaveLength(600);
  });

  it('honors a batch smaller than a page: offsets into the page, no gaps, no repeats', async () => {
    w = await world({ calendars: [PRIMARY] });
    const now = Date.now();
    w.fake.pageCap = 40;
    for (let i = 0; i < 130; i++) {
      w.fake.addEvent(PRIMARY, { summary: `Slot ${i}`, ...timed(now + i * 3_600_000) });
    }
    const adapter = w.adapter();
    await adapter.ensureAuth();
    const seen: string[] = [];
    let cursor: unknown;
    for (let round = 0; round < 50; round++) {
      const batch = await adapter.listChangesSince(PRIMARY, cursor, { limit: 15 });
      expect(batch.records.length).toBeLessThanOrEqual(15);
      seen.push(...batch.records.map((r) => r.id));
      cursor = batch.cursor;
      if (!batch.partial) break;
    }
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    expect(cursor).toMatchObject({ syncToken: expect.any(String) });
  });

  it('recovers from 410 GONE with a full listing in the same pass', async () => {
    w = await world({ calendars: [PRIMARY] });
    const now = Date.now();
    w.fake.addEvent(PRIMARY, { summary: 'Kickoff', ...timed(now + DAY) });
    const first = await pass(w.adapter(), undefined);
    w.fake.expireSyncTokens();
    w.fake.addEvent(PRIMARY, { summary: 'Follow-up', ...timed(now + 2 * DAY) });
    const before = eventRequests(w.fake).length;

    const second = await pass(w.adapter(), first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(1);
    const after = eventRequests(w.fake).slice(before);
    expect(after[0]!.get('syncToken')).toBeTruthy();
    expect(after[1]!.get('syncToken')).toBeNull();
    expect(after[1]!.get('timeMin')).toBeTruthy();

    const third = await pass(w.adapter(), second.cursor);
    expect(third.error).toBeUndefined();
    expect(third.written).toBe(0);
  });

  it('turns cancelled events into tombstones, never records', async () => {
    w = await world({ calendars: [PRIMARY] });
    const now = Date.now();
    const keep = w.fake.addEvent(PRIMARY, { summary: 'Keep', ...timed(now + DAY) });
    const gone = w.fake.addEvent(PRIMARY, { summary: 'Cancelled soon', ...timed(now + 2 * DAY) });
    const first = await pass(w.adapter(), undefined);
    expect(first.written).toBe(2);

    w.fake.cancelEvent(PRIMARY, gone.id);
    const adapter = w.adapter();
    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince(PRIMARY, scopeCursor(first.cursor, PRIMARY));
    expect(batch.records).toEqual([]);
    expect(batch.removed).toEqual([`${PRIMARY}:${gone.id}`]);

    const second = await pass(w.adapter(), first.cursor);
    expect(second.pruned).toBe(1);
    expect(second.written).toBe(0);
    const left = await readCorpus(w.env.artifactsDir, 'data/calendar');
    expect(left.map((r) => r.frontmatter.event_id)).toEqual([keep.id]);
  });

  it('moves a rescheduled event to its new month without leaving the old copy', async () => {
    w = await world({ calendars: [PRIMARY] });
    const now = Date.now();
    const e = w.fake.addEvent(PRIMARY, { summary: 'Offsite', ...timed(now + DAY) });
    expect(w.adapter().recordsMayMove).toBe(true);
    const first = await pass(w.adapter(), undefined);
    const before = (await readCorpus(w.env.artifactsDir, 'data/calendar')).map((r) => r.path);

    w.fake.updateEvent(PRIMARY, e.id, timed(now + 45 * DAY));
    await pass(w.adapter(), first.cursor);
    const after = (await readCorpus(w.env.artifactsDir, 'data/calendar')).map((r) => r.path);
    expect(after).toHaveLength(1);
    expect(after[0]!.split('/')[1]).not.toBe(before[0]!.split('/')[1]);
  });

  it('lists an explicit, configurable window and clips incremental changes to it', async () => {
    const t0 = Date.UTC(2026, 9, 19, 15, 0, 0);
    w = await world({ calendars: [PRIMARY], pastDays: 30, futureDays: 60 });
    const inside = w.fake.addEvent(PRIMARY, { summary: 'Inside', ...timed(t0 + 10 * DAY) });
    w.fake.addEvent(PRIMARY, { summary: 'Long ago', ...timed(t0 - 40 * DAY) });
    w.fake.addEvent(PRIMARY, { summary: 'Far future', ...timed(t0 + 100 * DAY) });
    const now = () => t0;

    const first = await pass(w.adapter({ now }), undefined);
    expect(first.written).toBe(1);
    const q = eventRequests(w.fake)[0]!;
    expect(q.get('timeMin')).toBe('2026-09-19T00:00:00Z');
    expect(q.get('timeMax')).toBe('2026-12-19T00:00:00Z');

    // Google's incremental listing is not clipped to the window: an event
    // rescheduled out of range, or created beyond it, still arrives.
    w.fake.updateEvent(PRIMARY, inside.id, timed(t0 + 200 * DAY));
    w.fake.addEvent(PRIMARY, { summary: 'Next year', ...timed(t0 + 300 * DAY) });
    const second = await pass(w.adapter({ now }), first.cursor);
    expect(second.written).toBe(0);
    expect(second.pruned).toBe(1);
    expect(await readCorpus(w.env.artifactsDir, 'data/calendar')).toEqual([]);
  });

  it('slides the window: a week on, a completed listing is followed by a fresh one', async () => {
    const t0 = Date.UTC(2026, 9, 19, 15, 0, 0);
    w = await world({ calendars: [PRIMARY], futureDays: 60 });
    w.fake.addEvent(PRIMARY, { summary: 'Soon', ...timed(t0 + DAY) });
    let clock = t0;
    const now = () => clock;
    const first = await pass(w.adapter({ now }), undefined);
    const firstWindow = scopeCursor(first.cursor, PRIMARY)?.window as { end: string };

    clock = t0 + 8 * DAY;
    // Beyond the first window's far edge, inside the slid one.
    w.fake.addEvent(PRIMARY, { summary: 'Newly in range', ...timed(t0 + 66 * DAY) });
    const before = eventRequests(w.fake).length;
    const second = await pass(w.adapter({ now }), first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(1);
    const requests = eventRequests(w.fake).slice(before);
    expect(requests[0]!.get('syncToken')).toBeTruthy();
    expect(requests[1]!.get('timeMax')).toBe('2026-12-27T00:00:00Z');
    const slid = scopeCursor(second.cursor, PRIMARY)?.window as { end: string };
    expect(Date.parse(slid.end)).toBeGreaterThan(Date.parse(firstWindow.end));
    expect(
      (await readCorpus(w.env.artifactsDir, 'data/calendar')).map((r) => r.frontmatter.title),
    ).toContain('Newly in range');
  });

  it('re-lists when the window config changes', async () => {
    const t0 = Date.UTC(2026, 9, 19, 15, 0, 0);
    w = await world({ calendars: [PRIMARY], pastDays: 30 });
    w.fake.addEvent(PRIMARY, { summary: 'Old review', ...timed(t0 - 60 * DAY) });
    const first = await pass(w.adapter({ now: () => t0 }), undefined);
    expect(first.written).toBe(0);

    const wider = new GoogleCalendarAdapter(
      binding({ calendars: [PRIMARY], pastDays: 120 }),
      w.env.deps({ fetch: w.fake.http.fetch }),
      { now: () => t0 },
    );
    const second = await pass(wider, first.cursor);
    expect(second.written).toBe(1);
  });

  it('treats a pre-1.0.1 bare sync-token cursor as a fresh listing', async () => {
    w = await world({ calendars: [PRIMARY] });
    w.fake.addEvent(PRIMARY, { summary: 'Carried over', ...timed(Date.now() + DAY) });
    const legacy = { v: 2, scopes: { [PRIMARY]: 'CPDAlvWDx70CEPDAlvWDx70CGAU=' } };
    const r = await pass(w.adapter(), legacy);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(1);
    expect(eventRequests(w.fake)[0]!.get('syncToken')).toBeNull();
  });

  it('reports a 403 rateLimitExceeded as backpressure and keeps the cursor', async () => {
    w = await world({ calendars: [PRIMARY] });
    w.fake.addEvent(PRIMARY, { summary: 'One', ...timed(Date.now() + DAY) });
    const first = await pass(w.adapter(), undefined);
    w.fake.http.failNext(
      { url: `${GOOGLE_CALENDAR_API}/calendars/` },
      status(403, {
        error: {
          errors: [
            { domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' },
          ],
          code: 403,
          message: 'Rate Limit Exceeded',
        },
      }),
    );
    const throttled = await pass(w.adapter(), first.cursor);
    expect(throttled.rateLimited).toBe(true);
    expect(throttled.error).toBeUndefined();
    expect(throttled.cursor).toEqual(first.cursor);
  });

  it('keeps what a listing returned when a later page is throttled', async () => {
    w = await world({ calendars: [PRIMARY] });
    const now = Date.now();
    w.fake.pageCap = 10;
    for (let i = 0; i < 25; i++)
      w.fake.addEvent(PRIMARY, { summary: `E${i}`, ...timed(now + i * DAY) });
    const adapter = w.adapter();
    await adapter.ensureAuth();
    // The second page is throttled after the first one landed.
    let calls = 0;
    w.fake.http.failNext({ url: /pageToken=/ }, () => {
      calls++;
      return status(429, { error: { code: 429, message: 'Rate Limit Exceeded' } });
    });
    const batch = await adapter.listChangesSince(PRIMARY, undefined, { limit: 500 });
    expect(calls).toBe(1);
    expect(batch.rateLimited).toBe(true);
    expect(batch.records).toHaveLength(10);
    expect(batch.cursor).toMatchObject({ pageToken: expect.any(String) });
  });

  it('a revoked refresh token fails with an actionable reconnect error', async () => {
    w = await world({ calendars: [PRIMARY] });
    w.fake.tokens.rejectRefresh = true;
    await w.env.storeCredential(
      w.b,
      w.fake.credential({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const adapter = w.adapter();
    await expect(adapter.ensureAuth()).rejects.toBeInstanceOf(ReconnectRequiredError);
    const r = await pass(w.adapter(), undefined);
    expect(r.error).toMatch(/Re-link the account/);
    expect(r.error).not.toMatch(/refresh-\d|seed-access|fake-google-secret/);
  });

  it('refreshes once on a 401 and persists the new access token', async () => {
    w = await world({ calendars: [PRIMARY] });
    w.fake.addEvent(PRIMARY, { summary: 'One', ...timed(Date.now() + DAY) });
    // A factory, not a Response: `failNext` serves `clone()`s, and cancelling
    // a tee'd body (as the 401 path does) waits on the unread original.
    w.fake.http.failNext({ url: `${GOOGLE_CALENDAR_API}/` }, () =>
      status(401, { error: { code: 401, message: 'Invalid Credentials' } }),
    );
    const r = await pass(w.adapter(), undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(1);
    expect(w.fake.tokens.grants.map((g) => g.get('grant_type'))).toEqual(['refresh_token']);
    const stored = await w.env.readCredential<{ accessToken: string }>(w.b);
    expect(stored?.accessToken).toMatch(/^access-/);
  });

  it('resolves configured calendar names to ids and passes unknown entries through', async () => {
    w = await world({ calendars: ['analytical engine team', 'primary'] });
    const adapter = w.adapter();
    await adapter.ensureAuth();
    expect(await adapter.listScopes()).toEqual([TEAM, 'primary']);
  });

  it('lists every calendar on the account when none are configured', async () => {
    w = await world();
    const adapter = w.adapter();
    await adapter.ensureAuth();
    expect(await adapter.listScopes()).toEqual([PRIMARY, TEAM]);
  });

  it('skips working-location markers and names the calendar on each record', async () => {
    w = await world({ calendars: [TEAM] });
    const now = Date.now();
    w.fake.addEvent(TEAM, { summary: 'Home', eventType: 'workingLocation', ...timed(now + DAY) });
    w.fake.addEvent(TEAM, { summary: 'Planning', ...timed(now + DAY) });
    const r = await pass(w.adapter(), undefined);
    expect(r.written).toBe(1);
    const [rec] = await readCorpus(w.env.artifactsDir, 'data/calendar');
    expect(rec!.frontmatter).toMatchObject({
      title: 'Planning',
      calendar: 'Analytical Engine team',
      timezone: 'America/Los_Angeles',
      provider: 'google',
    });
    expect(rec!.path.startsWith('c-5f1e0a4b9d2c-group-calendar-google-com/')).toBe(true);
  });

  it('registers both calendar providers through the existing wiring call', () => {
    registerCalendarAdapters();
    expect(NATIVE_ADAPTERS.has('calendar-google')).toBe(true);
    expect(NATIVE_ADAPTERS.has('calendar-microsoft')).toBe(true);
  });
});
