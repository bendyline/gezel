import addressparser from 'nodemailer/lib/addressparser/index.js';
import { describe, expect, it } from 'vitest';
import { recipientAllowedBy } from '../connectors/consent.js';
import { MailConnectorAdapter } from './adapter.js';
import { buildRawMime } from './compose.js';
import { canonicalRecipients, parseRecipient } from './recipient.js';
import type { MailProvider, OutgoingMail } from './types.js';

const allowlist = { allowedRecipients: ['ok@trusted.com'], allowedDomains: ['team.example'] };

describe('parseRecipient', () => {
  it.each([
    ['ok@trusted.com', 'ok@trusted.com'],
    ['Ok Person <ok@trusted.com>', 'ok@trusted.com'],
    ['"Person, Ok" <ok@trusted.com>', 'ok@trusted.com'],
    ['(comment) ok@trusted.com', 'ok@trusted.com'],
    ['=?utf-8?Q?attacker=40evil.com?= <ok@trusted.com>', 'ok@trusted.com'],
    ['OK@Trusted.COM', 'OK@Trusted.COM'],
    ['first.last+tag@sub.team.example', 'first.last+tag@sub.team.example'],
  ])('reads %j as exactly %j', (entry, address) => {
    expect(parseRecipient(entry)).toEqual({ ok: true, address });
  });

  it.each([
    // The released bypass: the first <…> is inside a quoted display name,
    // and nodemailer delivers to the address after it.
    ['"<ok@trusted.com>" <attacker@evil.com>'],
    ['"ok@trusted.com" attacker@evil.com'],
    ['ok@trusted.com attacker@evil.com'],
    ['attacker@evil.com <ok@trusted.com>'],
    ['x <ok@trusted.com> <attacker@evil.com>'],
    ['ok@trusted.com (comment <attacker@evil.com>)'],
    ['<ok@trusted.com>, attacker@evil.com'],
    ['ok@trusted.com; attacker@evil.com'],
    ['a: attacker@evil.com;'],
    ['undisclosed: ;'],
    ['"a@trusted.com"@evil.com'],
    ['"weird,local"@x.com'],
    ['ok@trusted.com@evil.com'],
    ['ok@trusted.com\r\nBcc: attacker@evil.com'],
    ['<ok@trusted.com>\r\nBcc: attacker@evil.com'],
    ['ok@trusted.com\u0000attacker@evil.com'],
    ['=?utf-8?B?PGF0dGFja2VyQGV2aWwuY29tPg==?='],
    ['ok@trusted.com.'],
    ['ok@localhost'],
    ['ok@[127.0.0.1]'],
    ['noatsign'],
    [''],
    ['   '],
  ])('refuses %j', (entry) => {
    expect(parseRecipient(entry).ok).toBe(false);
  });

  it('refuses non-string entries', () => {
    expect(parseRecipient({ address: 'ok@trusted.com' }).ok).toBe(false);
    expect(parseRecipient(['ok@trusted.com']).ok).toBe(false);
    expect(parseRecipient(null).ok).toBe(false);
  });

  it('returns addresses that re-parse to themselves at the transport', () => {
    for (const entry of ['Ok Person <ok@trusted.com>', 'first.last+tag@sub.team.example']) {
      const parsed = parseRecipient(entry);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(addressparser(parsed.address, { flatten: true })).toEqual([
        { name: '', address: parsed.address },
      ]);
    }
  });
});

describe('recipientAllowedBy', () => {
  it('checks the address nodemailer would deliver to', () => {
    expect(recipientAllowedBy('"<ok@trusted.com>" <attacker@evil.com>', allowlist)).toBe(false);
    expect(recipientAllowedBy('"a@team.example"@evil.com', allowlist)).toBe(false);
    expect(recipientAllowedBy('Ok <OK@trusted.com>', allowlist)).toBe(true);
    expect(recipientAllowedBy('someone@team.example', allowlist)).toBe(true);
    expect(recipientAllowedBy('someone@sub.team.example', allowlist)).toBe(false);
  });
});

describe('mail send paths', () => {
  function capturingAdapter() {
    const sent: OutgoingMail[] = [];
    const provider = {
      kind: 'imap',
      send: async (_from: string, mail: OutgoingMail) => {
        sent.push(mail);
        return { messageId: 'm-1' };
      },
    } as unknown as MailProvider;
    const adapter = new MailConnectorAdapter(provider, [], 'acct', { address: 'me@trusted.com' });
    return { adapter, sent };
  }

  it('hands the provider the bare addresses, never the raw entries', async () => {
    const { adapter, sent } = capturingAdapter();
    await adapter.runAction('send', {
      to: ['Ok Person <ok@trusted.com>'],
      cc: 'Team <someone@team.example>',
      bcc: [],
      subject: 's',
      body: 'b',
    });
    expect(sent[0]).toMatchObject({ to: ['ok@trusted.com'], cc: ['someone@team.example'] });
    expect(sent[0]?.bcc).toBeUndefined();
  });

  it('refuses a send whose recipients are not each one plain address', async () => {
    const { adapter, sent } = capturingAdapter();
    await expect(
      adapter.runAction('send', { to: ['"<ok@trusted.com>" <attacker@evil.com>'], body: 'b' }),
    ).rejects.toThrow(/invalid recipient/);
    await expect(
      adapter.runAction('send', { to: ['ok@trusted.com'], bcc: ['a@x.com, b@y.com'], body: 'b' }),
    ).rejects.toThrow(/invalid recipient/);
    expect(sent).toHaveLength(0);
  });

  it('keeps the raw MIME headers to the checked recipients (Gmail path)', () => {
    const raw = buildRawMime('Me\r\nBcc: a1@evil.com <me@trusted.com>', {
      to: ['ok@trusted.com'],
      subject: 'Hi\r\nBcc: attacker@evil.com',
      bodyMarkdown: 'body',
      inReplyTo: '<x@y>\r\nBcc: a2@evil.com',
      references: ['<a@b>\nCc: a3@evil.com'],
    }).toString('utf8');
    const headerLines = raw.split('\r\n\r\n')[0]!.split('\r\n');
    expect(headerLines.filter((l) => /^(to|cc|bcc):/i.test(l))).toEqual(['To: ok@trusted.com']);
    expect(headerLines).toContain('Subject: Hi Bcc: attacker@evil.com');
    expect(() =>
      buildRawMime('me@trusted.com', {
        to: ['"<ok@trusted.com>" <attacker@evil.com>'],
        subject: 's',
        bodyMarkdown: 'b',
      }),
    ).toThrow(/invalid recipient/);
  });

  it('canonicalRecipients names the offending entry', () => {
    expect(() => canonicalRecipients(['ok@trusted.com', 'a: b@x.com;'])).toThrow(
      /invalid recipient "a: b@x.com;": address groups are not allowed/,
    );
  });
});
