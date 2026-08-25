import { describe, expect, it } from 'vitest';
import { VisitorStore, readCookie, visitorCookieHeader, visitorCookieName } from './visitors.js';

describe('VisitorStore', () => {
  it('mints, looks up by cookie, and refreshes the idle clock', () => {
    let clock = 0;
    const store = new VisitorStore({
      now: () => clock,
      idleTtlMs: 1_000,
      absoluteTtlMs: 10_000,
      sweepIntervalMs: null,
    });
    const minted = store.mint();
    expect(minted).not.toBeNull();
    clock = 900;
    expect(store.byCookie(minted?.cookieValue)?.visitorId).toBe(minted?.visitorId);
    // The lookup at 900 refreshed lastSeen — still alive at 1800.
    clock = 1_800;
    expect(store.byCookie(minted?.cookieValue)).not.toBeNull();
    store.dispose();
  });

  it('expires on idle and absolute TTLs', () => {
    let clock = 0;
    const store = new VisitorStore({
      now: () => clock,
      idleTtlMs: 1_000,
      absoluteTtlMs: 3_000,
      sweepIntervalMs: null,
    });
    const idle = store.mint();
    clock = 1_500;
    expect(store.byCookie(idle?.cookieValue)).toBeNull();

    const persistent = store.mint();
    if (persistent) persistent.chatSessionId = 'sess-1';
    for (clock = 2_000; clock <= 4_400; clock += 900) {
      store.byCookie(persistent?.cookieValue);
    }
    // Kept touching it, but the absolute clock ran out.
    expect(store.byCookie(persistent?.cookieValue)).toBeNull();
    expect(store.drainOrphanedChatSessions()).toContain('sess-1');
    store.dispose();
  });

  it('caps the visitor count', () => {
    const store = new VisitorStore({ maxVisitors: 2, sweepIntervalMs: null });
    expect(store.mint()).not.toBeNull();
    expect(store.mint()).not.toBeNull();
    expect(store.mint()).toBeNull();
    expect(store.count()).toBe(2);
    store.dispose();
  });

  it('clear orphans every chat session exactly once', () => {
    const store = new VisitorStore({ sweepIntervalMs: null });
    const a = store.mint();
    const b = store.mint();
    if (a) a.chatSessionId = 'sess-a';
    if (b) b.chatSessionId = 'sess-b';
    store.clear();
    expect(store.drainOrphanedChatSessions().sort()).toEqual(['sess-a', 'sess-b']);
    expect(store.drainOrphanedChatSessions()).toEqual([]);
    expect(store.count()).toBe(0);
    store.dispose();
  });
});

describe('cookie helpers', () => {
  it('names cookies per site (ports are invisible to browsers)', () => {
    expect(visitorCookieName('abcdef123456')).toBe('gezel_app_abcdef12');
    expect(visitorCookieName('other-site')).not.toBe(visitorCookieName('abcdef123456'));
  });

  it('parses the named cookie out of a header', () => {
    expect(readCookie('a=1; gezel_app_ab=xyz; b=2', 'gezel_app_ab')).toBe('xyz');
    expect(readCookie('a=1', 'gezel_app_ab')).toBeUndefined();
    expect(readCookie(undefined, 'gezel_app_ab')).toBeUndefined();
  });

  it('builds an HttpOnly SameSite=Lax cookie, Secure only behind TLS proxies', () => {
    const plain = visitorCookieHeader({ siteId: 'site', cookieValue: 'v', secure: false });
    expect(plain).toBe('gezel_app_site=v; Path=/; HttpOnly; SameSite=Lax');
    expect(visitorCookieHeader({ siteId: 'site', cookieValue: 'v', secure: true })).toContain(
      '; Secure',
    );
  });
});
