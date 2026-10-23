import { HttpStatusError } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRawMessage } from '../../mail/mime.js';
import {
  POISON_RECORD_PASSES,
  partialFailureNote,
  scopeDirName,
  syncWithAdapter,
} from '../manager.js';
import type { ChangeBatch, ConnectorAdapter, NormalizedRecord, RecordRef } from '../types.js';
import { FakeHttp, FakeTokenEndpoint, json, status } from './fake-http.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from './harness.js';
import { buildMime } from './mime.js';

describe('FakeHttp', () => {
  it('routes by method + path params, decodes each segment, and records calls', async () => {
    const http = new FakeHttp().on('GET', 'https://api.test/cal/:id/events', (req, p) =>
      json({ id: p.id, q: req.url.searchParams.get('q'), bearer: req.bearer }),
    );
    const res = await http.fetch('https://api.test/cal/team%40group.test/events?q=x', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(await res.json()).toEqual({ id: 'team@group.test', q: 'x', bearer: 'tok' });
    expect(http.calls).toHaveLength(1);
  });

  it('serves queued faults before the route, then falls through', async () => {
    const http = new FakeHttp()
      .on('GET', 'https://api.test/list', () => json({ ok: true }))
      .failNext({ url: 'https://api.test/list' }, status(429, undefined, { 'retry-after': '5' }));
    expect((await http.fetch('https://api.test/list')).status).toBe(429);
    expect((await http.fetch('https://api.test/list')).status).toBe(200);
  });

  it('a canned fault serves independent copies that can be cancelled unread', async () => {
    const http = new FakeHttp().failNext(
      { url: 'https://api.test/me' },
      status(401, { error: 'expired' }),
      2,
    );
    const first = await http.fetch('https://api.test/me');
    await first.body?.cancel();
    const second = await http.fetch('https://api.test/me');
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: 'expired' });
  });

  it('throws on an unrouted request and remembers it', async () => {
    const http = new FakeHttp();
    await expect(http.fetch('https://api.test/nope')).rejects.toThrow(/no route/);
    expect(http.unrouted).toEqual(['GET https://api.test/nope']);
  });

  it('a later route overrides an earlier one', async () => {
    const http = new FakeHttp()
      .on('GET', 'https://api.test/x', () => json(1))
      .on('GET', 'https://api.test/x', () => json(2));
    expect(await (await http.fetch('https://api.test/x')).json()).toBe(2);
  });

  it('token endpoint fake exchanges codes and rotates refresh tokens', async () => {
    const http = new FakeHttp();
    const tokens = new FakeTokenEndpoint('https://auth.test/token', {
      rotateRefreshToken: true,
    }).install(http);
    const post = (body: Record<string, string>) =>
      http.fetch('https://auth.test/token', { method: 'POST', body: new URLSearchParams(body) });
    const first = (await (
      await post({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' })
    ).json()) as { refresh_token: string };
    const second = (await (
      await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token })
    ).json()) as { refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // The rotated-away token is now rejected, as X and Microsoft do.
    expect(
      (await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).status,
    ).toBe(400);
    expect(tokens.grants).toHaveLength(3);
  });
});

describe('buildMime', () => {
  it('produces messages the production parser reads back faithfully', async () => {
    const raw = buildMime({
      messageId: 'm1@fixture.test',
      from: 'Zoë Ferrer <zoe@example.com>',
      subject: 'Café plans',
      text: 'See you at 10.\n\n> On Monday you wrote:\n> old text',
      html: '<p>See you at 10.</p>',
      attachments: [{ filename: 'agenda.txt', contentType: 'text/plain', content: 'item 1' }],
    });
    const msg = await parseRawMessage(raw, { folder: 'INBOX', id: '1', flags: [] });
    expect(msg.messageId).toBe('<m1@fixture.test>');
    expect(msg.subject).toBe('Café plans');
    expect(msg.from).toContain('Zoë');
    expect(msg.bodyMarkdown).toContain('See you at 10.');
    expect(msg.bodyMarkdown).not.toContain('old text');
    expect(msg.attachments.map((a) => a.filename)).toEqual(['agenda.txt']);
  });

  it('handles HTML-only, latin1, and a missing Message-ID', async () => {
    const html = await parseRawMessage(buildMime({ html: '<p>Only <b>html</b></p>' }), {
      folder: 'INBOX',
      id: '2',
      flags: [],
    });
    expect(html.bodyMarkdown).toMatch(/Only (\*\*)?html/);
    const latin = await parseRawMessage(
      buildMime({ text: 'Smörgåsbord', charset: 'iso-8859-1', messageId: null }),
      { folder: 'INBOX', id: '3', flags: [] },
    );
    expect(latin.bodyMarkdown).toContain('Smörgåsbord');
    expect(latin.messageId).toMatch(/@gezel\.local>$/);
  });
});

// ── Engine: tombstones, moved records, poison records ──────────────────────

function rec(id: string, dir: string, body = `body of ${id}`): NormalizedRecord {
  return {
    recordId: id,
    dirSegments: [dir],
    fileStem: id,
    frontmatter: { title: id, direction: 'inbound' },
    bodyMarkdown: body,
    scanOrigin: 'test',
    quarantineNamespace: 'test',
    quarantineLabel: id,
  };
}

class ScriptedAdapter implements ConnectorAdapter {
  readonly typeId = 'scripted';
  recordsMayMove = false;
  constructor(
    private readonly batch: (cursor: unknown) => ChangeBatch<unknown>,
    private readonly fetchOne: (ref: RecordRef) => NormalizedRecord,
  ) {}
  async ensureAuth() {}
  async listScopes() {
    return [''];
  }
  async listChangesSince(_s: string, cursor: unknown) {
    return this.batch(cursor);
  }
  async fetchRecord(_s: string, ref: RecordRef) {
    return this.fetchOne(ref);
  }
  async close() {}
}

let env: ConnectorTestEnv | null = null;
afterEach(async () => {
  await env?.dispose();
  env = null;
});

async function pass(adapter: ConnectorAdapter, cursor: unknown) {
  return syncWithAdapter(adapter, {
    storageDir: env!.artifactsDir,
    quarantineDir: env!.quarantineDir,
    corpusDir: 'data/t',
    backfillLimit: 50,
    cursor,
  });
}

describe('syncWithAdapter — tombstones and moves', () => {
  it('removes records the source reports deleted, keeping one re-fetched in the same batch', async () => {
    env = await createConnectorTestEnv();
    const dirs: Record<string, string> = { a: 'x', b: 'x', c: 'y' };
    let step = 0;
    const adapter = new ScriptedAdapter(
      () =>
        step === 0
          ? { records: ['a', 'b', 'c'].map((id) => ({ id })), cursor: 1 }
          : { records: [{ id: 'c' }], cursor: 2, removed: ['a', 'c', 'zzz-unknown'] },
      (ref) => rec(ref.id, dirs[ref.id]!),
    );
    const first = await pass(adapter, undefined);
    expect(first.written).toBe(3);
    step = 1;
    const second = await pass(adapter, first.cursor);
    expect(second.pruned).toBe(1);
    const left = (await readCorpus(env.artifactsDir, 'data/t')).map((r) => r.frontmatter.title);
    expect(left.sort()).toEqual(['b', 'c']);
    await assertCorpusInvariants(env.artifactsDir, 'data/t');
  });

  it('drops the stale copy when a record moves directories (opt-in)', async () => {
    env = await createConnectorTestEnv();
    const dirs: Record<string, string> = { a: '2026-10', b: '2026-10' };
    const adapter = new ScriptedAdapter(
      () => ({ records: [{ id: 'a' }, { id: 'b' }], cursor: 1 }),
      (ref) => rec(ref.id, dirs[ref.id]!),
    );
    adapter.recordsMayMove = true;
    await pass(adapter, undefined);
    dirs.a = '2026-11';
    const moved = await pass(adapter, undefined);
    expect(moved.written).toBe(1);
    const paths = (await readCorpus(env.artifactsDir, 'data/t')).map((r) => r.path);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.startsWith('2026-11/'))).toBe(true);
    expect(paths.filter((p) => p.startsWith('2026-10/'))).toHaveLength(1);
    await assertCorpusInvariants(env.artifactsDir, 'data/t');
  });

  it('without the opt-in a moved record keeps both copies (documented behavior)', async () => {
    env = await createConnectorTestEnv();
    const dirs: Record<string, string> = { a: 'one' };
    const adapter = new ScriptedAdapter(
      () => ({ records: [{ id: 'a' }], cursor: 1 }),
      (ref) => rec(ref.id, dirs[ref.id]!),
    );
    await pass(adapter, undefined);
    dirs.a = 'two';
    await pass(adapter, undefined);
    expect(await readCorpus(env.artifactsDir, 'data/t')).toHaveLength(2);
  });
});

describe('syncWithAdapter — throttles outside the list call', () => {
  it('a 429 from listScopes is backpressure, not a pass error', async () => {
    env = await createConnectorTestEnv();
    const adapter = new ScriptedAdapter(
      () => ({ records: [], cursor: 1 }),
      (ref) => rec(ref.id, 'd'),
    );
    adapter.listScopes = async () => {
      throw new HttpStatusError(429, 'calendar list 429: rateLimitExceeded');
    };
    const r = await pass(adapter, { v: 2, scopes: { '': 'keep' } });
    expect(r.rateLimited).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.cursor).toEqual({ v: 2, scopes: { '': 'keep' } });
  });
});

describe('syncWithAdapter — one failing scope', () => {
  it('lets the other scopes sync and names the failed one', async () => {
    env = await createConnectorTestEnv();
    const adapter = new ScriptedAdapter(
      () => ({ records: [{ id: 'a' }], cursor: 'c1' }),
      (ref) => rec(ref.id, 'd'),
    );
    adapter.listScopes = async () => ['https://good.test/feed', 'https://broken.test/feed'];
    adapter.listChangesSince = async (scope: string) => {
      if (scope.includes('broken')) throw new Error('the feed is not valid XML');
      return { records: [{ id: 'good-item-1' }], cursor: 'c1' };
    };
    const r = await pass(adapter, undefined);
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(1);
    expect(r.failedScopes).toEqual([
      { scope: 'https://broken.test/feed', message: 'the feed is not valid XML' },
    ]);
    expect((r.cursor as { scopes: Record<string, unknown> }).scopes).toEqual({
      'https://good.test/feed': 'c1',
    });
    expect(partialFailureNote(r)).toMatch(
      /https:\/\/broken\.test\/feed could not be synced: the feed is not valid XML/,
    );
  });

  it('a pass where every scope fails is a failed pass', async () => {
    env = await createConnectorTestEnv();
    const adapter = new ScriptedAdapter(
      () => {
        throw new Error('Re-link the account');
      },
      (ref) => rec(ref.id, 'd'),
    );
    adapter.listScopes = async () => ['a', 'b'];
    const r = await pass(adapter, undefined);
    expect(r.error).toBe('Re-link the account');
  });
});

describe('scopeDirName', () => {
  it('keeps short scopes as their slug and disambiguates long ones', () => {
    expect(scopeDirName('INBOX')).toBe('inbox');
    expect(scopeDirName('team@group.calendar.google.com')).toBe('team-group-calendar-google-com');
    const a = scopeDirName(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCaaaaaaaaaaaaaaaaaaaaaa',
    );
    const b = scopeDirName(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(a).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('syncWithAdapter — poison records', () => {
  it('stops holding the cursor for a record that fails while its neighbors land', async () => {
    env = await createConnectorTestEnv();
    const adapter = new ScriptedAdapter(
      (cursor) => ({
        records: cursor === 'next' ? [] : [{ id: 'good' }, { id: 'bad' }],
        cursor: 'next',
      }),
      (ref) => {
        if (ref.id === 'bad') throw new Error('mailparser choked');
        return rec(ref.id, 'd');
      },
    );
    let cursor: unknown;
    for (let i = 1; i < POISON_RECORD_PASSES; i++) {
      const r = await pass(adapter, cursor);
      cursor = r.cursor;
      expect((cursor as { scopes: Record<string, unknown> }).scopes['']).toBeUndefined();
      expect((cursor as { failures?: unknown }).failures).toEqual({ '': { bad: i } });
      expect(partialFailureNote(r)).toMatch(/1 record\(s\) could not be synced/);
    }
    const last = await pass(adapter, cursor);
    expect(last.abandoned).toEqual([{ scope: '', id: 'bad' }]);
    expect((last.cursor as { scopes: Record<string, unknown> }).scopes['']).toBe('next');
    expect((last.cursor as { failures?: unknown }).failures).toBeUndefined();
    expect(partialFailureNote(last)).toMatch(/failed 3 passes in a row and were skipped/);
  });

  it('never gives up on records when the whole batch fails (an outage, not a bad record)', async () => {
    env = await createConnectorTestEnv();
    const adapter = new ScriptedAdapter(
      () => ({ records: [{ id: 'a' }, { id: 'b' }], cursor: 'next' }),
      () => {
        throw new Error('HTTP 401');
      },
    );
    let cursor: unknown;
    for (let i = 0; i < POISON_RECORD_PASSES + 2; i++) {
      const r = await pass(adapter, cursor);
      cursor = r.cursor;
      expect(r.abandoned).toBeUndefined();
    }
    expect((cursor as { scopes: Record<string, unknown> }).scopes['']).toBeUndefined();
    expect((cursor as { failures?: unknown }).failures).toBeUndefined();
  });
});
