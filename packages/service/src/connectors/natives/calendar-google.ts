/**
 * Google Calendar as a second `native` connector adapter — proving `native`
 * generalizes beyond mail and delivering the headline cross-corpus story (email
 * + calendar in one project). Reuses the connector OAuth core: the binding's
 * credential is a Google OAuth blob; the adapter refreshes the access token on
 * expiry and re-persists it. Incremental sync uses Google's `syncToken`; each
 * event normalizes to a `NormalizedRecord` directly (native normalize).
 */

import { type OAuthEndpoints, isExpired, refreshToken } from '../oauth.js';
import { connectorSecretKey, registerNativeAdapter } from '../registry.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import { slug } from '../writer.js';

const API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scopes: [],
};

interface GoogleOAuthCred {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  clientId: string;
  clientSecret?: string;
}

interface GEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  updated?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string }[];
  organizer?: { email?: string; displayName?: string };
}

class GoogleCalendarAdapter implements ConnectorAdapter {
  readonly typeId = 'calendar-google';
  private token = '';

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
  ) {}

  async ensureAuth(): Promise<void> {
    const key = connectorSecretKey(this.binding.type, this.binding.id);
    const blob = await this.deps.secrets.get(key);
    if (!blob) throw new Error(`no stored credential for calendar connector ${this.binding.id}`);
    let cred = JSON.parse(blob) as GoogleOAuthCred;
    if (isExpired(cred)) {
      const t = await refreshToken({
        endpoints: GOOGLE_ENDPOINTS,
        clientId: cred.clientId,
        ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}),
        refreshToken: cred.refreshToken,
      });
      cred = {
        ...cred,
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
        ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      };
      await this.deps.secrets.set(key, JSON.stringify(cred));
    }
    this.token = cred.accessToken;
  }

  async listScopes(): Promise<string[]> {
    const configured = (this.binding.config as { calendars?: string[] })?.calendars;
    if (configured?.length) return configured;
    const r = (await this.api('/users/me/calendarList')) as { items?: { id?: string }[] };
    const ids = (r.items ?? []).map((c) => c.id).filter((id): id is string => !!id);
    return ids.length ? ids : ['primary'];
  }

  async listChangesSince(calendarId: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    if (typeof cursor === 'string' && cursor) params.set('syncToken', cursor);
    else params.set('timeMin', new Date(Date.now() - 90 * 86_400_000).toISOString());
    const r = (await this.api(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    )) as { items?: GEvent[]; nextSyncToken?: string };
    const records: RecordRef[] = (r.items ?? [])
      .filter((e) => e.id)
      .map((e) => ({
        id: e.id as string,
        raw: { event: e, calendarId },
        ...(e.updated ? { ts: e.updated } : {}),
      }));
    return { records, cursor: r.nextSyncToken };
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    const { event, calendarId } = ref.raw as { event: GEvent; calendarId: string };
    return eventToRecord(event, calendarId);
  }

  async close(): Promise<void> {}

  private async api(path: string): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`calendar api ${res.status}: ${await res.text().catch(() => '')}`);
    return res.json();
  }
}

function eventToRecord(event: GEvent, calendarId: string): NormalizedRecord {
  const start = event.start?.dateTime ?? event.start?.date ?? '';
  const title = event.summary ?? '(no title)';
  const attendees = (event.attendees ?? [])
    .map((a) => a.displayName ?? a.email)
    .filter(Boolean)
    .join(', ');
  const frontmatter: Record<string, string> = {
    direction: 'inbound',
    title,
    ...(start ? { date: start } : {}),
    ...(event.end?.dateTime || event.end?.date
      ? { end: event.end.dateTime ?? event.end.date ?? '' }
      : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.organizer?.email ? { organizer: event.organizer.email } : {}),
    ...(attendees ? { attendees } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.htmlLink ? { url: event.htmlLink } : {}),
    calendar: calendarId,
  };
  const day = start.slice(0, 10) || 'undated';
  return {
    recordId: `${calendarId}:${event.id ?? title}`,
    dirSegments: [slug(calendarId, 40), day.slice(0, 7) || 'undated'],
    fileStem: `${day}--${slug(title, 40)}`,
    frontmatter,
    bodyMarkdown: event.description ?? '',
    scanOrigin: 'calendar',
    quarantineNamespace: 'calendar',
    quarantineLabel: `Event "${title}"`,
  };
}

/** Register the Google Calendar native adapter. */
export function registerCalendarAdapters(): void {
  registerNativeAdapter('calendar-google', async (binding, deps) =>
    Promise.resolve(new GoogleCalendarAdapter(binding, deps)),
  );
}
