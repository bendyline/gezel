/**
 * Google Calendar as a `native` connector adapter. Each event normalizes
 * through `calendar-shared.ts` into the same record shape the Microsoft
 * calendar adapter writes, so "my calendar" reads the same from either.
 *
 * Sync follows Google's incremental-sync contract
 * (https://developers.google.com/workspace/calendar/api/guides/sync):
 *
 * - A full listing covers an explicit window (`timeMin`/`timeMax`, from the
 *   binding's `pastDays`/`futureDays`). `singleEvents=true` expands recurring
 *   series into instances, and without an upper bound a never-ending series
 *   expands without limit.
 * - `nextSyncToken` arrives only on the LAST page of a listing; every earlier
 *   page carries a `nextPageToken`. Both full and incremental listings page,
 *   and the cursor carries the page token (plus an offset into that page) so
 *   a listing larger than the engine's batch resumes instead of restarting.
 * - `syncToken` may not be combined with `timeMin`/`timeMax`, and Google does
 *   not promise that an incremental listing stays inside the original window,
 *   so incremental results are clipped to the window here: anything outside
 *   it is tombstoned (an event rescheduled out of range leaves the corpus).
 * - `showDeleted=true` on every request: incremental listings always report
 *   cancelled events, the token's parameters must match the full listing's,
 *   and it lets a resync tombstone cancellations it would otherwise miss.
 *   Cancelled events become `removed` tombstones, never records.
 * - 410 GONE (an expired or invalidated token) starts a fresh full listing in
 *   the same pass; the writer is idempotent by record id, so nothing doubles.
 * - The window slides: once time has moved its far edge by a week (or the
 *   config changed), the next completed listing is followed by a fresh one.
 *
 * Auth goes through the shared `OAuthSession`, so the transport is injectable
 * (`AdapterDeps.fetch`) and a revoked refresh token becomes an actionable
 * "re-link the account" error.
 */

import { createLogger } from '@bendyline/gezel';
import { registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { registerMicrosoftCalendarAdapters } from './calendar-microsoft.js';
import {
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarResponse,
  type CalendarWindow,
  type CalendarWindowConfig,
  bodyToMarkdown,
  calendarEventToRecord,
  calendarRecordId,
  eventTimeMs,
  isKnownTimeZone,
  localDateIn,
  overlapsWindow,
  readWindow,
  readWindowConfig,
  toUtcInstant,
  windowAt,
  windowNeedsRefresh,
} from './calendar-shared.js';
import {
  GOOGLE_OAUTH,
  OAuthSession,
  authorizedJson,
  hasStatus,
  isThrottle,
  transport,
} from './oauth-session.js';

const log = createLogger('connectors');

export const GOOGLE_CALENDAR_TYPE_ID = 'calendar-google';
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Kept constant: a sync token's other parameters must match the listing that minted it. */
const PAGE_SIZE = 250;

interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GooglePerson {
  email?: string;
  displayName?: string;
  self?: boolean;
}

/** The `events` resource fields this adapter reads. */
export interface GoogleCalendarEvent {
  kind?: string;
  etag?: string;
  id?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  eventType?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
  organizer?: GooglePerson;
  attendees?: (GooglePerson & {
    responseStatus?: string;
    optional?: boolean;
    organizer?: boolean;
    resource?: boolean;
  })[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

interface GoogleEventsPage {
  summary?: string;
  timeZone?: string;
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

interface GoogleCalendarListPage {
  items?: { id?: string; summary?: string; summaryOverride?: string }[];
  nextPageToken?: string;
}

/**
 * Per-calendar cursor. `syncToken` alone = a completed listing; with
 * `pageToken` = an incremental listing mid-way; `pageToken` without
 * `syncToken` = a full listing mid-way. `offset` counts the items of the
 * `pageToken` page already handed to the engine.
 */
export interface GoogleCalendarCursor {
  v: 1;
  window: CalendarWindow;
  syncToken?: string;
  pageToken?: string;
  offset?: number;
}

/** What a list call hands `fetchRecord`: events arrive whole, so no second request. */
interface GoogleRef {
  event: GoogleCalendarEvent;
  calendarId: string;
  calendarName?: string;
  calendarTimeZone?: string;
}

export interface GoogleCalendarContext {
  calendarId: string;
  calendarName?: string;
  /** The calendar's default zone (the list response's `timeZone`). */
  calendarTimeZone?: string;
}

function readCursor(raw: unknown): GoogleCalendarCursor | undefined {
  // Anything else — including the bare sync-token strings written before
  // 1.0.1 — re-lists the window once.
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return undefined;
  const c = raw as Partial<GoogleCalendarCursor>;
  const window = readWindow(c.window);
  if (!window) return undefined;
  return {
    v: 1,
    window,
    ...(typeof c.syncToken === 'string' && c.syncToken ? { syncToken: c.syncToken } : {}),
    ...(typeof c.pageToken === 'string' && c.pageToken ? { pageToken: c.pageToken } : {}),
    ...(typeof c.offset === 'number' && Number.isInteger(c.offset) && c.offset > 0
      ? { offset: c.offset }
      : {}),
  };
}

function cursorAt(cur: GoogleCalendarCursor, pageToken?: string, offset = 0): GoogleCalendarCursor {
  return {
    v: 1,
    window: cur.window,
    ...(cur.syncToken ? { syncToken: cur.syncToken } : {}),
    ...(pageToken ? { pageToken } : {}),
    ...(offset > 0 ? { offset } : {}),
  };
}

/**
 * Google signals backpressure with 429/503 and also with 403 bodies naming a
 * rate or quota reason (https://developers.google.com/workspace/calendar/api/guides/errors).
 */
function isGoogleThrottle(err: unknown): boolean {
  return (
    isThrottle(err) ||
    (hasStatus(err, 403) &&
      /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test((err as Error).message))
  );
}

function googleResponse(raw: string | undefined): CalendarResponse | undefined {
  switch (raw) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'tentative';
    case 'needsAction':
      return 'needs-action';
    default:
      return undefined;
  }
}

const GOOGLE_EVENT_TYPES: Record<string, CalendarEvent['eventType']> = {
  outOfOffice: 'out-of-office',
  focusTime: 'focus-time',
  birthday: 'birthday',
};

/** Raw Google event → the canonical calendar event. */
export async function googleEventToCalendarEvent(
  event: GoogleCalendarEvent,
  ctx: GoogleCalendarContext,
): Promise<CalendarEvent> {
  const allDay = !event.start?.dateTime && !!event.start?.date;
  const zone = [event.start?.timeZone, ctx.calendarTimeZone].find((z) => isKnownTimeZone(z));
  const start = allDay ? event.start?.date : toUtcInstant(event.start?.dateTime);
  const end = event.end?.dateTime ? toUtcInstant(event.end.dateTime) : event.end?.date;
  // Google writes `dateTime` with the local offset, so its date is the local
  // day when no zone is known.
  const localDate = allDay
    ? event.start?.date
    : (localDateIn(start, zone) ?? event.start?.dateTime?.slice(0, 10));
  const organizerEmail = event.organizer?.email?.toLowerCase();
  const people = (event.attendees ?? []).filter((a) => !a.resource);
  const attendees: CalendarAttendee[] = people
    .filter((a) => !a.organizer && !(organizerEmail && a.email?.toLowerCase() === organizerEmail))
    .map((a) => {
      const response = googleResponse(a.responseStatus);
      return {
        ...(a.displayName ? { name: a.displayName } : {}),
        ...(a.email ? { email: a.email } : {}),
        ...(response ? { response } : {}),
        ...(a.optional ? { optional: true } : {}),
      };
    });
  let myResponse: CalendarResponse | undefined;
  if (people.length > 0) {
    myResponse = event.organizer?.self
      ? 'organizer'
      : googleResponse(people.find((a) => a.self)?.responseStatus);
  }
  const meet =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  const eventType = event.eventType ? GOOGLE_EVENT_TYPES[event.eventType] : undefined;
  return {
    provider: 'google',
    typeId: GOOGLE_CALENDAR_TYPE_ID,
    calendarId: ctx.calendarId,
    ...(ctx.calendarName ? { calendarName: ctx.calendarName } : {}),
    eventId: event.id ?? '',
    title: event.summary ?? '',
    allDay,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(localDate ? { localDate } : {}),
    ...((event.start?.timeZone ?? ctx.calendarTimeZone)
      ? { timeZone: event.start?.timeZone ?? ctx.calendarTimeZone }
      : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.organizer?.email || event.organizer?.displayName
      ? {
          organizer: {
            ...(event.organizer.displayName ? { name: event.organizer.displayName } : {}),
            ...(event.organizer.email ? { email: event.organizer.email } : {}),
          },
        }
      : {}),
    attendees,
    ...(myResponse ? { myResponse } : {}),
    status: event.status === 'tentative' ? 'tentative' : 'confirmed',
    ...(eventType ? { eventType } : {}),
    ...(event.htmlLink ? { url: event.htmlLink } : {}),
    ...(meet ? { onlineMeetingUrl: meet } : {}),
    ...(event.recurringEventId ? { seriesId: event.recurringEventId } : {}),
    bodyMarkdown: await bodyToMarkdown(event.description),
  };
}

export interface GoogleCalendarAdapterOptions {
  /** Clock seam for window tests. */
  now?: () => number;
}

export class GoogleCalendarAdapter implements ConnectorAdapter<NormalizedRecord, unknown> {
  readonly typeId = GOOGLE_CALENDAR_TYPE_ID;
  /** Records are bucketed by start month, so a rescheduled event changes folders. */
  readonly recordsMayMove = true;
  private readonly session: OAuthSession;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly windowConfig: CalendarWindowConfig;

  constructor(
    private readonly binding: ConnectorBindingRef,
    deps: AdapterDeps,
    opts: GoogleCalendarAdapterOptions = {},
  ) {
    this.session = new OAuthSession(binding, deps, GOOGLE_OAUTH);
    this.fetchImpl = transport(deps);
    this.now = opts.now ?? Date.now;
    this.windowConfig = readWindowConfig(binding.config);
  }

  async ensureAuth(): Promise<void> {
    await this.session.token();
  }

  /**
   * Every calendar on the account's list, or the configured ones. A
   * configured entry may be a calendar id or its name; an entry the list does
   * not show (`primary`, a public calendar's id) is used as an id verbatim.
   */
  async listScopes(): Promise<string[]> {
    const configured = configuredCalendars(this.binding.config);
    const listed = await this.calendarList();
    if (configured.length > 0) {
      const ids = configured.map((entry) => {
        if (listed.some((c) => c.id === entry)) return entry;
        const lower = entry.toLowerCase();
        return listed.find((c) => c.names.some((n) => n.toLowerCase() === lower))?.id ?? entry;
      });
      return [...new Set(ids)];
    }
    return listed.length ? listed.map((c) => c.id) : ['primary'];
  }

  async listChangesSince(
    calendarId: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    const limit = Math.max(1, Math.floor(opts?.limit ?? 500));
    const prior = readCursor(cursor);
    if (cursor !== undefined && !prior) {
      log.info(
        `${this.typeId} ${calendarId}: cursor is from an older version; re-listing the window`,
      );
    }
    const cur = prior ?? this.freshCursor();
    try {
      return await this.collect(calendarId, cur, limit);
    } catch (err) {
      if (isGoogleThrottle(err)) return { records: [], cursor, rateLimited: true };
      // A 410 is Google's "full sync required". A 400 on a stored page token
      // means the token outlived its listing; restart that listing too.
      if (hasStatus(err, 410) || (hasStatus(err, 400) && cur.pageToken)) {
        log.info(`${this.typeId} ${calendarId}: sync position rejected; starting a full resync`);
        const fresh = this.freshCursor();
        try {
          return await this.collect(calendarId, fresh, limit);
        } catch (again) {
          if (isGoogleThrottle(again)) return { records: [], cursor: fresh, rateLimited: true };
          throw this.explain(again, calendarId);
        }
      }
      throw this.explain(err, calendarId);
    }
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const raw = ref.raw as GoogleRef | undefined;
    if (!raw?.event) throw new Error(`calendar event ${ref.id} arrived without its body`);
    return calendarEventToRecord(
      await googleEventToCalendarEvent(raw.event, {
        calendarId: raw.calendarId,
        ...(raw.calendarName ? { calendarName: raw.calendarName } : {}),
        ...(raw.calendarTimeZone ? { calendarTimeZone: raw.calendarTimeZone } : {}),
      }),
    );
  }

  async close(): Promise<void> {}

  private freshCursor(): GoogleCalendarCursor {
    return { v: 1, window: windowAt(this.now(), this.windowConfig) };
  }

  /**
   * Page through one listing until it ends or the batch is full. A page is
   * started only when it fits in the remaining room, so with the engine's
   * default batch the offset-into-a-page path is rare.
   */
  private async collect(
    calendarId: string,
    cur: GoogleCalendarCursor,
    limit: number,
  ): Promise<ChangeBatch<GoogleCalendarCursor>> {
    const records: RecordRef[] = [];
    const removed: string[] = [];
    let pageToken = cur.pageToken;
    let offset = cur.offset ?? 0;
    for (let guard = 0; guard < 10_000; guard++) {
      let page: GoogleEventsPage;
      try {
        page = await authorizedJson<GoogleEventsPage>(
          this.session,
          this.fetchImpl,
          this.eventsUrl(calendarId, cur, pageToken),
          {},
          'Google Calendar',
        );
      } catch (err) {
        if (isGoogleThrottle(err) && (records.length > 0 || removed.length > 0)) {
          return { records, removed, cursor: cursorAt(cur, pageToken, offset), rateLimited: true };
        }
        throw err;
      }
      const items = page.items ?? [];
      let i = offset;
      for (; i < items.length && records.length < limit; i++) {
        this.classify(items[i]!, calendarId, page, cur, records, removed);
      }
      if (i < items.length) {
        return { records, removed, cursor: cursorAt(cur, pageToken, i), partial: true };
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        offset = 0;
        if (limit - records.length < PAGE_SIZE) {
          return { records, removed, cursor: cursorAt(cur, pageToken), partial: true };
        }
        continue;
      }
      if (!page.nextSyncToken) {
        throw new Error('Google Calendar ended a listing without a sync token');
      }
      const done: GoogleCalendarCursor = {
        v: 1,
        window: cur.window,
        syncToken: page.nextSyncToken,
      };
      if (windowNeedsRefresh(done.window, this.now(), this.windowConfig)) {
        // Deletions up to now are already in this batch; the fresh listing
        // only has to bring the new far edge (or the new config) in.
        return { records, removed, cursor: this.freshCursor(), partial: true };
      }
      return { records, removed, cursor: done };
    }
    throw new Error('Google Calendar listing did not end');
  }

  private classify(
    ev: GoogleCalendarEvent,
    calendarId: string,
    page: GoogleEventsPage,
    cur: GoogleCalendarCursor,
    records: RecordRef[],
    removed: string[],
  ): void {
    if (!ev.id) return;
    const recordId = calendarRecordId(calendarId, ev.id);
    if (ev.status === 'cancelled') {
      removed.push(recordId);
      return;
    }
    // A daily "working from home" marker per day is noise, not an appointment.
    if (ev.eventType === 'workingLocation') return;
    const start = ev.start?.dateTime ?? ev.start?.date;
    const end = ev.end?.dateTime ?? ev.end?.date;
    if (cur.syncToken && !overlapsWindow(start, end, cur.window)) {
      removed.push(recordId);
      return;
    }
    const ordinalKey = eventTimeMs(start);
    const raw: GoogleRef = {
      event: ev,
      calendarId,
      ...(page.summary ? { calendarName: page.summary } : {}),
      ...(page.timeZone ? { calendarTimeZone: page.timeZone } : {}),
    };
    records.push({
      id: ev.id,
      raw,
      ...(ordinalKey !== undefined ? { ordinalKey } : {}),
      ...(ev.updated ? { ts: ev.updated } : {}),
    });
  }

  private eventsUrl(calendarId: string, cur: GoogleCalendarCursor, pageToken?: string): string {
    const params = new URLSearchParams({
      singleEvents: 'true',
      showDeleted: 'true',
      maxResults: String(PAGE_SIZE),
    });
    if (cur.syncToken) {
      params.set('syncToken', cur.syncToken);
    } else {
      params.set('timeMin', cur.window.start);
      params.set('timeMax', cur.window.end);
    }
    if (pageToken) params.set('pageToken', pageToken);
    return `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  }

  private async calendarList(): Promise<{ id: string; names: string[] }[]> {
    const out: { id: string; names: string[] }[] = [];
    let pageToken: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const params = new URLSearchParams({ maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await authorizedJson<GoogleCalendarListPage>(
        this.session,
        this.fetchImpl,
        `${GOOGLE_CALENDAR_API}/users/me/calendarList?${params}`,
        {},
        'Google Calendar',
      );
      for (const c of page.items ?? []) {
        if (!c.id) continue;
        const names = [c.summaryOverride, c.summary].filter((n): n is string => !!n);
        out.push({ id: c.id, names });
      }
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return out;
  }

  private explain(err: unknown, calendarId: string): unknown {
    if (hasStatus(err, 404)) {
      return new Error(
        `Google Calendar "${calendarId}" was not found or is not shared with this account. Remove it from the connector's calendar list.`,
      );
    }
    return err;
  }
}

function configuredCalendars(config: Record<string, unknown> | undefined): string[] {
  const raw = config?.calendars;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());
}

/**
 * Register the calendar native adapters: Google here, and Microsoft's so the
 * one existing wiring call covers both providers.
 */
export function registerCalendarAdapters(): void {
  registerNativeAdapter(GOOGLE_CALENDAR_TYPE_ID, async (binding, deps) =>
    Promise.resolve(new GoogleCalendarAdapter(binding, deps)),
  );
  registerMicrosoftCalendarAdapters();
}
