import { afterEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../../connectors/manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../../connectors/testing/conformance.js';
import { FakeImapServer } from '../../connectors/testing/fake-imap.js';
import { readCorpus } from '../../connectors/testing/harness.js';
import { RecordGoneError } from '../../connectors/types.js';
import { DAY, type ImapWorld, daysAgoIso, imapWorld } from '../testing.js';

describeConnectorConformance('mail-imap', {
  async create() {
    const w = await imapWorld();
    for (const i of [1, 2, 3]) {
      w.server.addMessage('INBOX', {
        subject: `Seed ${i}`,
        text: `seed ${i}`,
        date: daysAgoIso(i),
      });
    }
    w.server.addMessage('INBOX', { subject: 'Ancient', text: 'old', date: daysAgoIso(200) });
    w.server.addMessage('Archive', { subject: 'Archived', text: 'a' });
    let n = 0;
    return {
      env: w.env,
      adapter: w.adapter,
      seeded: 3,
      requiredKeys: ['message_id', 'thread_id', 'from', 'date', 'subject'],
      hooks: {
        add: (count = 1) => {
          for (let i = 0; i < count; i++) {
            w.server.addMessage('INBOX', { subject: `Fresh ${++n}`, text: `fresh ${n}` });
          }
        },
        expireCursor: () => w.server.resetUidValidity('INBOX'),
        revokeAuth: () => {
          w.server.pass = 'rotated-elsewhere';
        },
        addHostile: () =>
          void w.server.addMessage('INBOX', { subject: HOSTILE_NAME, text: INJECTION_PAYLOAD }),
      },
    };
  },
});

let world: ImapWorld | null = null;
afterEach(async () => {
  await world?.env.dispose();
  world = null;
});

async function pass(w: ImapWorld, cursor: unknown, backfillLimit = 500) {
  return syncWithAdapter(await w.adapter(), {
    storageDir: w.env.artifactsDir,
    quarantineDir: w.env.quarantineDir,
    corpusDir: 'data/mail',
    backfillLimit,
    cursor,
  });
}

describe('ImapMailProvider', () => {
  it('windows the first sync with SEARCH SINCE instead of walking the whole folder', async () => {
    world = await imapWorld({ backfillDays: 14 });
    world.server.addMessage('INBOX', { subject: 'Last year', text: 'y', date: daysAgoIso(300) });
    world.server.addMessage('INBOX', { subject: 'This week', text: 'w', date: daysAgoIso(3) });
    const r = await pass(world, undefined);
    expect(r.written).toBe(1);
    const corpus = await readCorpus(world.env.artifactsDir, 'data/mail');
    expect(corpus.map((c) => c.frontmatter.subject)).toEqual(['This week']);
    const search = world.server.commands.find((c) => c.includes('"since"'))!;
    const since = Date.parse(JSON.parse(search.slice('UID SEARCH '.length)).since);
    expect(Math.abs(since - (Date.now() - 14 * DAY))).toBeLessThan(60_000);
    // Never a `1:*` sweep of the folder's envelopes.
    expect(world.server.commands.some((c) => c.includes('"1:*"'))).toBe(false);
    expect(world.server.locksHeld).toBe(0);
  });

  it('backfills newest first in limit-sized batches and keeps new mail', async () => {
    world = await imapWorld();
    const uids = [5, 4, 3, 2, 1].map((d) =>
      world!.server.addMessage('INBOX', {
        subject: `Day ${d}`,
        text: `d${d}`,
        date: daysAgoIso(d),
      }),
    );
    const adapter = await world.adapter();
    await adapter.ensureAuth();
    const b1 = await adapter.listChangesSince('INBOX', undefined, { limit: 2 });
    expect(b1.records.map((r) => Number(r.id))).toEqual([uids[4], uids[3]]);
    expect(b1.partial).toBe(true);
    const late = world.server.addMessage('INBOX', { subject: 'Late', text: 'l' });
    const b2 = await adapter.listChangesSince('INBOX', b1.cursor, { limit: 2 });
    // New mail comes first, then the window resumes where it stopped.
    expect(b2.records.map((r) => Number(r.id))).toEqual([late, uids[2]]);
    const b3 = await adapter.listChangesSince('INBOX', b2.cursor, { limit: 2 });
    expect(b3.records.map((r) => Number(r.id))).toEqual([uids[1], uids[0]]);
    expect(b3.partial).toBeUndefined();
    expect(b3.cursor.imap?.INBOX?.backfillBelow).toBeUndefined();
    const b4 = await adapter.listChangesSince('INBOX', b3.cursor, { limit: 2 });
    expect(b4.records).toEqual([]);
    await adapter.close();

    // Through the engine: every message lands once.
    world.server.addMessage('INBOX', { subject: 'Even later', text: 'e' });
    let cursor: unknown;
    for (let i = 0; i < 4; i++) cursor = (await pass(world, cursor, 2)).cursor;
    expect(await readCorpus(world.env.artifactsDir, 'data/mail')).toHaveLength(7);
  });

  it('resyncs the window after a UIDVALIDITY change without duplicating', async () => {
    world = await imapWorld();
    world.server.addMessage('INBOX', { subject: 'A', text: 'a' });
    world.server.addMessage('INBOX', { subject: 'B', text: 'b' });
    const first = await pass(world, undefined);
    world.server.resetUidValidity('INBOX');
    const second = await pass(world, first.cursor);
    expect(second.error).toBeUndefined();
    expect(second.written).toBe(0);
    expect(await readCorpus(world.env.artifactsDir, 'data/mail')).toHaveLength(2);
  });

  it('explains a refused sign-in in terms of the app password, without leaking it', async () => {
    world = await imapWorld();
    world.server.pass = 'changed';
    const r = await pass(world, undefined);
    expect(r.error).toMatch(/app password/);
    expect(r.error).toMatch(/Invalid credentials/);
    expect(r.error).not.toContain(world.credential.pass);
  });

  it('treats an expunged message as gone, not as a failure', async () => {
    world = await imapWorld();
    const doomed = world.server.addMessage('INBOX', { subject: 'Doomed', text: 'd' });
    world.server.addMessage('INBOX', { subject: 'Kept', text: 'k' });
    const adapter = await world.adapter();
    await adapter.ensureAuth();
    const batch = await adapter.listChangesSince('INBOX', undefined);
    world.server.expunge('INBOX', doomed);
    await expect(adapter.fetchRecord('INBOX', { id: String(doomed) })).rejects.toBeInstanceOf(
      RecordGoneError,
    );
    expect(batch.records).toHaveLength(2);
    await adapter.close();
    const r = await pass(world, undefined);
    expect(r.errors).toBe(0);
    expect(world.server.locksHeld).toBe(0);
  });

  it('sends through the injected SMTP transport with threading headers', async () => {
    world = await imapWorld({ displayName: 'Robin' });
    const adapter = await world.adapter();
    await adapter.ensureAuth();
    const out = await adapter.runAction('send', {
      to: ['bob@example.com'],
      subject: 'Re: hi',
      body: 'ok',
      inReplyTo: 'root@example.com',
    });
    expect(out).toEqual({ messageId: '<smtp-1@fake.smtp>' });
    expect(world.smtp.sent[0]).toMatchObject({
      from: `Robin <${world.server.user}>`,
      to: ['bob@example.com'],
      inReplyTo: '<root@example.com>',
      references: ['<root@example.com>'],
    });
    expect(world.smtp.closed).toBe(1);
  });

  it('saves a draft with APPEND to the \\Drafts folder and never touches SMTP', async () => {
    world = await imapWorld();
    const adapter = await world.adapter();
    await adapter.ensureAuth();
    const out = (await adapter.runAction('save-draft', {
      to: ['alice@example.com'],
      subject: 'Plan',
      body: 'draft body',
    })) as { draftId: string };
    expect(out.draftId).toMatch(/^<[0-9a-f]+@gezel\.local>$/);
    const drafts = world.server.mailbox('Drafts').messages;
    expect(drafts).toHaveLength(1);
    expect([...drafts[0]!.flags]).toEqual(['\\Draft', '\\Seen']);
    expect(drafts[0]!.raw.toString('utf8')).toContain(`Message-ID: ${out.draftId}`);
    expect(world.smtp.sent).toHaveLength(0);
  });

  it('falls back to a folder named Drafts, and refuses when there is none', async () => {
    const plain = new FakeImapServer({ mailboxes: [{ path: 'INBOX' }, { path: 'INBOX.Drafts' }] });
    world = await imapWorld({}, plain);
    let adapter = await world.adapter();
    await adapter.ensureAuth();
    await adapter.runAction('save-draft', { subject: 'S', body: 'B' });
    expect(plain.mailbox('INBOX.Drafts').messages).toHaveLength(1);
    await adapter.close();
    await world.env.dispose();

    const bare = new FakeImapServer({ mailboxes: [{ path: 'INBOX' }] });
    world = await imapWorld({}, bare);
    adapter = await world.adapter();
    await adapter.ensureAuth();
    await expect(adapter.runAction('save-draft', { subject: 'S', body: 'B' })).rejects.toThrow(
      /no Drafts folder/,
    );
  });
});
