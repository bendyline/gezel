import { HttpStatusError } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../../connectors/manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../../connectors/testing/conformance.js';
import { FakeTokenEndpoint, status } from '../../connectors/testing/fake-http.js';
import { readCorpus } from '../../connectors/testing/harness.js';
import { RecordGoneError } from '../../connectors/types.js';
import { type GraphWorld, daysAgoIso, graphWorld } from '../testing.js';
import { isDeltaReset, validateGraphUrl } from './graph.js';

describe('validateGraphUrl', () => {
  it('accepts only the HTTPS Graph me API origin', () => {
    expect(validateGraphUrl('/mailFolders?$top=10')).toBe(
      'https://graph.microsoft.com/v1.0/me/mailFolders?$top=10',
    );
    expect(
      validateGraphUrl('https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=x'),
    ).toContain('/v1.0/me/messages/delta');
  });

  it.each([
    'https://evil.example/steal',
    'http://graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com.evil.example/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/users/another-user/messages',
    'https://user:pass@graph.microsoft.com/v1.0/me/messages',
  ])('rejects an untrusted pagination cursor: %s', (url) => {
    expect(() => validateGraphUrl(url)).toThrow(/untrusted/);
  });
});

describeConnectorConformance('mail-microsoft365', {
  async create() {
    const w = await graphWorld();
    const seeds = [1, 2, 3].map((i) =>
      w.graph.addMessage({ subject: `Seed ${i}`, text: `seed body ${i}`, date: daysAgoIso(i) }),
    );
    w.graph.addMessage({ subject: 'Ancient', text: 'old news', date: daysAgoIso(200) });
    w.graph.addMessage({ subject: 'Filed away', text: 'x', folder: 'archive' });
    let n = 0;
    return {
      env: w.env,
      adapter: w.adapter,
      seeded: 3,
      requiredKeys: ['message_id', 'thread_id', 'from', 'date', 'subject', 'url'],
      unrouted: () => w.http.unrouted,
      hooks: {
        add: (count = 1) => {
          for (let i = 0; i < count; i++) {
            w.graph.addMessage({ subject: `Fresh ${++n}`, text: `fresh body ${n}` });
          }
        },
        update: () => w.graph.markRead(seeds[0]!),
        expireCursor: () => w.graph.expireTokens(),
        throttleNextList: () => {
          w.http.failNext(
            { url: /\/messages\/delta/ },
            status(
              429,
              { error: { code: 'TooManyRequests', message: 'throttled' } },
              {
                'retry-after': '1',
              },
            ),
          );
        },
        revokeAuth: () => {
          w.graph.rejectTokens = true;
          w.tokens.rejectRefresh = true;
        },
        addHostile: () =>
          void w.graph.addMessage({ subject: HOSTILE_NAME, text: INJECTION_PAYLOAD }),
      },
    };
  },
});

let world: GraphWorld | null = null;
afterEach(async () => {
  await world?.env.dispose();
  world = null;
});

async function pass(w: GraphWorld, cursor: unknown, backfillLimit = 500) {
  return syncWithAdapter(await w.adapter(), {
    storageDir: w.env.artifactsDir,
    quarantineDir: w.env.quarantineDir,
    corpusDir: 'data/mail',
    backfillLimit,
    cursor,
  });
}

const inbox = (cursor: unknown) =>
  (cursor as { scopes: Record<string, Record<string, unknown>> }).scopes.inbox ?? {};

describe('GraphMailProvider', () => {
  it('asks for a windowed, paged first delta', async () => {
    world = await graphWorld({ backfillDays: 30 });
    world.graph.addMessage({ subject: 'Recent', text: 'r', date: daysAgoIso(3) });
    world.graph.addMessage({ subject: 'Older', text: 'o', date: daysAgoIso(45) });
    const r = await pass(world, undefined, 50);
    expect(r.written).toBe(1);
    const first = world.http.calls.find((c) => c.url.pathname.endsWith('/messages/delta'))!;
    expect(first.url.searchParams.get('$select')).toContain('isRead');
    const filter = first.url.searchParams.get('$filter')!;
    expect(filter).toMatch(/^receivedDateTime ge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const since = Date.parse(filter.split(' ')[2]!);
    expect(Math.abs(since - (Date.now() - 30 * 86_400_000))).toBeLessThan(60_000);
    expect(first.headers.get('prefer')).toBe('odata.maxpagesize=50');
  });

  it('backfills a large folder over several batches, persisting the nextLink', async () => {
    world = await graphWorld();
    const ids = Array.from({ length: 25 }, (_, i) =>
      world!.graph.addMessage({
        subject: `Bulk ${i}`,
        text: `b${i}`,
        date: daysAgoIso(20 - i / 2),
      }),
    );
    const adapter = await world.adapter();
    let cursor: Record<string, unknown> | undefined;
    const got: string[] = [];
    let batches = 0;
    for (; batches < 10; batches++) {
      const b = await adapter.listChangesSince('inbox', cursor as never, { limit: 10 });
      expect(b.records.length).toBeLessThanOrEqual(10);
      got.push(...b.records.map((r) => r.id));
      cursor = b.cursor as Record<string, unknown>;
      if (!b.partial) break;
      expect(cursor.graphNextLink).toMatch(/\$skiptoken=/);
    }
    expect(batches).toBeGreaterThanOrEqual(2);
    expect(new Set(got)).toEqual(new Set(ids));
    expect(got).toHaveLength(25);
    expect(cursor!.graphDeltaLink).toMatch(/\$deltatoken=/);
    expect(cursor!.graphNextLink).toBeUndefined();
  });

  it('restarts the round when a stored delta or next link has expired', async () => {
    world = await graphWorld();
    world.graph.addMessage({ subject: 'One', text: 'one' });
    const first = await pass(world, undefined);
    world.graph.expireTokens();
    world.graph.addMessage({ subject: 'Two', text: 'two' });
    const second = await pass(world, first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(1);
    expect(isDeltaReset(new HttpStatusError(400, '{"error":{"code":"resyncRequired"}}'))).toBe(
      true,
    );

    // An expired nextLink mid-backfill recovers the same way.
    const adapter = await world.adapter();
    for (let i = 0; i < 5; i++) world.graph.addMessage({ subject: `More ${i}`, text: 'm' });
    const partial = await adapter.listChangesSince('inbox', undefined, { limit: 2 });
    expect(partial.partial).toBe(true);
    world.graph.expireTokens();
    const resumed = await adapter.listChangesSince('inbox', partial.cursor, { limit: 2 });
    expect(resumed.records.length).toBeGreaterThan(0);
  });

  it('carries isRead as the \\Seen flag and refreshes the record when it flips', async () => {
    world = await graphWorld();
    const id = world.graph.addMessage({ subject: 'Status', text: 's' });
    world.graph.addMessage({ subject: 'Already read', text: 'r', isRead: true });
    const first = await pass(world, undefined);
    let corpus = await readCorpus(world.env.artifactsDir, 'data/mail');
    const bySubject = (s: string) => corpus.find((c) => c.frontmatter.subject === s)!;
    expect(bySubject('Already read').frontmatter.labels).toBe('\\Seen');
    expect(bySubject('Status').frontmatter.labels).toBeUndefined();
    expect(bySubject('Status').frontmatter.url).toMatch(
      /^https:\/\/outlook\.office365\.com\/owa\//,
    );
    world.graph.markRead(id);
    const second = await pass(world, first.cursor);
    expect(second.written).toBe(1);
    corpus = await readCorpus(world.env.artifactsDir, 'data/mail');
    expect(corpus).toHaveLength(2);
    expect(bySubject('Status').frontmatter.labels).toBe('\\Seen');
  });

  it('ignores @removed entries — moved or deleted mail stays in the window corpus', async () => {
    world = await graphWorld();
    const a = world.graph.addMessage({ subject: 'Keep me', text: 'k' });
    const b = world.graph.addMessage({ subject: 'Archive me', text: 'a' });
    const first = await pass(world, undefined);
    world.graph.deleteMessage(a);
    world.graph.moveMessage(b, 'archive');
    const second = await pass(world, first.cursor);
    expect(second.errors).toBe(0);
    expect(second.pruned).toBe(0);
    expect(await readCorpus(world.env.artifactsDir, 'data/mail')).toHaveLength(2);
  });

  it('fetch: 404 is RecordGoneError, a 503 is retried, and missing isRead is looked up', async () => {
    world = await graphWorld();
    const id = world.graph.addMessage({ subject: 'Flaky', text: 'f', isRead: true });
    const adapter = await world.adapter();
    await expect(adapter.fetchRecord('inbox', { id: 'AAMk-missing=' })).rejects.toBeInstanceOf(
      RecordGoneError,
    );
    const noHint = await adapter.fetchRecord('inbox', { id });
    expect(noHint.frontmatter.labels).toBe('\\Seen');
    world.http.failNext({ url: /\/\$value$/ }, status(503));
    const r = await pass(world, undefined);
    expect(r.errors).toBe(0);
    expect(r.written).toBe(1);
  });

  it('sends a reply as MIME so it threads, and a plain send as JSON', async () => {
    world = await graphWorld();
    const adapter = await world.adapter();
    await adapter.runAction('send', { to: ['bob@example.com'], subject: 'Hi', body: 'plain' });
    await adapter.runAction('send', {
      to: ['bob@example.com'],
      subject: 'Re: Hi',
      body: 'threaded',
      inReplyTo: 'root@example.com',
    });
    expect(world.graph.sent.map((s) => s.kind)).toEqual(['json', 'mime']);
    const raw = world.graph.sent[1]!.raw!.toString('utf8');
    expect(raw).toMatch(/^In-Reply-To: <root@example\.com>\r$/m);
  });

  it('saves a draft into Drafts and returns its id and web link', async () => {
    world = await graphWorld({ displayName: 'Robin' });
    const adapter = await world.adapter();
    const result = (await adapter.runAction('save-draft', {
      to: ['alice@example.com'],
      cc: ['Carol <carol@example.com>'],
      subject: 'Proposal',
      body: 'Draft text',
    })) as { draftId: string; webLink?: string };
    expect(result.draftId).toBeTruthy();
    expect(result.webLink).toMatch(/^https:\/\/outlook\.office365\.com\//);
    expect(world.graph.sent).toHaveLength(0);
    const draft = world.graph.messages.get(result.draftId)!;
    expect(draft.isDraft).toBe(true);
    expect(draft.folderId).toBe(world.graph.folderId('drafts'));
    const raw = world.graph.createdDrafts[0]!.raw!.toString('utf8');
    expect(raw).toMatch(/^Cc: carol@example\.com\r$/m);
  });

  it('a grant without Mail.ReadWrite gets an actionable re-link message for drafts', async () => {
    world = await graphWorld();
    world.graph.allowReadWrite = false;
    const adapter = await world.adapter();
    await expect(adapter.runAction('save-draft', { subject: 'x', body: 'y' })).rejects.toThrow(
      /Mail\.ReadWrite.*Re-link the account/,
    );
  });

  it('refreshes against the token URL the grant came from and keeps the rotated token', async () => {
    world = await graphWorld({}, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    world.graph.addMessage({ subject: 'Hi', text: 'hi' });
    const seed = await world.env.readCredential<{ refreshToken: string }>(world.binding);
    const r = await pass(world, undefined);
    expect(r.error).toBeUndefined();
    const grant = world.http.requests('POST', 'https://login.microsoftonline.com/');
    expect(grant).toHaveLength(1);
    expect(grant[0]!.url.pathname).toBe('/organizations/oauth2/v2.0/token');
    const stored = await world.env.readCredential<{ refreshToken: string }>(world.binding);
    expect(stored?.refreshToken).toMatch(/^refresh-/);
    expect(stored?.refreshToken).not.toBe(seed?.refreshToken);
  });

  it('without a stored token URL, refreshes against the credential tenant', async () => {
    world = await graphWorld({}, {}, 'mail-outlook');
    const consumers = new FakeTokenEndpoint(
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    ).install(world.http);
    await world.env.storeCredential(world.binding, {
      accessToken: 'old',
      refreshToken: consumers.issueRefreshToken(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      clientId: 'ms-client',
      tenant: 'consumers',
    });
    const r = await pass(world, undefined);
    expect(r.error).toBeUndefined();
    expect(consumers.grants).toHaveLength(1);
    expect(world.tokens.grants).toHaveLength(0);
  });

  it('derives the provider from the binding type (outlook.com)', async () => {
    world = await graphWorld({}, {}, 'mail-outlook');
    const adapter = await world.adapter();
    expect(adapter.typeId).toBe('mail-outlook');
  });
});
