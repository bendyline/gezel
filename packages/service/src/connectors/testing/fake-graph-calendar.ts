/**
 * An in-process Microsoft Graph v1.0 calendar service for connector tests.
 *
 * It models calendarView delta as documented at
 * https://learn.microsoft.com/en-us/graph/delta-query-events and
 * https://learn.microsoft.com/en-us/graph/api/event-delta:
 *
 * - A round starts at `/me/calendars/{id}/calendarView/delta` with
 *   `startDateTime` + `endDateTime` (400 without them). Every later request
 *   follows an `@odata.nextLink` (`$skiptoken`) or, once the round is done,
 *   the `@odata.deltaLink` (`$deltatoken`); both tokens carry the range, so
 *   the range is fixed for the round.
 * - `Prefer: odata.maxpagesize=N` caps a page (default 10 here) and is echoed
 *   in `Preference-Applied`.
 * - `$select`, `$filter`, `$orderby`, `$expand` and `$search` are refused.
 * - An incremental round reports a deleted event as
 *   `{ id, "@removed": { reason: "deleted" } }`, and an event changed to fall
 *   outside the range the same way.
 * - Times are served in UTC (`2026-10-20T16:00:00.0000000`, `timeZone: UTC`),
 *   with the event's own Windows zone in `originalStartTimeZone`.
 * - Expired state answers 410 Gone.
 *
 * Calendar and event ids imitate Exchange ids: long, base64-ish, sharing a
 * per-mailbox prefix — which is what makes naive id-derived folder names
 * collide.
 */

import type { StoredOAuthCredential } from '../natives/oauth-session.js';
import { FakeHttp, FakeTokenEndpoint, json, status } from './fake-http.js';

export const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** The shared mailbox prefix every id in one fake account starts with. */
const MAILBOX = 'AAMkADQ0ZjMyNTQ5LWY2NWQtNDA3MS04ZWMwLTFmYzZmMjE2YjU0MwBGAAAAAAB';

export type GraphResponseValue =
  | 'none'
  | 'organizer'
  | 'tentativelyAccepted'
  | 'accepted'
  | 'declined'
  | 'notResponded';

export interface FakeGraphEventInit {
  id?: string;
  subject?: string;
  body?: { contentType: 'html' | 'text'; content: string };
  /** UTC instant for a timed event; `YYYY-MM-DD` for an all-day one. */
  start: string;
  end: string;
  isAllDay?: boolean;
  originalStartTimeZone?: string;
  location?: string;
  organizer?: { name?: string; address: string };
  attendees?: {
    name?: string;
    address: string;
    type?: 'required' | 'optional' | 'resource';
    response?: GraphResponseValue;
  }[];
  isOrganizer?: boolean;
  responseStatus?: GraphResponseValue;
  joinUrl?: string;
  seriesMasterId?: string;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  showAs?: string;
  isCancelled?: boolean;
}

/** The served `event` resource (a realistic subset). */
export type FakeGraphEvent = Record<string, unknown> & { id: string };

interface StoredEvent {
  init: FakeGraphEventInit;
  resource: FakeGraphEvent;
  deleted: boolean;
  modifiedAt: number;
}

interface FakeCalendar {
  id: string;
  name: string;
  isDefaultCalendar: boolean;
  events: Map<string, StoredEvent>;
}

interface Round {
  cal: string;
  window: { start: number; end: number };
  version: number;
  items: Record<string, unknown>[];
  offset: number;
}

function graphError(code: number, errorCode: string, message: string): Response {
  return status(code, {
    error: {
      code: errorCode,
      message,
      innerError: {
        date: '2026-10-19T12:00:00',
        'request-id': 'fake',
        'client-request-id': 'fake',
      },
    },
  });
}

/** `2026-10-20T16:00:00.000Z` → Graph's `2026-10-20T16:00:00.0000000`. */
function graphDateTime(value: string, allDay: boolean): string {
  if (allDay) return `${value.slice(0, 10)}T00:00:00.0000000`;
  return new Date(value).toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => `.${ms}0000`);
}

function rangeMs(init: FakeGraphEventInit): { start: number; end: number } {
  return { start: Date.parse(init.start), end: Date.parse(init.end) };
}

export interface FakeGraphCalendarOptions {
  /** Answer pagination with links on this origin (an attacker's), for the URL guard test. */
  linkOrigin?: string;
}

export class FakeGraphCalendar {
  readonly http = new FakeHttp();
  readonly tokens: FakeTokenEndpoint;
  /** Page size when the request sends no `odata.maxpagesize`. */
  defaultPageSize = 10;
  private readonly calendars = new Map<string, FakeCalendar>();
  private readonly skipStates = new Map<string, Round>();
  private readonly deltaStates = new Map<string, Omit<Round, 'items' | 'offset'>>();
  private version = 0;
  private nextId = 1;
  private nextToken = 1;
  private accessRevoked = false;

  constructor(private readonly opts: FakeGraphCalendarOptions = {}) {
    // Microsoft rotates refresh tokens on every use.
    this.tokens = new FakeTokenEndpoint(MICROSOFT_TOKEN_URL, { rotateRefreshToken: true }).install(
      this.http,
    );
    this.http.on('GET', `${GRAPH_V1}/me/calendars`, (req) => {
      const denied = this.authFailure(req.bearer);
      if (denied) return denied;
      const top = Math.min(Number(req.url.searchParams.get('$top')) || 10, 1000);
      const skip = Number(req.url.searchParams.get('$skip')) || 0;
      const all = [...this.calendars.values()];
      return json({
        '@odata.context': `${GRAPH_V1}/$metadata#users('fake')/calendars`,
        ...(skip + top < all.length
          ? { '@odata.nextLink': `${GRAPH_V1}/me/calendars?$top=${top}&$skip=${skip + top}` }
          : {}),
        value: all.slice(skip, skip + top).map((c) => ({
          id: c.id,
          name: c.name,
          color: 'auto',
          hexColor: '',
          isDefaultCalendar: c.isDefaultCalendar,
          changeKey: 'nfZyf7VcrEKLNoU37KWlkQAAA0x0+w==',
          canShare: true,
          canViewPrivateItems: true,
          canEdit: true,
          allowedOnlineMeetingProviders: ['teamsForBusiness'],
          defaultOnlineMeetingProvider: 'teamsForBusiness',
          isTallyingResponses: true,
          isRemovable: !c.isDefaultCalendar,
          owner: { name: 'Samantha Booth', address: 'samanthab@contoso.com' },
        })),
      });
    });
    this.http.on('GET', `${GRAPH_V1}/me/calendars/:calendarId/calendarView/delta`, (req, p) =>
      this.delta(req.url.searchParams, req.headers, p.calendarId!, req.bearer),
    );
  }

  // ── Fixture API ────────────────────────────────────────────────────────

  addCalendar(init: { name: string; isDefaultCalendar?: boolean; id?: string }): string {
    const id =
      init.id ?? `${MAILBOX}${Buffer.from(`calendar-${this.nextId++}`).toString('base64')}AAA=`;
    this.calendars.set(id, {
      id,
      name: init.name,
      isDefaultCalendar: init.isDefaultCalendar ?? false,
      events: new Map(),
    });
    return id;
  }

  addEvent(calendarId: string, init: FakeGraphEventInit): FakeGraphEvent {
    const cal = this.cal(calendarId);
    const id =
      init.id ??
      `${MAILBOX}BwBFwMUmXb07RIZlw7m8SK4AAAAAAQ0A${String(this.nextId++).padStart(6, '0')}AAA=`;
    const stamp = ++this.version;
    const resource = this.render(id, init, stamp);
    cal.events.set(id, { init: { ...init, id }, resource, deleted: false, modifiedAt: stamp });
    return resource;
  }

  updateEvent(calendarId: string, id: string, patch: Partial<FakeGraphEventInit>): FakeGraphEvent {
    const stored = this.stored(calendarId, id);
    const stamp = ++this.version;
    stored.init = { ...stored.init, ...patch };
    stored.resource = this.render(id, stored.init, stamp);
    stored.modifiedAt = stamp;
    return stored.resource;
  }

  /** Hard delete: the next incremental round reports `@removed`. */
  deleteEvent(calendarId: string, id: string): void {
    const stored = this.stored(calendarId, id);
    stored.deleted = true;
    stored.modifiedAt = ++this.version;
  }

  /** The organizer cancelled: the attendee's copy stays, flagged `isCancelled`. */
  cancelMeeting(calendarId: string, id: string): void {
    const stored = this.stored(calendarId, id);
    this.updateEvent(calendarId, id, {
      isCancelled: true,
      subject: `Canceled: ${stored.init.subject ?? ''}`,
    });
  }

  events(calendarId: string): FakeGraphEvent[] {
    return [...this.cal(calendarId).events.values()]
      .filter((s) => !s.deleted)
      .map((s) => s.resource);
  }

  /** Forget every skip and delta token (Graph's state cache evicted them). */
  expireDeltaTokens(): void {
    this.skipStates.clear();
    this.deltaStates.clear();
  }

  revokeAccessTokens(): void {
    this.accessRevoked = true;
  }

  credential(overrides: Partial<StoredOAuthCredential> = {}): StoredOAuthCredential {
    return {
      accessToken: 'seed-access',
      refreshToken: this.tokens.issueRefreshToken(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: '00000000-0000-0000-0000-00000000c0de',
      tenant: 'common',
      tokenUrl: MICROSOFT_TOKEN_URL,
      ...overrides,
    };
  }

  // ── The API ────────────────────────────────────────────────────────────

  private delta(
    q: URLSearchParams,
    headers: Headers,
    calendarId: string,
    bearer: string | undefined,
  ): Response {
    const denied = this.authFailure(bearer);
    if (denied) return denied;
    const cal = this.calendars.get(calendarId);
    if (!cal) {
      return graphError(
        404,
        'ErrorItemNotFound',
        'The specified object was not found in the store.',
      );
    }
    for (const p of ['$select', '$filter', '$orderby', '$expand', '$search']) {
      if (q.has(p)) {
        return graphError(
          400,
          'ErrorInvalidUrlQuery',
          `The query parameter '${p}' is not supported with change tracking over the 'CalendarView' resource.`,
        );
      }
    }
    const asked = /odata\.maxpagesize=(\d+)/i.exec(headers.get('prefer') ?? '')?.[1];
    const pageSize = asked ? Math.max(1, Number(asked)) : this.defaultPageSize;

    const skiptoken = q.get('$skiptoken');
    const deltatoken = q.get('$deltatoken');
    let round: Round;
    if (skiptoken) {
      const st = this.skipStates.get(skiptoken);
      if (!st || st.cal !== calendarId) return this.gone();
      round = st;
    } else if (deltatoken) {
      const dt = this.deltaStates.get(deltatoken);
      if (!dt || dt.cal !== calendarId) return this.gone();
      round = {
        cal: calendarId,
        window: dt.window,
        version: this.version,
        offset: 0,
        items: [...cal.events.values()]
          .filter((s) => s.modifiedAt > dt.version)
          .map((s) =>
            s.deleted || !this.overlaps(s.init, dt.window)
              ? this.removedStub(s.resource.id)
              : s.resource,
          ),
      };
    } else {
      const start = q.get('startDateTime') ?? q.get('startdatetime');
      const end = q.get('endDateTime') ?? q.get('enddatetime');
      if (!start || !end) {
        return graphError(
          400,
          'ErrorInvalidParameter',
          'This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.',
        );
      }
      const window = { start: Date.parse(start), end: Date.parse(end) };
      if (!Number.isFinite(window.start) || !Number.isFinite(window.end)) {
        return graphError(
          400,
          'ErrorInvalidParameter',
          'The value of the StartDateTime or EndDateTime parameter is invalid.',
        );
      }
      round = {
        cal: calendarId,
        window,
        version: this.version,
        offset: 0,
        items: [...cal.events.values()]
          .filter((s) => !s.deleted && this.overlaps(s.init, window))
          .map((s) => s.resource),
      };
    }

    const page = round.items.slice(round.offset, round.offset + pageSize);
    const more = round.offset + pageSize < round.items.length;
    const token = `tok${this.nextToken++}`;
    const base = `${this.opts.linkOrigin ?? 'https://graph.microsoft.com'}/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta`;
    if (more) this.skipStates.set(token, { ...round, offset: round.offset + pageSize });
    else
      this.deltaStates.set(token, {
        cal: calendarId,
        window: round.window,
        version: round.version,
      });
    return json(
      {
        '@odata.context': `${GRAPH_V1}/$metadata#Collection(event)`,
        ...(more
          ? { '@odata.nextLink': `${base}?$skiptoken=${token}` }
          : { '@odata.deltaLink': `${base}?$deltatoken=${token}` }),
        value: page,
      },
      { headers: { 'Preference-Applied': `odata.maxpagesize=${pageSize}` } },
    );
  }

  private overlaps(init: FakeGraphEventInit, window: { start: number; end: number }): boolean {
    const r = rangeMs(init);
    return r.end > window.start && r.start < window.end;
  }

  private removedStub(id: string): Record<string, unknown> {
    return { '@odata.type': '#microsoft.graph.event', id, '@removed': { reason: 'deleted' } };
  }

  private gone(): Response {
    return graphError(
      410,
      'SyncStateNotFound',
      'The sync state is not found or has expired. Restart the synchronization.',
    );
  }

  private render(id: string, init: FakeGraphEventInit, stamp: number): FakeGraphEvent {
    const allDay = init.isAllDay ?? false;
    const zone = init.originalStartTimeZone ?? 'Pacific Standard Time';
    const organizer = init.organizer ?? {
      name: 'Samantha Booth',
      address: 'samanthab@contoso.com',
    };
    const content = init.body?.content ?? '';
    const changeKey = Buffer.from(`ck-${id}-${stamp}`).toString('base64');
    return {
      '@odata.type': '#microsoft.graph.event',
      '@odata.etag': `W/"${changeKey}"`,
      createdDateTime: '2026-09-01T12:00:00.0000000Z',
      lastModifiedDateTime: new Date(Date.UTC(2026, 9, 1) + stamp * 1000).toISOString(),
      changeKey,
      categories: [],
      transactionId: null,
      originalStartTimeZone: zone,
      originalEndTimeZone: zone,
      iCalUId: `040000008200E00074C5B7101A82E008000000${String(stamp).padStart(8, '0')}`,
      uid: `040000008200E00074C5B7101A82E008000000${String(stamp).padStart(8, '0')}`,
      reminderMinutesBeforeStart: 15,
      isReminderOn: true,
      hasAttachments: false,
      subject: init.subject ?? '',
      bodyPreview: content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 255),
      importance: 'normal',
      sensitivity: 'normal',
      isAllDay: allDay,
      isCancelled: init.isCancelled ?? false,
      isOrganizer: init.isOrganizer ?? false,
      responseRequested: true,
      seriesMasterId: init.seriesMasterId ?? null,
      showAs: init.showAs ?? 'busy',
      type: init.type ?? (init.seriesMasterId ? 'occurrence' : 'singleInstance'),
      webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`,
      onlineMeetingUrl: null,
      isOnlineMeeting: !!init.joinUrl,
      onlineMeetingProvider: init.joinUrl ? 'teamsForBusiness' : 'unknown',
      allowNewTimeProposals: true,
      occurrenceId: null,
      isDraft: false,
      hideAttendees: false,
      recurrence: null,
      onlineMeeting: init.joinUrl ? { joinUrl: init.joinUrl } : null,
      id,
      responseStatus: { response: init.responseStatus ?? 'none', time: '0001-01-01T00:00:00Z' },
      body: { contentType: init.body?.contentType ?? 'html', content },
      start: { dateTime: graphDateTime(init.start, allDay), timeZone: 'UTC' },
      end: { dateTime: graphDateTime(init.end, allDay), timeZone: 'UTC' },
      location: {
        displayName: init.location ?? '',
        locationType: 'default',
        uniqueIdType: 'unknown',
        address: {},
        coordinates: {},
      },
      locations: init.location
        ? [{ displayName: init.location, locationType: 'default', uniqueIdType: 'unknown' }]
        : [],
      attendees: (init.attendees ?? []).map((a) => ({
        type: a.type ?? 'required',
        status: { response: a.response ?? 'none', time: '0001-01-01T00:00:00Z' },
        emailAddress: { name: a.name ?? a.address, address: a.address },
      })),
      organizer: {
        emailAddress: { name: organizer.name ?? organizer.address, address: organizer.address },
      },
    };
  }

  private authFailure(bearer: string | undefined): Response | null {
    if (!bearer || this.accessRevoked) {
      return graphError(
        401,
        'InvalidAuthenticationToken',
        'Access token has expired or is not yet valid.',
      );
    }
    return null;
  }

  private cal(id: string): FakeCalendar {
    const cal = this.calendars.get(id);
    if (!cal) throw new Error(`FakeGraphCalendar: no calendar ${id}`);
    return cal;
  }

  private stored(calendarId: string, id: string): StoredEvent {
    const s = this.cal(calendarId).events.get(id);
    if (!s) throw new Error(`FakeGraphCalendar: no event ${id}`);
    return s;
  }
}
