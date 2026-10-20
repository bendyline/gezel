/**
 * One calendar record shape for every provider.
 *
 * Google Calendar and Microsoft Graph (Outlook.com, Microsoft 365) events both
 * normalize to the canonical `CalendarEvent` below, and only that becomes a
 * `NormalizedRecord`. The frontmatter keys, their value formats, and the
 * month-bucket layout are therefore identical across providers, so a craftbook
 * reasoning over "my calendar" never needs to know where an event came from:
 *
 *   <calendar scope>/<YYYY-MM>/NNN--<YYYY-MM-DD>--<title-slug>--<hash8>.md
 *
 * Value formats are chosen to compare across providers: `date`/`end` are UTC
 * instants (`2026-10-20T16:00:00.000Z`, which also sort as strings) for timed
 * events and plain dates for all-day ones; `timezone` is an IANA name whenever
 * the provider's zone can be mapped to one. The month bucket and the filename
 * date use the event's own local date, which is what a person calls the day.
 *
 * Volatile provider bookkeeping (etags, change keys, modification times,
 * reminder settings) never reaches the frontmatter: it changes without the
 * event changing, and every change rewrites the record.
 *
 * The window helpers live here too, because both providers mirror a sliding
 * range of time rather than a whole calendar (see `CalendarWindow`).
 */

import { htmlBodyToMarkdown } from '../../mail/html.js';
import type { NormalizedRecord } from '../types.js';
import { slug } from '../writer.js';

export type CalendarProvider = 'google' | 'microsoft';

/** A person's answer to an invitation, in one vocabulary for both providers. */
export type CalendarResponse = 'accepted' | 'declined' | 'tentative' | 'needs-action' | 'organizer';

export interface CalendarPerson {
  name?: string;
  email?: string;
}

export interface CalendarAttendee extends CalendarPerson {
  response?: CalendarResponse;
  optional?: boolean;
}

/** The canonical event both adapters produce. */
export interface CalendarEvent {
  provider: CalendarProvider;
  /** Connector type id — the scan origin and quarantine namespace. */
  typeId: string;
  /** Provider calendar id; half of the record identity. */
  calendarId: string;
  /** The calendar's human name, when the provider reported it. */
  calendarName?: string;
  eventId: string;
  title: string;
  allDay: boolean;
  /** UTC instant (`…Z`) for a timed event; `YYYY-MM-DD` for an all-day one. */
  start?: string;
  /** Same format as `start`; an all-day end date is exclusive, as both providers send it. */
  end?: string;
  /** The start date in the event's own time zone (bucket + filename). */
  localDate?: string;
  /** IANA zone when known, else the provider's own zone name. */
  timeZone?: string;
  location?: string;
  organizer?: CalendarPerson;
  /** People invited, excluding the organizer and rooms/resources. */
  attendees: CalendarAttendee[];
  /** The account owner's own answer, only for events with attendees. */
  myResponse?: CalendarResponse;
  status: 'confirmed' | 'tentative';
  /** Set only for events that are not ordinary appointments. */
  eventType?: 'out-of-office' | 'focus-time' | 'birthday';
  /** Provider permalink to the event. */
  url?: string;
  /** Meet / Teams / other video join link. */
  onlineMeetingUrl?: string;
  /** Recurring series id, for an occurrence of a series. */
  seriesId?: string;
  bodyMarkdown: string;
}

/** Records keep this identity across edits (and across the pre-1.0.1 corpus). */
export function calendarRecordId(calendarId: string, eventId: string): string {
  return `${calendarId}:${eventId}`;
}

/** Attendees beyond this are summarized; an all-hands invite is not a frontmatter line. */
const MAX_LISTED_ATTENDEES = 50;

/** Canonical event → the record the shared writer consumes. */
export function calendarEventToRecord(ev: CalendarEvent): NormalizedRecord {
  const title = oneLine(ev.title) || '(no title)';
  const candidateDay = ev.localDate ?? ev.start?.slice(0, 10) ?? '';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(candidateDay) ? candidateDay : '';
  const fm: Record<string, string> = { title };
  if (ev.start) fm.date = ev.start;
  if (ev.end) fm.end = ev.end;
  fm.all_day = ev.allDay ? 'true' : 'false';
  if (ev.timeZone) fm.timezone = ev.timeZone;
  const location = ev.location ? oneLine(ev.location) : '';
  if (location) fm.location = location;
  const organizer = formatPerson(ev.organizer);
  if (organizer) fm.organizer = organizer;
  const attendees = formatAttendees(ev.attendees);
  if (attendees) fm.attendees = attendees;
  if (ev.myResponse) fm.my_response = ev.myResponse;
  fm.status = ev.status;
  if (ev.eventType) fm.event_type = ev.eventType;
  if (ev.url) fm.url = ev.url;
  if (ev.onlineMeetingUrl) fm.online_meeting = ev.onlineMeetingUrl;
  fm.calendar = oneLine(ev.calendarName ?? '') || ev.calendarId;
  fm.provider = ev.provider;
  fm.event_id = ev.eventId;
  if (ev.seriesId) fm.series_id = ev.seriesId;
  fm.direction = 'inbound';
  return {
    recordId: calendarRecordId(ev.calendarId, ev.eventId),
    // The engine owns the calendar (scope) level; the month is ours.
    dirSegments: [day ? day.slice(0, 7) : 'undated'],
    fileStem: `${day || 'undated'}--${slug(title, 40)}`,
    frontmatter: fm,
    bodyMarkdown: ev.bodyMarkdown,
    scanOrigin: ev.typeId,
    quarantineNamespace: ev.typeId,
    quarantineLabel: `Calendar event "${title.slice(0, 80)}"`,
  };
}

/** Collapse whitespace (titles and places occasionally carry newlines). */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `Name <email>`, or whichever half exists. */
export function formatPerson(p: CalendarPerson | undefined): string {
  if (!p) return '';
  const name = oneLine(p.name ?? '');
  const email = (p.email ?? '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} <${email}>`;
  return email || name;
}

/**
 * Attendees joined with `; ` — names routinely contain commas ("Lovelace,
 * Ada"), so a comma separator would be ambiguous.
 */
function formatAttendees(list: CalendarAttendee[]): string {
  const shown = list
    .map((a) => {
      const who = formatPerson(a);
      if (!who) return '';
      const notes = [a.response, a.optional ? 'optional' : undefined].filter(Boolean);
      return notes.length ? `${who} (${notes.join(', ')})` : who;
    })
    .filter(Boolean);
  if (shown.length <= MAX_LISTED_ATTENDEES) return shown.join('; ');
  const more = shown.length - MAX_LISTED_ATTENDEES;
  return `${shown.slice(0, MAX_LISTED_ATTENDEES).join('; ')}; and ${more} more`;
}

const HTML_TAG = /<\/?[a-z][a-z0-9]*\b[^>]*>/i;

/**
 * An event body as markdown. Graph says whether its body is HTML; Google's
 * description carries HTML whenever it was written in the web UI and plain
 * text when an API wrote it, so it is sniffed.
 */
export async function bodyToMarkdown(
  content: string | undefined,
  isHtml?: boolean,
): Promise<string> {
  const text = content ?? '';
  if (!text.trim()) return '';
  const html = isHtml ?? HTML_TAG.test(text);
  const md = html ? await htmlBodyToMarkdown(text) : text;
  return md.replace(/\s+$/, '');
}

// ── Time ──────────────────────────────────────────────────────────────────

/** Parse a provider timestamp to a UTC instant; tolerates Graph's 7-digit fractions. */
export function toUtcInstant(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** True when `zone` is an IANA name this runtime's ICU knows. */
export function isKnownTimeZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The `YYYY-MM-DD` an instant falls on in `zone` (undefined when unknown). */
export function localDateIn(
  instant: string | undefined,
  zone: string | undefined,
): string | undefined {
  if (!instant || !isKnownTimeZone(zone)) return undefined;
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const out = `${get('year')}-${get('month')}-${get('day')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined;
}

/**
 * A wall-clock time (`2026-10-20T09:00:00`, no offset) in `zone` → UTC
 * instant. Two passes settle the zone's offset across a DST boundary.
 */
export function zonedWallTimeToUtc(wall: string, zone: string): string | undefined {
  const base = Date.parse(`${wall.replace(/(\.\d{3})\d+/, '$1')}Z`);
  if (!Number.isFinite(base) || !isKnownTimeZone(zone)) return undefined;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const offsetAt = (ms: number): number => {
    const parts = fmt.formatToParts(new Date(ms));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      n('year'),
      n('month') - 1,
      n('day'),
      n('hour'),
      n('minute'),
      n('second'),
    );
    return asUtc - Math.floor(ms / 1000) * 1000;
  };
  let guess = base - offsetAt(base);
  guess = base - offsetAt(guess);
  return new Date(guess).toISOString();
}

/** Epoch ms of a `start`/`end` value (all-day dates read as UTC midnight). */
export function eventTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// ── The mirrored window ───────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export const DEFAULT_PAST_DAYS = 90;
export const DEFAULT_FUTURE_DAYS = 365;
export const MAX_PAST_DAYS = 1825;
export const MAX_FUTURE_DAYS = 730;

export interface CalendarWindowConfig {
  pastDays: number;
  futureDays: number;
}

/**
 * The range of time a scope mirrors, fixed when a full listing starts. Both
 * providers need one: Google's recurring events are expanded into instances,
 * so a listing with no upper bound expands a never-ending series without
 * limit; Graph's calendarView delta requires the range and freezes it into
 * its tokens for the life of the round.
 */
export interface CalendarWindow {
  start: string;
  end: string;
  /** The config the window was built from; a changed config re-lists. */
  pastDays: number;
  futureDays: number;
}

function intIn(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

/** Binding config → window sizes (`pastDays` 0-1825, `futureDays` 1-730). */
export function readWindowConfig(
  config: Record<string, unknown> | undefined,
): CalendarWindowConfig {
  return {
    pastDays: intIn(config?.pastDays, 0, MAX_PAST_DAYS, DEFAULT_PAST_DAYS),
    futureDays: intIn(config?.futureDays, 1, MAX_FUTURE_DAYS, DEFAULT_FUTURE_DAYS),
  };
}

/** RFC 3339 / ISO 8601 at whole seconds, which both providers accept. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The window a full listing starting at `nowMs` should cover (UTC-day aligned). */
export function windowAt(nowMs: number, cfg: CalendarWindowConfig): CalendarWindow {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return {
    start: isoSeconds(today - cfg.pastDays * DAY_MS),
    end: isoSeconds(today + (cfg.futureDays + 1) * DAY_MS),
    pastDays: cfg.pastDays,
    futureDays: cfg.futureDays,
  };
}

/**
 * True when a completed listing's window should be replaced by a fresh one:
 * the config changed, or time has moved the far edge on far enough that new
 * future events would otherwise be missed. The threshold is a week, or a
 * quarter of a short look-ahead, so a re-list costs at most one full listing
 * a week.
 */
export function windowNeedsRefresh(
  window: CalendarWindow,
  nowMs: number,
  cfg: CalendarWindowConfig,
): boolean {
  if (window.pastDays !== cfg.pastDays || window.futureDays !== cfg.futureDays) return true;
  const desiredEnd = Date.parse(windowAt(nowMs, cfg).end);
  const threshold = Math.max(DAY_MS, Math.min(7 * DAY_MS, (cfg.futureDays * DAY_MS) / 4));
  return desiredEnd - Date.parse(window.end) >= threshold;
}

/**
 * Whether an event touches the window, with a day of slack on both edges so
 * an all-day event read as UTC midnight is never judged outside a window the
 * provider placed it in.
 */
export function overlapsWindow(
  start: string | undefined,
  end: string | undefined,
  window: Pick<CalendarWindow, 'start' | 'end'>,
): boolean {
  const s = eventTimeMs(start);
  const e = eventTimeMs(end) ?? s;
  if (s === undefined || e === undefined) return true;
  return e > Date.parse(window.start) - DAY_MS && s < Date.parse(window.end) + DAY_MS;
}

/** Validate a window persisted in a cursor (anything malformed → undefined). */
export function readWindow(raw: unknown): CalendarWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Partial<CalendarWindow>;
  if (typeof w.start !== 'string' || typeof w.end !== 'string') return undefined;
  if (!Number.isFinite(Date.parse(w.start)) || !Number.isFinite(Date.parse(w.end)))
    return undefined;
  if (typeof w.pastDays !== 'number' || typeof w.futureDays !== 'number') return undefined;
  return { start: w.start, end: w.end, pastDays: w.pastDays, futureDays: w.futureDays };
}
