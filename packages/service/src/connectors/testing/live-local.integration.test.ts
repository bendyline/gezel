/**
 * Mail against real servers that need no account: the IMAP and SMTP servers
 * the CI lane starts in containers (GreenMail, Dovecot), so the IMAP provider
 * meets real protocol behavior the in-memory fake only models. Skipped unless
 * `GEZEL_CONNECTOR_LIVE_LOCAL=1`.
 *
 * `GEZEL_LIVE_MAIL` is a JSON list of servers:
 *
 *   [{ "name": "greenmail", "address": "alice@example.test", "user": "alice",
 *      "pass": "…", "imap": { "host": "127.0.0.1", "port": 3993, "secure": true },
 *      "smtp": { "host": "127.0.0.1", "port": 3465, "secure": true } }]
 *
 * The servers use self-signed certificates, which the clients here accept;
 * everything else is the production provider and engine. Each run works in a
 * folder of its own, so a long-lived server can be reused.
 */

import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailAdapterOverrides } from '../../mail/registry.js';
import { createMailAdapter } from '../../mail/registry.js';
import { syncWithAdapter } from '../manager.js';
import type { ConnectorBindingRef } from '../types.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from './harness.js';
import { buildMime } from './mime.js';

interface Endpoint {
  host: string;
  port: number;
  secure: boolean;
}

interface LiveMailServer {
  name: string;
  address: string;
  user: string;
  pass: string;
  imap: Endpoint;
  smtp?: Endpoint;
}

const LIVE = process.env.GEZEL_CONNECTOR_LIVE_LOCAL === '1';
const servers: LiveMailServer[] = LIVE ? JSON.parse(process.env.GEZEL_LIVE_MAIL ?? '[]') : [];

const trusting: MailAdapterOverrides = {
  imap: {
    createClient: (options) =>
      new ImapFlow({ ...options, tls: { rejectUnauthorized: false } }) as never,
    createTransport: (options) =>
      nodemailer.createTransport({ ...options, tls: { rejectUnauthorized: false } }) as never,
  },
};

function client(server: LiveMailServer): ImapFlow {
  return new ImapFlow({
    host: server.imap.host,
    port: server.imap.port,
    secure: server.imap.secure,
    ...(server.imap.secure ? {} : { doSTARTTLS: true }),
    auth: { user: server.user, pass: server.pass },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
}

describe.runIf(LIVE)('mail against real local servers', () => {
  it('has servers to check', () => {
    expect(servers.length, 'set GEZEL_LIVE_MAIL').toBeGreaterThan(0);
  });

  let env: ConnectorTestEnv | null = null;
  afterEach(async () => {
    await env?.dispose();
    env = null;
  });

  for (const server of servers) {
    it(`${server.name}: backfills, resumes quietly, picks up what arrives`, async () => {
      env = await createConnectorTestEnv();
      const folder = `gezel-${randomUUID().slice(0, 8)}`;
      const yesterday = new Date(Date.now() - 24 * 60 * 60_000);
      const seed = client(server);
      await seed.connect();
      await seed.mailboxCreate(folder);
      const append = (msg: Parameters<typeof buildMime>[0]) =>
        seed.append(folder, buildMime({ date: yesterday.toISOString(), ...msg }), [], yesterday);
      await append({ subject: 'Plain note', text: 'The plain one.' });
      await append({
        subject: 'Only HTML',
        html: '<p>Only <b>HTML</b> here, <a href="https://example.test/x">a link</a>.</p>',
      });
      await append({
        subject: 'Re: Plain note',
        text: 'Agreed, ship it.\n\nOn Mon, Alice wrote:\n> The plain one.\n',
      });

      const binding: ConnectorBindingRef = {
        id: `mail-imap:${server.name}`,
        type: 'mail-imap',
        config: { address: server.address, syncFolders: [folder], backfillDays: 14 },
      };
      await env.storeCredential(binding, {
        host: server.imap.host,
        port: server.imap.port,
        secure: server.imap.secure,
        user: server.user,
        pass: server.pass,
        ...(server.smtp ? { smtp: server.smtp } : {}),
      });
      const pass = async (cursor: unknown) =>
        syncWithAdapter(await createMailAdapter(binding, env!.deps(), 'imap', trusting), {
          storageDir: env!.artifactsDir,
          quarantineDir: env!.quarantineDir,
          corpusDir: 'data/mail',
          backfillLimit: 50,
          cursor,
        });

      const first = await pass(undefined);
      expect(first.error).toBeUndefined();
      expect(first.written).toBe(3);
      const corpus = await assertCorpusInvariants(env.artifactsDir, 'data/mail');
      const bySubject = new Map(corpus.map((r) => [r.frontmatter.subject, r]));
      expect(bySubject.get('Only HTML')?.body).toContain('**HTML**');
      expect(bySubject.get('Re: Plain note')?.body).toContain('Agreed, ship it.');

      const quiet = await pass(first.cursor);
      expect(quiet.error).toBeUndefined();
      expect(quiet.written).toBe(0);

      await append({ subject: 'Late arrival', text: 'Arrived after the first sync.' });
      const third = await pass(quiet.cursor);
      expect(third.written).toBe(1);
      expect(
        (await readCorpus(env.artifactsDir, 'data/mail')).map((r) => r.frontmatter.subject),
      ).toContain('Late arrival');
      await seed.mailboxDelete(folder).catch(() => {});
      await seed.logout();
    }, 120_000);

    if (server.smtp) {
      it(`${server.name}: sends through SMTP, and the message arrives`, async () => {
        env = await createConnectorTestEnv();
        const binding: ConnectorBindingRef = {
          id: `mail-imap:${server.name}-send`,
          type: 'mail-imap',
          config: { address: server.address, syncFolders: ['INBOX'] },
        };
        await env.storeCredential(binding, {
          host: server.imap.host,
          port: server.imap.port,
          secure: server.imap.secure,
          user: server.user,
          pass: server.pass,
          smtp: server.smtp,
        });
        const adapter = await createMailAdapter(binding, env.deps(), 'imap', trusting);
        await adapter.ensureAuth();
        const subject = `Sent by the live lane ${randomUUID().slice(0, 8)}`;
        await adapter.runAction('send', {
          to: [server.address],
          subject,
          bodyMarkdown: 'Sent through the real SMTP path.',
        });
        await adapter.close();
        const reader = client(server);
        await reader.connect();
        let found = false;
        for (let i = 0; i < 20 && !found; i++) {
          const lock = await reader.getMailboxLock('INBOX');
          try {
            found = ((await reader.search({ subject })) || []).length > 0;
          } finally {
            lock.release();
          }
          if (!found) await new Promise((r) => setTimeout(r, 500));
        }
        await reader.logout();
        expect(found, 'the sent message reached the mailbox').toBe(true);
      }, 60_000);
    }
  }
});
