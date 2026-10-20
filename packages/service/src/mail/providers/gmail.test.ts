import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../../connectors/manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../../connectors/testing/conformance.js';
import { status } from '../../connectors/testing/fake-http.js';
import { readCorpus } from '../../connectors/testing/harness.js';
import { RecordGoneError } from '../../connectors/types.js';
import { type GmailWorld, daysAgoIso, gmailWorld } from '../testing.js';
import type { MailCursor } from '../types.js';

const REQUIRED = ['message_id', 'thread_id', 'from', 'date', 'subject'];

describeConnectorConformance('mail-gmail', {
  async create() {
    const w = await gmailWorld();
    const seeds = [1, 2, 3].map((i) =>
      w.gmail.addMessage({ subject: `Seed ${i}`, text: `seed body ${i}`, date: daysAgoIso(i) }),
    );
    // Outside the 90-day window, and outside the synced label: never written.
    w.gmail.addMessage({ subject: 'Ancient', text: 'old news', date: daysAgoIso(200) });
    w.gmail.addMessage({ subject: 'Receipt', text: 'thanks', labelIds: ['Label_1'] });
    let n = 0;
    return {
      env: w.env,
      adapter: w.adapter,
      seeded: 3,
      requiredKeys: REQUIRED,
      unrouted: () => w.http.unrouted,
      hooks: {
        add: (count = 1) => {
          for (let i = 0; i < count; i++) {
            w.gmail.addMessage({ subject: `Fresh ${++n}`, text: `fresh body ${n}` });
          }
        },
        update: () => w.gmail.markRead(seeds[0]!),
        expireCursor: () => w.gmail.expireHistory(),
        throttleNextList: () => {
          w.http.failNext(
            { url: /\/users\/me\/(history|messages)\?/ },
            status(
              429,
              { error: { code: 429, message: 'Too many requests' } },
              { 'retry-after': '1' },
            ),
          );
        },
        revokeAuth: () => {
          w.gmail.rejectTokens = true;
          w.tokens.rejectRefresh = true;
        },
        addHostile: () =>
          void w.gmail.addMessage({ subject: HOSTILE_NAME, text: INJECTION_PAYLOAD }),
      },
    };
  },
});

let world: GmailWorld | null = null;
afterEach(async () => {
  await world?.env.dispose();
  world = null;
});

async function pass(w: GmailWorld, cursor: unknown, backfillLimit = 500) {
  return syncWithAdapter(await w.adapter(), {
    storageDir: w.env.artifactsDir,
    quarantineDir: w.env.quarantineDir,
    corpusDir: 'data/mail',
    backfillLimit,
    cursor,
  });
}

const scope = (cursor: unknown): MailCursor =>
  (cursor as { scopes: Record<string, MailCursor> }).scopes.INBOX ?? {};

describe('GmailMailProvider', () => {
  it('recovers from an expired history id with a full resync instead of failing every pass', async () => {
    world = await gmailWorld();
    world.gmail.addMessage({ subject: 'One', text: 'one' });
    const first = await pass(world, undefined);
    expect(first.written).toBe(1);
    world.gmail.expireHistory();
    world.gmail.addMessage({ subject: 'Two', text: 'two' });
    const second = await pass(world, first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(1);
    expect(scope(second.cursor).gmailHistoryId).toBeTruthy();
    const third = await pass(world, second.cursor);
    expect(third.error).toBeUndefined();
    expect(third.written).toBe(0);
  });

  it('pages the backfill within the batch limit and anchors history before listing', async () => {
    world = await gmailWorld();
    const backlog = Array.from({ length: 5 }, (_, i) =>
      world!.gmail.addMessage({ subject: `Backlog ${i}`, text: `b${i}`, date: daysAgoIso(5 - i) }),
    );
    const adapter = await world.adapter();
    const batch1 = await adapter.listChangesSince('INBOX', undefined, { limit: 2 });
    expect(batch1.records).toHaveLength(2);
    expect(batch1.partial).toBe(true);
    expect(batch1.cursor.gmailBackfill?.pageToken).toBeTruthy();
    const anchor = batch1.cursor.gmailBackfill!.anchor;
    // Mail that lands while the backfill pages must not fall between the two.
    const late = world.gmail.addMessage({ subject: 'Arrived mid-backfill', text: 'late' });
    const seen = new Set(batch1.records.map((r) => r.id));
    let cursor = batch1.cursor;
    for (let i = 0; i < 5 && cursor.gmailBackfill; i++) {
      const b = await adapter.listChangesSince('INBOX', cursor, { limit: 2 });
      expect(b.records.length).toBeLessThanOrEqual(2);
      for (const r of b.records) seen.add(r.id);
      cursor = b.cursor;
    }
    expect(cursor.gmailHistoryId).toBe(anchor);
    const history = await adapter.listChangesSince('INBOX', cursor, { limit: 2 });
    expect(history.records.map((r) => r.id)).toContain(late);
    for (const id of backlog) expect(seen.has(id)).toBe(true);
    // The list carried the window and never asked for more than the batch.
    const lists = world.http.calls.filter((c) => c.url.pathname.endsWith('/messages'));
    for (const c of lists) {
      expect(c.url.searchParams.get('q')).toMatch(/^after:\d+$/);
      expect(Number(c.url.searchParams.get('maxResults'))).toBeLessThanOrEqual(2);
    }
  });

  it('bounds the first sync by backfillDays', async () => {
    world = await gmailWorld({ backfillDays: 7 });
    world.gmail.addMessage({ subject: 'Recent', text: 'r', date: daysAgoIso(2) });
    world.gmail.addMessage({ subject: 'Last month', text: 'm', date: daysAgoIso(30) });
    const r = await pass(world, undefined);
    expect(r.written).toBe(1);
    const corpus = await readCorpus(world.env.artifactsDir, 'data/mail');
    expect(corpus.map((c) => c.frontmatter.subject)).toEqual(['Recent']);
    const after = Number(
      world.http.calls
        .find((c) => c.url.pathname.endsWith('/messages'))!
        .url.searchParams.get('q')!
        .slice('after:'.length),
    );
    expect(Math.abs(after * 1000 - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
  });

  it('picks up a message moved into the synced label and dedupes ids within a batch', async () => {
    world = await gmailWorld();
    const first = await pass(world, undefined);
    const filed = world.gmail.addMessage({ subject: 'Filed', text: 'f', labelIds: ['Label_1'] });
    world.gmail.addLabels(filed, ['INBOX']);
    const fresh = world.gmail.addMessage({ subject: 'Fresh', text: 'x' });
    world.gmail.markRead(fresh);
    const adapter = await world.adapter();
    const batch = await adapter.listChangesSince('INBOX', scope(first.cursor));
    expect(batch.records.map((r) => r.id).sort()).toEqual([filed, fresh].sort());
    const second = await pass(world, first.cursor);
    expect(second.written).toBe(2);
  });

  it('pages history mid-page without losing or repeating messages', async () => {
    world = await gmailWorld();
    world.gmail.maxHistoryPage = 3;
    const first = await pass(world, undefined);
    const ids = Array.from({ length: 7 }, (_, i) =>
      world!.gmail.addMessage({ subject: `H${i}`, text: `h${i}` }),
    );
    const adapter = await world.adapter();
    let cursor = scope(first.cursor);
    const got: string[] = [];
    for (let i = 0; i < 10; i++) {
      const b = await adapter.listChangesSince('INBOX', cursor, { limit: 2 });
      expect(b.records.length).toBeLessThanOrEqual(2);
      got.push(...b.records.map((r) => r.id));
      cursor = b.cursor;
      if (!b.partial) break;
    }
    expect(got).toEqual(ids);
    expect(cursor.gmailHistoryPage).toBeUndefined();
  });

  it('turns a 404 on fetch into RecordGoneError and moves the cursor past it', async () => {
    world = await gmailWorld();
    const first = await pass(world, undefined);
    const doomed = world.gmail.addMessage({ subject: 'Doomed', text: 'd' });
    world.gmail.addMessage({ subject: 'Kept', text: 'k' });
    const adapter = await world.adapter();
    world.gmail.deleteMessage(doomed);
    await expect(adapter.fetchRecord('INBOX', { id: doomed })).rejects.toBeInstanceOf(
      RecordGoneError,
    );
    const second = await pass(world, first.cursor);
    expect(second.errors).toBe(0);
    expect(second.written).toBe(1);
    expect(scope(second.cursor)).not.toEqual(scope(first.cursor));
  });

  it('treats a 403 userRateLimitExceeded on the list as backpressure', async () => {
    world = await gmailWorld();
    world.http.failNext(
      { url: /\/users\/me\/messages\?/ },
      status(403, {
        error: {
          code: 403,
          message: 'User-rate limit exceeded',
          errors: [{ reason: 'userRateLimitExceeded', domain: 'usageLimits' }],
        },
      }),
    );
    const r = await pass(world, undefined);
    expect(r.rateLimited).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('refreshes an expired token through the injected transport and persists it', async () => {
    world = await gmailWorld({}, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    world.gmail.addMessage({ subject: 'Hi', text: 'hi' });
    const r = await pass(world, undefined);
    expect(r.error).toBeUndefined();
    expect(world.tokens.grants.map((g) => g.get('grant_type'))).toEqual(['refresh_token']);
    const stored = await world.env.readCredential<{ accessToken: string }>(world.binding);
    expect(stored?.accessToken).toMatch(/^access-/);
  });

  it('a refused refresh asks the person to re-link', async () => {
    world = await gmailWorld({}, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    world.tokens.rejectRefresh = true;
    const r = await pass(world, undefined);
    expect(r.error).toMatch(/Re-link the account/);
    expect(r.error).not.toMatch(/seed-access|refresh-/);
  });

  it('saves a threaded draft into the account without sending it', async () => {
    world = await gmailWorld({ displayName: 'Robin' });
    const parent = world.gmail.addMessage({
      messageId: 'parent@example.com',
      subject: 'Quote request',
      text: 'Can you send a quote?',
    });
    const adapter = await world.adapter();
    const result = await adapter.runAction('save-draft', {
      to: ['Alice <alice@example.com>'],
      subject: 'Re: Quote request',
      body: 'Here is the quote.',
      inReplyTo: 'parent@example.com',
    });
    expect(result).toEqual({ draftId: expect.stringMatching(/^r-/) });
    expect(world.gmail.sent).toHaveLength(0);
    expect(world.gmail.drafts).toHaveLength(1);
    const draft = world.gmail.drafts[0]!;
    expect(draft.threadId).toBe(world.gmail.messages.get(parent)!.threadId);
    const raw = draft.raw.toString('utf8');
    expect(raw).toMatch(/^From: Robin <me@example\.com>\r$/m);
    expect(raw).toMatch(/^To: alice@example\.com\r$/m);
    expect(raw).toMatch(/^In-Reply-To: <parent@example\.com>\r$/m);
    expect(raw).toMatch(/^References: <parent@example\.com>\r$/m);
  });

  it('sends with the resolved thread id', async () => {
    world = await gmailWorld();
    const parent = world.gmail.addMessage({ messageId: 'p2@example.com', subject: 'Hello' });
    const adapter = await world.adapter();
    await adapter.runAction('send', {
      to: ['bob@example.com'],
      subject: 'Re: Hello',
      body: 'hi',
      inReplyTo: '<p2@example.com>',
    });
    expect(world.gmail.sent).toHaveLength(1);
    expect(world.gmail.sent[0]!.threadId).toBe(world.gmail.messages.get(parent)!.threadId);
  });
});
