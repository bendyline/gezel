import { randomBytes } from 'node:crypto';

/**
 * Per-site visitor sessions for the app-serve head. A visitor is minted
 * when a request presents the site key (or, on a `public` site, on first
 * page load) and lives in controller memory only — dropping the site drops
 * every visitor. The cookie value is the lookup key; `visitorId` is the
 * stable identity used for rate-limit buckets and chat-session binding.
 *
 * The cookie name is per-site (`gezel_app_<siteId8>`) because browsers
 * scope cookies by host while IGNORING the port — two sites on 127.0.0.1
 * would otherwise clobber each other's sessions.
 */

export interface VisitorRecord {
  visitorId: string;
  cookieValue: string;
  createdAtMs: number;
  lastSeenMs: number;
  chatSessionId?: string;
  chatMessages: number;
}

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_VISITORS = 64;
const SWEEP_INTERVAL_MS = 60 * 1000;

export class VisitorStore {
  private readonly byCookieValue = new Map<string, VisitorRecord>();
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly maxVisitors: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Chat sessions of expired/cleared visitors, drained by the site owner. */
  private readonly orphanedChatSessions: string[] = [];

  constructor(opts?: {
    idleTtlMs?: number;
    absoluteTtlMs?: number;
    maxVisitors?: number;
    now?: () => number;
    /** Test seam: disable the background sweep timer. */
    sweepIntervalMs?: number | null;
  }) {
    this.idleTtlMs = opts?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.absoluteTtlMs = opts?.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS;
    this.maxVisitors = opts?.maxVisitors ?? DEFAULT_MAX_VISITORS;
    this.now = opts?.now ?? Date.now;
    const interval = opts?.sweepIntervalMs === undefined ? SWEEP_INTERVAL_MS : opts.sweepIntervalMs;
    if (interval !== null) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      this.sweepTimer.unref?.();
    }
  }

  /** Null when the site is full (the caller answers 503). */
  mint(): VisitorRecord | null {
    this.sweep();
    if (this.byCookieValue.size >= this.maxVisitors) return null;
    const record: VisitorRecord = {
      visitorId: randomBytes(16).toString('base64url'),
      cookieValue: randomBytes(24).toString('base64url'),
      createdAtMs: this.now(),
      lastSeenMs: this.now(),
      chatMessages: 0,
    };
    this.byCookieValue.set(record.cookieValue, record);
    return record;
  }

  /** Look up by cookie value, refreshing the sliding-idle clock on a hit. */
  byCookie(cookieValue: string | undefined): VisitorRecord | null {
    if (!cookieValue) return null;
    const record = this.byCookieValue.get(cookieValue);
    if (!record) return null;
    const at = this.now();
    if (at - record.lastSeenMs > this.idleTtlMs || at - record.createdAtMs > this.absoluteTtlMs) {
      this.drop(record);
      return null;
    }
    record.lastSeenMs = at;
    return record;
  }

  count(): number {
    this.sweep();
    return this.byCookieValue.size;
  }

  sweep(): void {
    const at = this.now();
    for (const record of [...this.byCookieValue.values()]) {
      if (at - record.lastSeenMs > this.idleTtlMs || at - record.createdAtMs > this.absoluteTtlMs) {
        this.drop(record);
      }
    }
  }

  /** Drop every visitor (key rotation with `revokeVisitors`, site stop). */
  clear(): void {
    for (const record of [...this.byCookieValue.values()]) this.drop(record);
  }

  /** Chat sessions whose visitors are gone; each id is returned once. */
  drainOrphanedChatSessions(): string[] {
    return this.orphanedChatSessions.splice(0);
  }

  /** Every live visitor's chat session (site stop archives these too). */
  liveChatSessions(): string[] {
    return [...this.byCookieValue.values()]
      .map((record) => record.chatSessionId)
      .filter((id): id is string => Boolean(id));
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.clear();
  }

  private drop(record: VisitorRecord): void {
    this.byCookieValue.delete(record.cookieValue);
    if (record.chatSessionId) this.orphanedChatSessions.push(record.chatSessionId);
  }
}

export function visitorCookieName(siteId: string): string {
  return `gezel_app_${siteId.slice(0, 8)}`;
}

/** Minimal cookie-header parser: the one named cookie's value, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function visitorCookieHeader(args: {
  siteId: string;
  cookieValue: string;
  secure: boolean;
}): string {
  const base = `${visitorCookieName(args.siteId)}=${args.cookieValue}; Path=/; HttpOnly; SameSite=Lax`;
  return args.secure ? `${base}; Secure` : base;
}
