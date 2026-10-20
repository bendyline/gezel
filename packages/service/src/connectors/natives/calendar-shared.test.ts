import { describe, expect, it } from 'vitest';
import { type GoogleCalendarEvent, googleEventToCalendarEvent } from './calendar-google.js';
import {
  type GraphCalendarEvent,
  graphEventToCalendarEvent,
  graphZoneToIana,
} from './calendar-microsoft.js';
import {
  type CalendarEvent,
  calendarEventToRecord,
  formatPerson,
  localDateIn,
  overlapsWindow,
  readWindowConfig,
  windowAt,
  windowNeedsRefresh,
  zonedWallTimeToUtc,
} from './calendar-shared.js';

/**
 * Golden normalize tests: realistic provider JSON in, exact record out. The
 * same meeting is pinned from both providers, as Charles (an attendee) sees
 * it, so a field renamed by either provider — or a drift between the two
 * mappings — fails here instead of silently splitting "my calendar" in two.
 */

const SERIES = '5q8r2k1m0n3p4s6t7u8v9w0x1y';

const GOOGLE_EVENT: GoogleCalendarEvent & Record<string, unknown> = {
  kind: 'calendar#event',
  etag: '"3456789012345678"',
  id: `${SERIES}_20261020T160000Z`,
  status: 'confirmed',
  htmlLink:
    'https://www.google.com/calendar/event?eid=NXE4cjJrMW0wbjNwNHM2dDd1OHY5dzB4MXlfMjAyNjEwMjBUMTYwMDAwWiBjaGFybGVzQGV4YW1wbGUuY29t',
  created: '2026-09-02T17:04:11.000Z',
  updated: '2026-10-15T08:12:45.913Z',
  summary: 'Weekly design review',
  description: 'Agenda:\n1. Difference engine tolerances\n2. Punch-card supply',
  location: 'Room 4B, 1 Analytical Way',
  creator: { email: 'ada@example.com', displayName: 'Ada Lovelace' },
  organizer: { email: 'ada@example.com', displayName: 'Ada Lovelace' },
  start: { dateTime: '2026-10-20T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-10-20T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
  recurringEventId: SERIES,
  originalStartTime: { dateTime: '2026-10-20T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
  iCalUID: `${SERIES}@google.com`,
  sequence: 2,
  attendees: [
    {
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      organizer: true,
      responseStatus: 'accepted',
    },
    {
      email: 'charles@example.com',
      displayName: 'Charles Babbage',
      self: true,
      responseStatus: 'tentative',
    },
    { email: 'mary@example.com', optional: true, responseStatus: 'needsAction' },
    {
      email: 'c_1888abc@resource.calendar.google.com',
      displayName: 'Room 4B',
      resource: true,
      responseStatus: 'accepted',
    },
  ],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  conferenceData: {
    entryPoints: [
      { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
      { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
    ],
  },
  reminders: { useDefault: true },
  eventType: 'default',
};

const GRAPH_ID =
  'AAMkADQ0ZjMyNTQ5LWY2NWQtNDA3MS04ZWMwLTFmYzZmMjE2YjU0MwFRAAgI3TCdwvFAAEYAAAAAcdJGHN_TQ06TcbF9hx_ua4BwBFwMUmXb07RIZlw7m8SK4AAAAAAQ0AAABFwMUmXb07RIZlw7m8SK4AAAAA1D2rAAAQ';
const GRAPH_SERIES =
  'AAMkADQ0ZjMyNTQ5LWY2NWQtNDA3MS04ZWMwLTFmYzZmMjE2YjU0MwBGAAAAAAB_0kYc39NDTpNxv2HGp-5rBwBFwMUmXb07RIZlw7m8SK4AAAAAAQ0AAABFwMUmXb07RIZlw7m8SK4AAAAA1D2rAAA=';
const GRAPH_CALENDAR =
  'AAMkADQ0ZjMyNTQ5LWY2NWQtNDA3MS04ZWMwLTFmYzZmMjE2YjU0MwBGAAAAAAB_0kYc39NDTpNxv2HGp-5rBwBFwMUmXb07RIZlw7m8SK4AAAAAAQYAAA=';
const TEAMS_JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZjE1YTk2NGMtODg3%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf%22%7d';

const GRAPH_EVENT: GraphCalendarEvent & Record<string, unknown> = {
  '@odata.type': '#microsoft.graph.event',
  '@odata.etag': 'W/"DwAAABYAAABFwMUmXb07RIZlw7m8SK4AAAAA1D2r"',
  id: GRAPH_ID,
  createdDateTime: '2026-09-02T17:04:11.2735386Z',
  lastModifiedDateTime: '2026-10-15T08:12:45.913421Z',
  changeKey: 'DwAAABYAAABFwMUmXb07RIZlw7m8SK4AAAAA1D2r',
  categories: [],
  transactionId: null,
  originalStartTimeZone: 'Pacific Standard Time',
  originalEndTimeZone: 'Pacific Standard Time',
  iCalUId: '040000008200E00074C5B7101A82E00807EA0A14A1D2E3F4000000000000000010000000E0F3A4B5',
  reminderMinutesBeforeStart: 15,
  isReminderOn: true,
  hasAttachments: false,
  subject: 'Weekly design review',
  bodyPreview: 'Agenda: Difference engine tolerances Punch-card supply',
  importance: 'normal',
  sensitivity: 'normal',
  isAllDay: false,
  isCancelled: false,
  isOrganizer: false,
  responseRequested: true,
  seriesMasterId: GRAPH_SERIES,
  showAs: 'tentative',
  type: 'occurrence',
  webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(GRAPH_ID)}&exvsurl=1&path=/calendar/item`,
  onlineMeetingUrl: null,
  isOnlineMeeting: true,
  onlineMeetingProvider: 'teamsForBusiness',
  allowNewTimeProposals: true,
  isDraft: false,
  hideAttendees: false,
  responseStatus: {
    response: 'tentativelyAccepted',
    time: '2026-09-03T10:00:00Z',
  } as GraphCalendarEvent['responseStatus'],
  body: {
    contentType: 'html',
    content:
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div><p>Agenda:</p><ol><li>Difference engine tolerances</li><li>Punch-card supply</li></ol></div><div><b>Microsoft Teams meeting</b></div><div><a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZjE1YTk2NGMtODg3%40thread.v2/0">Join the meeting now</a></div></body></html>',
  },
  start: { dateTime: '2026-10-20T16:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-20T17:00:00.0000000', timeZone: 'UTC' },
  location: {
    displayName: 'Room 4B, 1 Analytical Way',
    locationType: 'default',
    uniqueId: 'Room 4B, 1 Analytical Way',
    uniqueIdType: 'private',
  } as GraphCalendarEvent['location'],
  locations: [{ displayName: 'Room 4B, 1 Analytical Way' }],
  recurrence: null,
  attendees: [
    {
      type: 'required',
      status: { response: 'tentativelyAccepted' },
      emailAddress: { name: 'Charles Babbage', address: 'charles@example.com' },
    },
    {
      type: 'optional',
      status: { response: 'none' },
      emailAddress: { name: 'mary@example.com', address: 'mary@example.com' },
    },
    {
      type: 'resource',
      status: { response: 'accepted' },
      emailAddress: { name: 'Room 4B', address: 'room4b@example.com' },
    },
    {
      type: 'required',
      status: { response: 'none' },
      emailAddress: { name: 'Ada Lovelace', address: 'ada@example.com' },
    },
  ],
  organizer: { emailAddress: { name: 'Ada Lovelace', address: 'ada@example.com' } },
  onlineMeeting: { joinUrl: TEAMS_JOIN },
};

const SHARED_KEY_ORDER = [
  'title',
  'date',
  'end',
  'all_day',
  'timezone',
  'location',
  'organizer',
  'attendees',
  'my_response',
  'status',
  'url',
  'online_meeting',
  'calendar',
  'provider',
  'event_id',
  'series_id',
  'direction',
];

describe('calendar golden normalization', () => {
  it('pins a recurring Google Calendar instance to its record', async () => {
    const record = calendarEventToRecord(
      await googleEventToCalendarEvent(GOOGLE_EVENT, {
        calendarId: 'charles@example.com',
        calendarName: 'Charles Babbage',
        calendarTimeZone: 'Europe/London',
      }),
    );
    expect(record).toEqual({
      recordId: `charles@example.com:${SERIES}_20261020T160000Z`,
      dirSegments: ['2026-10'],
      fileStem: '2026-10-20--weekly-design-review',
      frontmatter: {
        title: 'Weekly design review',
        date: '2026-10-20T16:00:00.000Z',
        end: '2026-10-20T17:00:00.000Z',
        all_day: 'false',
        timezone: 'America/Los_Angeles',
        location: 'Room 4B, 1 Analytical Way',
        organizer: 'Ada Lovelace <ada@example.com>',
        attendees:
          'Charles Babbage <charles@example.com> (tentative); mary@example.com (needs-action, optional)',
        my_response: 'tentative',
        status: 'confirmed',
        url: GOOGLE_EVENT.htmlLink,
        online_meeting: 'https://meet.google.com/abc-defg-hij',
        calendar: 'Charles Babbage',
        provider: 'google',
        event_id: `${SERIES}_20261020T160000Z`,
        series_id: SERIES,
        direction: 'inbound',
      },
      bodyMarkdown: 'Agenda:\n1. Difference engine tolerances\n2. Punch-card supply',
      scanOrigin: 'calendar-google',
      quarantineNamespace: 'calendar-google',
      quarantineLabel: 'Calendar event "Weekly design review"',
    });
    expect(Object.keys(record.frontmatter)).toEqual(SHARED_KEY_ORDER);
  });

  it('pins the same meeting from Microsoft Graph to its record', async () => {
    const record = calendarEventToRecord(
      await graphEventToCalendarEvent(GRAPH_EVENT, {
        calendarId: GRAPH_CALENDAR,
        calendarName: 'Calendar',
      }),
    );
    expect(record).toEqual({
      recordId: `${GRAPH_CALENDAR}:${GRAPH_ID}`,
      dirSegments: ['2026-10'],
      fileStem: '2026-10-20--weekly-design-review',
      frontmatter: {
        title: 'Weekly design review',
        date: '2026-10-20T16:00:00.000Z',
        end: '2026-10-20T17:00:00.000Z',
        all_day: 'false',
        timezone: 'America/Los_Angeles',
        location: 'Room 4B, 1 Analytical Way',
        organizer: 'Ada Lovelace <ada@example.com>',
        attendees:
          'Charles Babbage <charles@example.com> (tentative); mary@example.com (needs-action, optional)',
        my_response: 'tentative',
        status: 'confirmed',
        url: GRAPH_EVENT.webLink,
        online_meeting: TEAMS_JOIN,
        calendar: 'Calendar',
        provider: 'microsoft',
        event_id: GRAPH_ID,
        series_id: GRAPH_SERIES,
        direction: 'inbound',
      },
      // The HTML converter is squisq's; pin what it must keep, not its spacing.
      bodyMarkdown: expect.stringMatching(
        /^Agenda:[\s\S]*1\. Difference engine tolerances[\s\S]*Join the meeting now/,
      ),
      scanOrigin: 'calendar-microsoft',
      quarantineNamespace: 'calendar-microsoft',
      quarantineLabel: 'Calendar event "Weekly design review"',
    });
    expect(record.bodyMarkdown).not.toMatch(/<\/?(html|div|p|ol|li|b)\b/);
    expect(Object.keys(record.frontmatter)).toEqual(SHARED_KEY_ORDER);
  });

  it('gives one meeting the same frontmatter from both providers, apart from identity', async () => {
    const g = calendarEventToRecord(
      await googleEventToCalendarEvent(GOOGLE_EVENT, { calendarId: 'charles@example.com' }),
    );
    const m = calendarEventToRecord(
      await graphEventToCalendarEvent(GRAPH_EVENT, { calendarId: GRAPH_CALENDAR }),
    );
    const identity = ['url', 'online_meeting', 'calendar', 'provider', 'event_id', 'series_id'];
    const strip = (fm: Record<string, string>) =>
      Object.fromEntries(Object.entries(fm).filter(([k]) => !identity.includes(k)));
    expect(strip(g.frontmatter)).toEqual(strip(m.frontmatter));
    expect(g.dirSegments).toEqual(m.dirSegments);
    expect(g.fileStem).toEqual(m.fileStem);
  });

  it('pins all-day and out-of-office events from both providers', async () => {
    const google = calendarEventToRecord(
      await googleEventToCalendarEvent(
        {
          kind: 'calendar#event',
          id: 'ooo123',
          status: 'confirmed',
          summary: 'Out of office',
          eventType: 'outOfOffice',
          start: { date: '2026-11-26' },
          end: { date: '2026-11-28' },
          organizer: { email: 'charles@example.com', self: true },
          htmlLink: 'https://www.google.com/calendar/event?eid=b29vMTIz',
        },
        { calendarId: 'charles@example.com', calendarTimeZone: 'America/New_York' },
      ),
    );
    expect(google.frontmatter).toEqual({
      title: 'Out of office',
      date: '2026-11-26',
      end: '2026-11-28',
      all_day: 'true',
      timezone: 'America/New_York',
      organizer: 'charles@example.com',
      status: 'confirmed',
      event_type: 'out-of-office',
      url: 'https://www.google.com/calendar/event?eid=b29vMTIz',
      calendar: 'charles@example.com',
      provider: 'google',
      event_id: 'ooo123',
      direction: 'inbound',
    });
    expect(google.dirSegments).toEqual(['2026-11']);
    expect(google.fileStem).toBe('2026-11-26--out-of-office');

    const graph = calendarEventToRecord(
      await graphEventToCalendarEvent(
        {
          id: 'AAMkOOO=',
          subject: 'Out of office',
          isAllDay: true,
          showAs: 'oof',
          originalStartTimeZone: 'Eastern Standard Time',
          start: { dateTime: '2026-11-26T00:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-11-28T00:00:00.0000000', timeZone: 'UTC' },
          organizer: {
            emailAddress: { name: 'charles@example.com', address: 'charles@example.com' },
          },
          attendees: [],
          responseStatus: { response: 'organizer' },
          isOrganizer: true,
          body: { contentType: 'html', content: '' },
          webLink: 'https://outlook.live.com/owa/?itemid=AAMkOOO%3D&exvsurl=1&path=/calendar/item',
        },
        { calendarId: 'AAMkCAL=' },
      ),
    );
    expect(graph.frontmatter).toEqual({
      title: 'Out of office',
      date: '2026-11-26',
      end: '2026-11-28',
      all_day: 'true',
      timezone: 'America/New_York',
      organizer: 'charles@example.com',
      status: 'confirmed',
      event_type: 'out-of-office',
      url: 'https://outlook.live.com/owa/?itemid=AAMkOOO%3D&exvsurl=1&path=/calendar/item',
      calendar: 'AAMkCAL=',
      provider: 'microsoft',
      event_id: 'AAMkOOO=',
      direction: 'inbound',
    });
    expect(graph.bodyMarkdown).toBe('');
  });

  it('marks the organizer and converts a web-UI HTML description', async () => {
    const ev = await googleEventToCalendarEvent(
      {
        ...GOOGLE_EVENT,
        organizer: { email: 'ada@example.com', displayName: 'Ada Lovelace', self: true },
        attendees: GOOGLE_EVENT.attendees!.map((a) => ({ ...a, self: a.organizer === true })),
        description: '<b>Agenda</b><br>1. Tolerances<br><a href="https://example.com/doc">Spec</a>',
      },
      { calendarId: 'ada@example.com' },
    );
    expect(ev.myResponse).toBe('organizer');
    expect(ev.bodyMarkdown).toContain('**Agenda**');
    expect(ev.bodyMarkdown).toContain('https://example.com/doc');
    expect(ev.bodyMarkdown).not.toContain('<br');
  });
});

describe('calendar record shape', () => {
  const base: CalendarEvent = {
    provider: 'google',
    typeId: 'calendar-google',
    calendarId: 'cal',
    eventId: 'e1',
    title: 'Sync',
    allDay: false,
    start: '2026-10-20T16:00:00.000Z',
    attendees: [],
    status: 'confirmed',
    bodyMarkdown: '',
  };

  it('collapses whitespace in titles and falls back for an untitled or undated event', () => {
    const r = calendarEventToRecord({ ...base, title: '  Line one\nline two  ' });
    expect(r.frontmatter.title).toBe('Line one line two');
    const untitled = calendarEventToRecord({ ...base, title: '', start: undefined });
    expect(untitled.frontmatter.title).toBe('(no title)');
    expect(untitled.dirSegments).toEqual(['undated']);
    expect(untitled.fileStem).toBe('undated--no-title');
  });

  it('summarizes very large invite lists', () => {
    const attendees = Array.from({ length: 120 }, (_, i) => ({ email: `p${i}@example.com` }));
    const r = calendarEventToRecord({ ...base, attendees });
    expect(r.frontmatter.attendees).toMatch(/p49@example\.com; and 70 more$/);
  });

  it('formats people with whichever of name and address exists', () => {
    expect(formatPerson({ name: 'Ada', email: 'ada@example.com' })).toBe('Ada <ada@example.com>');
    expect(formatPerson({ name: 'ada@example.com', email: 'ada@example.com' })).toBe(
      'ada@example.com',
    );
    expect(formatPerson({ name: 'Room 4' })).toBe('Room 4');
    expect(formatPerson(undefined)).toBe('');
  });
});

describe('calendar time helpers', () => {
  it('reads the local day in a zone', () => {
    expect(localDateIn('2026-10-21T02:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-20');
    expect(localDateIn('2026-10-21T02:30:00.000Z', 'Asia/Tokyo')).toBe('2026-10-21');
    expect(localDateIn('2026-10-21T02:30:00.000Z', 'Not/AZone')).toBeUndefined();
  });

  it('converts a zoned wall time across a DST change', () => {
    expect(zonedWallTimeToUtc('2026-07-01T09:00:00.0000000', 'America/Los_Angeles')).toBe(
      '2026-07-01T16:00:00.000Z',
    );
    expect(zonedWallTimeToUtc('2026-12-01T09:00:00', 'America/Los_Angeles')).toBe(
      '2026-12-01T17:00:00.000Z',
    );
  });

  it('maps Windows zone names to IANA and keeps IANA names', () => {
    expect(graphZoneToIana('Pacific Standard Time')).toBe('America/Los_Angeles');
    expect(graphZoneToIana('W. Europe Standard Time')).toBe('Europe/Berlin');
    expect(graphZoneToIana('tzone://Microsoft/Utc')).toBe('UTC');
    expect(graphZoneToIana('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(graphZoneToIana('Customized Time Zone')).toBeUndefined();
  });
});

describe('calendar window', () => {
  const t0 = Date.UTC(2026, 9, 19, 15, 30, 0);

  it('defaults and clamps the configured window', () => {
    expect(readWindowConfig(undefined)).toEqual({ pastDays: 90, futureDays: 365 });
    expect(readWindowConfig({ pastDays: 7.9, futureDays: 30 })).toEqual({
      pastDays: 7,
      futureDays: 30,
    });
    expect(readWindowConfig({ pastDays: -5, futureDays: 0 })).toEqual({
      pastDays: 0,
      futureDays: 1,
    });
    expect(readWindowConfig({ pastDays: 99_999, futureDays: 99_999 })).toEqual({
      pastDays: 1825,
      futureDays: 730,
    });
    expect(readWindowConfig({ pastDays: '30' })).toEqual({ pastDays: 90, futureDays: 365 });
  });

  it('aligns the window to UTC days', () => {
    expect(windowAt(t0, { pastDays: 30, futureDays: 60 })).toEqual({
      start: '2026-09-19T00:00:00Z',
      end: '2026-12-19T00:00:00Z',
      pastDays: 30,
      futureDays: 60,
    });
  });

  it('refreshes after a week of drift or a config change, not before', () => {
    const cfg = { pastDays: 90, futureDays: 365 };
    const w = windowAt(t0, cfg);
    expect(windowNeedsRefresh(w, t0 + 6 * 86_400_000, cfg)).toBe(false);
    expect(windowNeedsRefresh(w, t0 + 7 * 86_400_000, cfg)).toBe(true);
    expect(windowNeedsRefresh(w, t0, { ...cfg, pastDays: 30 })).toBe(true);
    const short = { pastDays: 7, futureDays: 8 };
    expect(windowNeedsRefresh(windowAt(t0, short), t0 + 2 * 86_400_000, short)).toBe(true);
  });

  it('judges overlap with a day of slack on both edges', () => {
    const w = { start: '2026-09-19T00:00:00Z', end: '2026-12-19T00:00:00Z' };
    expect(overlapsWindow('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', w)).toBe(true);
    expect(overlapsWindow('2026-09-18', '2026-09-19', w)).toBe(true);
    expect(overlapsWindow('2026-09-10', '2026-09-11', w)).toBe(false);
    expect(overlapsWindow('2027-03-01T10:00:00Z', '2027-03-01T11:00:00Z', w)).toBe(false);
    expect(overlapsWindow(undefined, undefined, w)).toBe(true);
  });
});
