/**
 * Outlook calendars — Microsoft 365 work/school and personal Outlook.com —
 * through Microsoft Graph, as a `native` connector adapter. Events normalize
 * through `calendar-shared.ts` into exactly the record shape Google Calendar
 * produces.
 *
 * Sync is calendarView delta per calendar
 * (https://learn.microsoft.com/en-us/graph/delta-query-events):
 *
 * - A round starts with `/me/calendars/{id}/calendarView/delta` and an
 *   explicit `startDateTime`/`endDateTime`. The tokens in `@odata.nextLink`
 *   and `@odata.deltaLink` encode that range, so the window is fixed for the
 *   life of the round; sliding it means starting a new round.
 * - `$select` is not supported on calendarView delta: the response carries
 *   the full event (body included), so no follow-up GET is needed.
 * - `@removed` reports deletions inside the range and also events changed to
 *   fall outside it; both become tombstones. A meeting its organizer
 *   cancelled stays in an attendee's calendar with `isCancelled: true`; it is
 *   tombstoned too, matching Google, where a cancelled event leaves.
 * - Times arrive in UTC (no `Prefer: outlook.timezone`); the event's own zone
 *   (`originalStartTimeZone`, usually a Windows zone name) is mapped to IANA
 *   for the shared `timezone` field and the local-day bucket.
 * - 410 Gone (or a sync-state error) starts a fresh round in the same pass.
 *
 * The bearer token goes only to the Graph origin: pagination links are
 * checked against `https://graph.microsoft.com/v1.0/me/` before use.
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
import { sha8 } from '../writer.js';
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
  readWindow,
  readWindowConfig,
  toUtcInstant,
  windowAt,
  windowNeedsRefresh,
  zonedWallTimeToUtc,
} from './calendar-shared.js';
import {
  MICROSOFT_OAUTH,
  OAuthSession,
  authorizedJson,
  hasStatus,
  isThrottle,
  transport,
} from './oauth-session.js';

const log = createLogger('connectors');

export const MICROSOFT_CALENDAR_TYPE_ID = 'calendar-microsoft';
export const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';

/** Graph treats `odata.maxpagesize` as a ceiling; it may send fewer. */
const PAGE_SIZE = 100;

/**
 * Accept only Graph `/v1.0/me/…` URLs. Pagination links come from the
 * response body, and the bearer token rides every request made with them.
 */
export function trustedGraphUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('refusing a malformed Microsoft Graph pagination URL');
  }
  if (
    parsed.origin !== GRAPH_ORIGIN ||
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !parsed.pathname.startsWith('/v1.0/me/')
  ) {
    throw new Error('refusing an untrusted Microsoft Graph pagination URL');
  }
  return parsed.href;
}

interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}

interface GraphEmail {
  emailAddress?: { name?: string; address?: string };
}

/** The `event` resource fields this adapter reads. */
export interface GraphCalendarEvent {
  id?: string;
  '@removed'?: { reason?: string };
  subject?: string;
  body?: { contentType?: string; content?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  originalStartTimeZone?: string;
  location?: { displayName?: string };
  locations?: { displayName?: string }[];
  organizer?: GraphEmail;
  attendees?: (GraphEmail & { type?: string; status?: { response?: string } })[];
  responseStatus?: { response?: string };
  webLink?: string;
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  seriesMasterId?: string | null;
  type?: string;
  showAs?: string;
  lastModifiedDateTime?: string;
}

interface GraphDeltaPage {
  value?: GraphCalendarEvent[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphCalendarsPage {
  value?: { id?: string; name?: string; isDefaultCalendar?: boolean }[];
  '@odata.nextLink'?: string;
}

/**
 * Per-calendar cursor: `next` mid-round (a nextLink), `delta` once a round
 * completed (the deltaLink the next round starts from).
 */
export interface MicrosoftCalendarCursor {
  v: 1;
  window: CalendarWindow;
  next?: string;
  delta?: string;
}

interface MicrosoftCalendar {
  id: string;
  name: string;
}

interface MicrosoftRef {
  event: GraphCalendarEvent;
  calendarId: string;
  calendarName?: string;
}

/**
 * The scope (and corpus folder) for a calendar. Graph calendar ids are long,
 * share a per-mailbox prefix, and differ near the end; the engine slugs a
 * scope to 48 characters, which would put every calendar of a mailbox in one
 * folder. A hash of the id is short, unique, and survives a rename; each
 * record names its calendar in the `calendar` field.
 */
export function microsoftCalendarScope(calendarId: string): string {
  return `cal-${sha8(calendarId)}`;
}

/**
 * Windows zone names Outlook writes in `originalStartTimeZone`, mapped to
 * IANA per CLDR's windowsZones (territory 001). Unlisted names keep the raw
 * name in `timezone` and fall back to the UTC date for the bucket.
 */
const WINDOWS_ZONES: Record<string, string> = {
  UTC: 'UTC',
  'tzone://Microsoft/Utc': 'UTC',
  'Coordinated Universal Time': 'UTC',
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Central America Standard Time': 'America/Guatemala',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** A Graph zone name → IANA, when it is one or maps to one. */
export function graphZoneToIana(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  const mapped = WINDOWS_ZONES[zone];
  if (mapped && isKnownTimeZone(mapped)) return mapped;
  return isKnownTimeZone(zone) ? zone : undefined;
}

/** A Graph `dateTimeTimeZone` → UTC instant. */
function graphInstant(t: GraphDateTime | undefined): string | undefined {
  if (!t?.dateTime) return undefined;
  const zone = graphZoneToIana(t.timeZone ?? 'UTC');
  if (!zone || zone === 'UTC') return toUtcInstant(`${t.dateTime}Z`);
  return zonedWallTimeToUtc(t.dateTime, zone);
}

function graphResponse(raw: string | undefined): CalendarResponse | undefined {
  switch (raw) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentativelyAccepted':
      return 'tentative';
    case 'organizer':
      return 'organizer';
    case 'none':
    case 'notResponded':
      return 'needs-action';
    default:
      return undefined;
  }
}

export interface MicrosoftCalendarContext {
  calendarId: string;
  calendarName?: string;
}

/** Raw Graph event → the canonical calendar event. */
export async function graphEventToCalendarEvent(
  event: GraphCalendarEvent,
  ctx: MicrosoftCalendarContext,
): Promise<CalendarEvent> {
  const allDay = event.isAllDay === true;
  const zone = graphZoneToIana(event.originalStartTimeZone);
  const startInstant = graphInstant(event.start);
  const endInstant = graphInstant(event.end);
  // An all-day event spans whole dates; its midnight is not an instant.
  const start = allDay ? event.start?.dateTime?.slice(0, 10) : startInstant;
  const end = allDay ? event.end?.dateTime?.slice(0, 10) : endInstant;
  const localDate = allDay
    ? start
    : (localDateIn(startInstant, zone) ?? startInstant?.slice(0, 10));
  const organizer = event.organizer?.emailAddress;
  const organizerEmail = organizer?.address?.toLowerCase();
  const people = (event.attendees ?? []).filter((a) => a.type !== 'resource');
  const attendees: CalendarAttendee[] = people
    .filter((a) => !(organizerEmail && a.emailAddress?.address?.toLowerCase() === organizerEmail))
    .map((a) => {
      const response = graphResponse(a.status?.response);
      return {
        ...(a.emailAddress?.name ? { name: a.emailAddress.name } : {}),
        ...(a.emailAddress?.address ? { email: a.emailAddress.address } : {}),
        ...(response ? { response } : {}),
        ...(a.type === 'optional' ? { optional: true } : {}),
      };
    });
  let myResponse: CalendarResponse | undefined;
  if (people.length > 0) {
    myResponse =
      event.isOrganizer || event.responseStatus?.response === 'organizer'
        ? 'organizer'
        : graphResponse(event.responseStatus?.response);
  }
  const location =
    event.location?.displayName?.trim() ||
    (event.locations ?? [])
      .map((l) => l.displayName?.trim())
      .filter(Boolean)
      .join('; ');
  const joinUrl = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? undefined;
  const contentType = event.body?.contentType?.toLowerCase();
  return {
    provider: 'microsoft',
    typeId: MICROSOFT_CALENDAR_TYPE_ID,
    calendarId: ctx.calendarId,
    ...(ctx.calendarName ? { calendarName: ctx.calendarName } : {}),
    eventId: event.id ?? '',
    title: event.subject ?? '',
    allDay,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(localDate ? { localDate } : {}),
    ...((zone ?? event.originalStartTimeZone)
      ? { timeZone: zone ?? event.originalStartTimeZone }
      : {}),
    ...(location ? { location } : {}),
    ...(organizer?.address || organizer?.name
      ? {
          organizer: {
            ...(organizer.name ? { name: organizer.name } : {}),
            ...(organizer.address ? { email: organizer.address } : {}),
          },
        }
      : {}),
    attendees,
    ...(myResponse ? { myResponse } : {}),
    status: 'confirmed',
    ...(event.showAs === 'oof' ? { eventType: 'out-of-office' as const } : {}),
    ...(event.webLink ? { url: event.webLink } : {}),
    ...(joinUrl ? { onlineMeetingUrl: joinUrl } : {}),
    ...(event.seriesMasterId ? { seriesId: event.seriesMasterId } : {}),
    bodyMarkdown: await bodyToMarkdown(
      event.body?.content,
      contentType === 'html' ? true : contentType === 'text' ? false : undefined,
    ),
  };
}

function readCursor(raw: unknown): MicrosoftCalendarCursor | undefined {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return undefined;
  const c = raw as Partial<MicrosoftCalendarCursor>;
  const window = readWindow(c.window);
  if (!window) return undefined;
  const link = (s: unknown): string | undefined => {
    if (typeof s !== 'string' || !s) return undefined;
    try {
      return trustedGraphUrl(s);
    } catch {
      return undefined;
    }
  };
  const next = link(c.next);
  const delta = link(c.delta);
  return { v: 1, window, ...(next ? { next } : {}), ...(delta ? { delta } : {}) };
}

/** Graph's "start over" signals: 410, or a sync-state error on 400/404. */
function isSyncReset(err: unknown): boolean {
  if (hasStatus(err, 410)) return true;
  return (
    hasStatus(err, 400, 404) &&
    /syncState|resyncRequired|InvalidDeltaToken|InvalidSkipToken/i.test((err as Error).message)
  );
}

export interface MicrosoftCalendarAdapterOptions {
  /** Clock seam for window tests. */
  now?: () => number;
}

export class MicrosoftCalendarAdapter implements ConnectorAdapter<NormalizedRecord, unknown> {
  readonly typeId = MICROSOFT_CALENDAR_TYPE_ID;
  /** Records are bucketed by start month, so a rescheduled event changes folders. */
  readonly recordsMayMove = true;
  private readonly session: OAuthSession;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly windowConfig: CalendarWindowConfig;
  private byScope: Map<string, MicrosoftCalendar> | null = null;

  constructor(
    private readonly binding: ConnectorBindingRef,
    deps: AdapterDeps,
    opts: MicrosoftCalendarAdapterOptions = {},
  ) {
    this.session = new OAuthSession(binding, deps, MICROSOFT_OAUTH);
    this.fetchImpl = transport(deps);
    this.now = opts.now ?? Date.now;
    this.windowConfig = readWindowConfig(binding.config);
  }

  async ensureAuth(): Promise<void> {
    await this.session.token();
  }

  /** The account's calendars, or the configured ones (by name or id). */
  async listScopes(): Promise<string[]> {
    const calendars = await this.loadCalendars();
    const configured = configuredCalendars(this.binding.config);
    let chosen = calendars;
    if (configured.length > 0) {
      const names = new Set(configured.map((c) => c.toLowerCase()));
      chosen = calendars.filter(
        (c) => configured.includes(c.id) || names.has(c.name.toLowerCase()),
      );
      if (chosen.length === 0) {
        throw new Error(
          `None of the configured calendars (${configured.join(', ')}) exist in this Microsoft account. Check the calendar names in the connector's settings.`,
        );
      }
    }
    this.byScope = new Map(chosen.map((c) => [microsoftCalendarScope(c.id), c]));
    return [...this.byScope.keys()];
  }

  async listChangesSince(
    scope: string,
    cursor: unknown,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<unknown>> {
    const calendar = await this.calendarFor(scope);
    const limit = Math.max(1, Math.floor(opts?.limit ?? 500));
    const prior = readCursor(cursor);
    const cur = prior ?? this.freshCursor();
    try {
      return await this.collect(calendar, cur, limit);
    } catch (err) {
      if (isThrottle(err)) return { records: [], cursor, rateLimited: true };
      if (isSyncReset(err)) {
        log.info(`${this.typeId} ${scope}: delta state expired; starting a fresh round`);
        const fresh = this.freshCursor();
        try {
          return await this.collect(calendar, fresh, limit);
        } catch (again) {
          if (isThrottle(again)) return { records: [], cursor: fresh, rateLimited: true };
          throw again;
        }
      }
      throw err;
    }
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const raw = ref.raw as MicrosoftRef | undefined;
    if (!raw?.event) throw new Error(`calendar event ${ref.id} arrived without its body`);
    return calendarEventToRecord(
      await graphEventToCalendarEvent(raw.event, {
        calendarId: raw.calendarId,
        ...(raw.calendarName ? { calendarName: raw.calendarName } : {}),
      }),
    );
  }

  async close(): Promise<void> {}

  private freshCursor(): MicrosoftCalendarCursor {
    return { v: 1, window: windowAt(this.now(), this.windowConfig) };
  }

  private initialUrl(calendarId: string, window: CalendarWindow): string {
    const params = new URLSearchParams({ startDateTime: window.start, endDateTime: window.end });
    return `${GRAPH_V1}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params}`;
  }

  private async collect(
    calendar: MicrosoftCalendar,
    cur: MicrosoftCalendarCursor,
    limit: number,
  ): Promise<ChangeBatch<MicrosoftCalendarCursor>> {
    const records: RecordRef[] = [];
    const removed: string[] = [];
    const pageSize = Math.min(PAGE_SIZE, limit);
    let url = trustedGraphUrl(cur.next ?? cur.delta ?? this.initialUrl(calendar.id, cur.window));
    for (let guard = 0; guard < 10_000; guard++) {
      let page: GraphDeltaPage;
      try {
        page = await authorizedJson<GraphDeltaPage>(
          this.session,
          this.fetchImpl,
          url,
          { headers: { Prefer: `odata.maxpagesize=${pageSize}` } },
          'Microsoft Graph',
        );
      } catch (err) {
        if (isThrottle(err) && (records.length > 0 || removed.length > 0)) {
          return {
            records,
            removed,
            cursor: { v: 1, window: cur.window, next: url },
            rateLimited: true,
          };
        }
        throw err;
      }
      for (const ev of page.value ?? []) this.classify(ev, calendar, records, removed);
      const nextLink = page['@odata.nextLink'];
      if (nextLink) {
        url = trustedGraphUrl(nextLink);
        if (limit - records.length < pageSize) {
          return {
            records,
            removed,
            cursor: { v: 1, window: cur.window, next: url },
            partial: true,
          };
        }
        continue;
      }
      const deltaLink = page['@odata.deltaLink'];
      if (!deltaLink)
        throw new Error('Microsoft Graph ended a calendar delta round without a delta link');
      const done: MicrosoftCalendarCursor = {
        v: 1,
        window: cur.window,
        delta: trustedGraphUrl(deltaLink),
      };
      if (windowNeedsRefresh(done.window, this.now(), this.windowConfig)) {
        // This round already brought deletions up to now; the new round only
        // has to cover the new range.
        return { records, removed, cursor: this.freshCursor(), partial: true };
      }
      return { records, removed, cursor: done };
    }
    throw new Error('Microsoft Graph calendar delta round did not end');
  }

  private classify(
    ev: GraphCalendarEvent,
    calendar: MicrosoftCalendar,
    records: RecordRef[],
    removed: string[],
  ): void {
    if (!ev.id) return;
    const recordId = calendarRecordId(calendar.id, ev.id);
    if (ev['@removed'] || ev.isCancelled) {
      removed.push(recordId);
      return;
    }
    // calendarView lists occurrences; a series master is not an appointment.
    if (ev.type === 'seriesMaster') return;
    const ordinalKey = eventTimeMs(graphInstant(ev.start));
    const raw: MicrosoftRef = { event: ev, calendarId: calendar.id, calendarName: calendar.name };
    records.push({
      id: ev.id,
      raw,
      ...(ordinalKey !== undefined ? { ordinalKey } : {}),
      ...(ev.lastModifiedDateTime ? { ts: ev.lastModifiedDateTime } : {}),
    });
  }

  private async calendarFor(scope: string): Promise<MicrosoftCalendar> {
    if (!this.byScope?.has(scope)) await this.listScopes();
    const calendar = this.byScope?.get(scope);
    if (!calendar) {
      throw new Error(`The Microsoft calendar for ${scope} is no longer in this account.`);
    }
    return calendar;
  }

  private async loadCalendars(): Promise<MicrosoftCalendar[]> {
    const out: (MicrosoftCalendar & { isDefault: boolean })[] = [];
    let url = `${GRAPH_V1}/me/calendars?$select=id,name,isDefaultCalendar&$top=100`;
    for (let guard = 0; guard < 50; guard++) {
      const page = await authorizedJson<GraphCalendarsPage>(
        this.session,
        this.fetchImpl,
        url,
        {},
        'Microsoft Graph',
      );
      for (const c of page.value ?? []) {
        if (c.id)
          out.push({ id: c.id, name: c.name ?? '', isDefault: c.isDefaultCalendar === true });
      }
      const next = page['@odata.nextLink'];
      if (!next) break;
      url = trustedGraphUrl(next);
    }
    // Default calendar first, so a pass that stops early has synced it.
    return out
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map(({ id, name }) => ({ id, name }));
  }
}

function configuredCalendars(config: Record<string, unknown> | undefined): string[] {
  const raw = config?.calendars;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    .map((c) => c.trim());
}

/** Register the Outlook / Microsoft 365 calendar native adapter. */
export function registerMicrosoftCalendarAdapters(): void {
  registerNativeAdapter(MICROSOFT_CALENDAR_TYPE_ID, async (binding, deps) =>
    Promise.resolve(new MicrosoftCalendarAdapter(binding, deps)),
  );
}
