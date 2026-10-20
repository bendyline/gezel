/**
 * An in-process Google Calendar API v3 for connector tests.
 *
 * It models the parts of the real service an incremental sync depends on,
 * as documented at https://developers.google.com/workspace/calendar/api/guides/sync
 * and .../v3/reference/events/list:
 *
 * - `events.list` pages by `maxResults` (default 250, max 2500) and returns
 *   `nextPageToken` on every page but the last; `nextSyncToken` appears ONLY
 *   on the last page.
 * - `syncToken` is refused (400) alongside `timeMin`, `timeMax`, `orderBy`,
 *   `q`, `updatedMin` or `iCalUID`, and its `singleEvents`/`showDeleted`
 *   must match the listing that minted it.
 * - An incremental listing returns every event changed since the token —
 *   cancelled ones included, in their stripped form — and is NOT clipped to
 *   the original window (Google does not promise it is).
 * - `timeMin` bounds an event's END and `timeMax` its START, both exclusive.
 * - An invalidated token answers 410 with the `fullSyncRequired` body.
 * - Rate limiting can be 429 or a 403 `rateLimitExceeded` body.
 *
 * Events are stored as already-expanded instances (the `singleEvents=true`
 * view), each carrying `recurringEventId` when it belongs to a series; the
 * fake refuses a listing without `singleEvents=true` rather than pretend to
 * expand series.
 */

import type { StoredOAuthCredential } from '../natives/oauth-session.js';
import { FakeHttp, FakeTokenEndpoint, json, status } from './fake-http.js';

export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface FakeGoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** The resource shape the fake serves (a realistic subset of `calendar#event`). */
export interface FakeGoogleEvent {
  kind: 'calendar#event';
  etag: string;
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  created?: string;
  updated: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: { email?: string; displayName?: string; self?: boolean };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  start?: FakeGoogleEventTime;
  end?: FakeGoogleEventTime;
  recurringEventId?: string;
  originalStartTime?: FakeGoogleEventTime;
  iCalUID?: string;
  sequence?: number;
  attendees?: {
    email?: string;
    displayName?: string;
    organizer?: boolean;
    self?: boolean;
    resource?: boolean;
    optional?: boolean;
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  }[];
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string; label?: string }[];
    conferenceSolution?: { name?: string };
    conferenceId?: string;
  };
  reminders?: { useDefault: boolean };
  eventType?: string;
  visibility?: string;
  transparency?: string;
}

export type FakeGoogleEventInit = Partial<Omit<FakeGoogleEvent, 'kind' | 'etag' | 'updated'>> & {
  start: FakeGoogleEventTime;
  end: FakeGoogleEventTime;
};

interface StoredEvent {
  /** Current served form. */
  resource: FakeGoogleEvent;
  /** Times kept for window filtering after a cancellation strips them. */
  start?: FakeGoogleEventTime;
  end?: FakeGoogleEventTime;
  /** Global change counter value of the last mutation. */
  modifiedAt: number;
}

interface FakeCalendar {
  id: string;
  summary: string;
  timeZone: string;
  primary: boolean;
  events: Map<string, StoredEvent>;
}

interface SyncState {
  cal: string;
  epoch: number;
  /** Change-counter value the listing that minted the token started at. */
  at: number;
  singleEvents: boolean;
  showDeleted: boolean;
}

interface PageState extends SyncState {
  mode: 'full' | 'incremental';
  /** For an incremental listing: changes after this counter value. */
  since: number;
  offset: number;
  timeMin?: string;
  timeMax?: string;
}

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode<T>(s: string): T | null {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function googleError(code: number, reason: string, message: string, extra: object = {}) {
  return status(code, {
    error: {
      errors: [{ domain: code === 410 ? 'calendar' : 'global', reason, message, ...extra }],
      code,
      message,
    },
  });
}

function timeMs(t: FakeGoogleEventTime | undefined): number | undefined {
  const raw = t?.dateTime ?? t?.date;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

export interface FakeGoogleCalendarOptions {
  /** Rotate refresh tokens on use (Google does not by default). */
  rotateRefreshToken?: boolean;
}

export class FakeGoogleCalendar {
  readonly http = new FakeHttp();
  readonly tokens: FakeTokenEndpoint;
  /** Pages never exceed this, whatever `maxResults` asks (Google may send fewer). */
  pageCap: number | undefined;
  private readonly calendars = new Map<string, FakeCalendar>();
  private version = 0;
  private epoch = 1;
  private nextId = 1;
  private accessRevoked = false;

  constructor(opts: FakeGoogleCalendarOptions = {}) {
    this.tokens = new FakeTokenEndpoint(GOOGLE_TOKEN_URL, {
      ...(opts.rotateRefreshToken ? { rotateRefreshToken: true } : {}),
    }).install(this.http);
    this.http.on('GET', `${GOOGLE_CALENDAR_API}/users/me/calendarList`, (req) => {
      const denied = this.authFailure(req.bearer);
      if (denied) return denied;
      const max = Math.min(Number(req.url.searchParams.get('maxResults')) || 100, 250);
      const offset = Number(req.url.searchParams.get('pageToken') ?? 0) || 0;
      const all = [...this.calendars.values()];
      const page = all.slice(offset, offset + max);
      return json({
        kind: 'calendar#calendarList',
        etag: `"p${this.version}"`,
        ...(offset + max < all.length
          ? { nextPageToken: String(offset + max) }
          : { nextSyncToken: `cl-${this.version}` }),
        items: page.map((c) => ({
          kind: 'calendar#calendarListEntry',
          etag: `"c${this.version}"`,
          id: c.id,
          summary: c.summary,
          timeZone: c.timeZone,
          colorId: '14',
          backgroundColor: '#9fe1e7',
          foregroundColor: '#000000',
          selected: true,
          accessRole: 'owner',
          defaultReminders: [{ method: 'popup', minutes: 10 }],
          conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] },
          ...(c.primary ? { primary: true } : {}),
        })),
      });
    });
    this.http.on('GET', `${GOOGLE_CALENDAR_API}/calendars/:calendarId/events`, (req, params) =>
      this.listEvents(req.url.searchParams, params.calendarId!, req.bearer),
    );
  }

  // ── Fixture API ────────────────────────────────────────────────────────

  addCalendar(id: string, init: { summary: string; timeZone?: string; primary?: boolean }): this {
    this.calendars.set(id, {
      id,
      summary: init.summary,
      timeZone: init.timeZone ?? 'America/Los_Angeles',
      primary: init.primary ?? false,
      events: new Map(),
    });
    return this;
  }

  /** Add an event; returns the served resource. */
  addEvent(calendarId: string, init: FakeGoogleEventInit): FakeGoogleEvent {
    const cal = this.cal(calendarId);
    const id = init.id ?? `evt${String(this.nextId++).padStart(6, '0')}`;
    const stamp = this.tick();
    const resource: FakeGoogleEvent = {
      kind: 'calendar#event',
      etag: `"${3_400_000_000_000 + stamp}"`,
      id,
      status: init.status ?? 'confirmed',
      htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${calendarId}`).toString('base64url')}`,
      created: '2026-09-01T12:00:00.000Z',
      updated: this.updatedAt(stamp),
      iCalUID: `${id}@google.com`,
      sequence: 0,
      creator: { email: calendarId, self: true },
      organizer: { email: calendarId, self: true },
      reminders: { useDefault: true },
      eventType: 'default',
      ...init,
    };
    cal.events.set(id, { resource, start: init.start, end: init.end, modifiedAt: stamp });
    return resource;
  }

  updateEvent(calendarId: string, id: string, patch: Partial<FakeGoogleEvent>): FakeGoogleEvent {
    const stored = this.stored(calendarId, id);
    const stamp = this.tick();
    stored.resource = {
      ...stored.resource,
      ...patch,
      etag: `"${3_400_000_000_000 + stamp}"`,
      updated: this.updatedAt(stamp),
      sequence: (stored.resource.sequence ?? 0) + 1,
    };
    if (patch.start) stored.start = patch.start;
    if (patch.end) stored.end = patch.end;
    stored.modifiedAt = stamp;
    return stored.resource;
  }

  /** Delete/cancel: the event is served stripped, with `status: cancelled`. */
  cancelEvent(calendarId: string, id: string): void {
    const stored = this.stored(calendarId, id);
    const stamp = this.tick();
    const r = stored.resource;
    stored.resource = {
      kind: 'calendar#event',
      etag: `"${3_400_000_000_000 + stamp}"`,
      id: r.id,
      status: 'cancelled',
      updated: this.updatedAt(stamp),
      ...(r.recurringEventId
        ? {
            recurringEventId: r.recurringEventId,
            originalStartTime: r.originalStartTime ?? r.start!,
          }
        : {}),
    };
    stored.modifiedAt = stamp;
  }

  event(calendarId: string, id: string): FakeGoogleEvent {
    return this.stored(calendarId, id).resource;
  }

  /** Live (non-cancelled) events of a calendar, in creation order. */
  events(calendarId: string): FakeGoogleEvent[] {
    return [...this.cal(calendarId).events.values()]
      .map((s) => s.resource)
      .filter((r) => r.status !== 'cancelled');
  }

  /** Invalidate every sync and page token (expiry, ACL change). */
  expireSyncTokens(): void {
    this.epoch++;
  }

  /** Make every API call answer 401, as a revoked grant does. */
  revokeAccessTokens(): void {
    this.accessRevoked = true;
  }

  /** A credential blob the adapter's `OAuthSession` accepts. */
  credential(overrides: Partial<StoredOAuthCredential> = {}): StoredOAuthCredential {
    return {
      accessToken: 'seed-access',
      refreshToken: this.tokens.issueRefreshToken(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'fake-google-client.apps.googleusercontent.com',
      clientSecret: 'fake-google-secret',
      tokenUrl: GOOGLE_TOKEN_URL,
      ...overrides,
    };
  }

  // ── The API ────────────────────────────────────────────────────────────

  private listEvents(q: URLSearchParams, calendarId: string, bearer: string | undefined): Response {
    const denied = this.authFailure(bearer);
    if (denied) return denied;
    const cal = this.calendars.get(calendarId);
    if (!cal) return googleError(404, 'notFound', 'Not Found');
    const syncToken = q.get('syncToken');
    const pageToken = q.get('pageToken');
    const singleEvents = q.get('singleEvents') === 'true';
    const showDeleted = q.get('showDeleted') === 'true';
    if (syncToken) {
      for (const p of ['timeMin', 'timeMax', 'orderBy', 'q', 'updatedMin', 'iCalUID']) {
        if (q.has(p)) {
          return googleError(
            400,
            'invalid',
            `The ${p} parameter cannot be used with a sync token.`,
          );
        }
      }
    }
    if (!singleEvents) {
      return googleError(
        400,
        'invalid',
        'FakeGoogleCalendar serves singleEvents=true listings only',
      );
    }
    const maxResults = Math.min(Number(q.get('maxResults')) || 250, 2500);
    const pageSize = Math.min(maxResults, this.pageCap ?? maxResults);

    let state: PageState;
    if (pageToken) {
      const s = decode<PageState>(pageToken);
      if (!s || s.cal !== calendarId)
        return googleError(400, 'invalid', 'Invalid page token value.');
      if (s.epoch !== this.epoch) {
        return googleError(
          410,
          'fullSyncRequired',
          'Sync token is no longer valid, a full sync is required.',
          {
            locationType: 'parameter',
            location: 'syncToken',
          },
        );
      }
      // A page token continues the SAME query: the sync token, or the window.
      const sameQuery =
        s.mode === 'incremental'
          ? !!syncToken
          : !syncToken &&
            (q.get('timeMin') ?? undefined) === s.timeMin &&
            (q.get('timeMax') ?? undefined) === s.timeMax;
      if (!sameQuery || s.singleEvents !== singleEvents || s.showDeleted !== showDeleted) {
        return googleError(400, 'invalid', 'The page token does not match the request parameters.');
      }
      state = s;
    } else if (syncToken) {
      const s = decode<SyncState>(syncToken);
      if (!s || s.cal !== calendarId || s.epoch !== this.epoch) {
        return googleError(
          410,
          'fullSyncRequired',
          'Sync token is no longer valid, a full sync is required.',
          {
            locationType: 'parameter',
            location: 'syncToken',
          },
        );
      }
      if (s.singleEvents !== singleEvents || s.showDeleted !== showDeleted) {
        return googleError(
          400,
          'invalid',
          'Sync token parameters do not match the original request.',
        );
      }
      state = { ...s, mode: 'incremental', since: s.at, at: this.version, offset: 0 };
    } else {
      const timeMin = q.get('timeMin') ?? undefined;
      const timeMax = q.get('timeMax') ?? undefined;
      if (timeMin && timeMax && Date.parse(timeMin) >= Date.parse(timeMax)) {
        return googleError(400, 'timeRangeEmpty', 'The specified time range is empty.');
      }
      state = {
        cal: calendarId,
        epoch: this.epoch,
        at: this.version,
        singleEvents,
        showDeleted,
        mode: 'full',
        since: 0,
        offset: 0,
        ...(timeMin ? { timeMin } : {}),
        ...(timeMax ? { timeMax } : {}),
      };
    }

    const matching = [...cal.events.values()].filter((s) => {
      if (state.mode === 'incremental') return s.modifiedAt > state.since;
      if (s.resource.status === 'cancelled' && !state.showDeleted) return false;
      const start = timeMs(s.start);
      const end = timeMs(s.end) ?? start;
      if (state.timeMin && end !== undefined && end <= Date.parse(state.timeMin)) return false;
      if (state.timeMax && start !== undefined && start >= Date.parse(state.timeMax)) return false;
      return true;
    });
    const items = matching.slice(state.offset, state.offset + pageSize).map((s) => s.resource);
    const more = state.offset + pageSize < matching.length;
    const sync: SyncState = {
      cal: calendarId,
      epoch: this.epoch,
      at: state.at,
      singleEvents: state.singleEvents,
      showDeleted: state.showDeleted,
    };
    return json({
      kind: 'calendar#events',
      etag: `"p${this.version}"`,
      summary: cal.summary,
      description: '',
      updated: this.updatedAt(this.version),
      timeZone: cal.timeZone,
      accessRole: 'owner',
      defaultReminders: [{ method: 'popup', minutes: 10 }],
      ...(more
        ? { nextPageToken: encode({ ...state, offset: state.offset + pageSize }) }
        : { nextSyncToken: encode(sync) }),
      items,
    });
  }

  private authFailure(bearer: string | undefined): Response | null {
    if (!bearer || this.accessRevoked) {
      return status(401, {
        error: {
          errors: [
            {
              domain: 'global',
              reason: 'authError',
              message: 'Invalid Credentials',
              locationType: 'header',
              location: 'Authorization',
            },
          ],
          code: 401,
          message: 'Invalid Credentials',
        },
      });
    }
    return null;
  }

  private cal(id: string): FakeCalendar {
    const cal = this.calendars.get(id);
    if (!cal) throw new Error(`FakeGoogleCalendar: no calendar ${id}`);
    return cal;
  }

  private stored(calendarId: string, id: string): StoredEvent {
    const s = this.cal(calendarId).events.get(id);
    if (!s) throw new Error(`FakeGoogleCalendar: no event ${id} in ${calendarId}`);
    return s;
  }

  private tick(): number {
    return ++this.version;
  }

  private updatedAt(stamp: number): string {
    return new Date(Date.UTC(2026, 9, 1) + stamp * 1000).toISOString();
  }
}
